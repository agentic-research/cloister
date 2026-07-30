/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { McpEdgeRoute } from "../src/routes/mcp.js";
import { JsonRpcInvocationError, type ToolBackend } from "../src/backends.js";
import type { Env, JsonRpcResponse, McpTool } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const tool = (name: string): McpTool => ({
  name,
  description: `${name} (test)`,
  inputSchema: { type: "object", properties: {}, required: [] },
});

class FakeBackend implements ToolBackend {
  invocations: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    private prefix: string,
    private toolDefs: McpTool[],
    private behavior: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown
      = async () => ({ ok: true }),
  ) {}
  tools()                          { return this.toolDefs; }
  handles(name: string)            { return name.startsWith(this.prefix); }
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.invocations.push({ name, args });
    return await this.behavior(name, args);
  }
}

function fakeEnv(): Env { return { CLOISTER_MODE: "dev" } as Env; }  // ADR-0053: explicit dev opt-out (gate off)

async function postMcp(route: McpEdgeRoute, body: unknown): Promise<JsonRpcResponse> {
  const res = await route.handle(
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    fakeEnv(),
  );
  return (await res.json()) as JsonRpcResponse;
}

// ── EdgeRoute contract ─────────────────────────────────────────────────────

describe("McpEdgeRoute.match", () => {
  it("matches /mcp exactly", () => {
    const r = new McpEdgeRoute([]);
    expect(r.match(new Request("http://x/mcp"))).toBe(true);
    expect(r.match(new Request("http://x/mcp?q=1"))).toBe(true);
  });

  it("does not match /mcp/foo or other paths", () => {
    const r = new McpEdgeRoute([]);
    expect(r.match(new Request("http://x/mcp/foo"))).toBe(false);
    expect(r.match(new Request("http://x/health"))).toBe(false);
    expect(r.match(new Request("http://x/"))).toBe(false);
  });
});

// ── tools/list aggregation ────────────────────────────────────────────────

describe("McpEdgeRoute tools/list aggregation", () => {
  it("returns union of tools across all backends in declaration order", async () => {
    const a = new FakeBackend("a_", [tool("a_one"), tool("a_two")]);
    const b = new FakeBackend("b_", [tool("b_one")]);
    const route = new McpEdgeRoute([a, b]);
    const res = await postMcp(route, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    const names = ((res.result as { tools: McpTool[] }).tools).map(t => t.name);
    expect(names).toEqual(["a_one", "a_two", "b_one"]);
  });

  it("returns empty list when no backends are registered", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postMcp(route, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect((res.result as { tools: McpTool[] }).tools).toEqual([]);
  });

  it("rejects construction when two backends advertise the same tool name", () => {
    const a = new FakeBackend("a_", [tool("dup")]);
    const b = new FakeBackend("b_", [tool("dup")]);
    expect(() => new McpEdgeRoute([a, b])).toThrow(/duplicate tool name/i);
  });
});

// ── tools/call dispatch ───────────────────────────────────────────────────

describe("McpEdgeRoute tools/call dispatch", () => {
  it("routes to the first backend whose handles(name) is true", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => ({ from: "a" }));
    const b = new FakeBackend("b_", [tool("b_x")], async () => ({ from: "b" }));
    const route = new McpEdgeRoute([a, b]);

    await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "b_x", arguments: { k: 1 } }, id: 7,
    });
    expect(a.invocations).toEqual([]);
    expect(b.invocations).toEqual([{ name: "b_x", args: { k: 1 } }]);
  });

  it("wraps backend result as MCP content text", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => ({ count: 42 }));
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "a_x", arguments: {} }, id: 1,
    });
    const result = res.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ count: 42 });
  });

  it("returns -32601 for an unknown tool name", async () => {
    const a = new FakeBackend("a_", [tool("a_x")]);
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "z_unknown", arguments: {} }, id: 9,
    });
    expect(res.error?.code).toBe(-32601);
  });

  it("maps JsonRpcInvocationError to a structured JSON-RPC error", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => {
      throw new JsonRpcInvocationError(-32602, "bad arg");
    });
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "a_x", arguments: {} }, id: 3,
    });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toBe("bad arg");
  });

  it("maps unexpected throws to -32603 internal error", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => { throw new Error("boom"); });
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "a_x", arguments: {} }, id: 4,
    });
    expect(res.error?.code).toBe(-32603);
  });
});

// ── HTTP method gating ─────────────────────────────────────────────────────

describe("McpEdgeRoute HTTP methods", () => {
  it("DELETE /mcp returns 405", async () => {
    const route = new McpEdgeRoute([]);
    const res = await route.handle(
      new Request("http://x/mcp", { method: "DELETE" }),
      fakeEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("GET /mcp returns SSE stream with init notification", async () => {
    const route = new McpEdgeRoute([]);
    const res = await route.handle(new Request("http://x/mcp"), fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain("protocolVersion");
    reader.cancel();
  });

  it("GET /mcp echoes the request Origin in Access-Control-Allow-Origin (default)", async () => {
    const route = new McpEdgeRoute([]);
    const res = await route.handle(
      new Request("http://x/mcp", { headers: { Origin: "https://app.example.com" } }),
      fakeEnv(),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    res.body?.cancel();
  });

  it("GET /mcp returns 'null' ACAO for an Origin not in ALLOWED_ORIGINS", async () => {
    const route = new McpEdgeRoute([]);
    const res = await route.handle(
      new Request("http://x/mcp", { headers: { Origin: "https://evil.example" } }),
      { ALLOWED_ORIGINS: "https://app.example.com" } as unknown as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("null");
    res.body?.cancel();
  });
});

// ── Sessionless protocol surface (ADR-0015 Phase 2 / SEP-2575) ────────────
//
// Cloister supports two MCP protocol versions side-by-side. The
// `MCP-Protocol-Version` HTTP header selects sessionless mode on a
// per-request basis. These tests lock the sessionless surface in:
//
// - legacy clients still get `initialize` / `tools/list` etc.
// - sessionless clients get `server/discover` + `subscriptions/listen`
// - cross-mode method calls are rejected with -32601
// - version mismatches return HTTP-400 UnsupportedProtocolVersionError
// - header/payload protocolVersion disagreement returns HTTP-400

async function postSessionless(
  route: McpEdgeRoute,
  body: unknown,
  protocolVersion: string,
): Promise<{ res: Response; body: JsonRpcResponse }> {
  const res = await route.handle(
    new Request("http://x/mcp", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "MCP-Protocol-Version": protocolVersion,
      },
      body: JSON.stringify(body),
    }),
    fakeEnv(),
  );
  return { res, body: (await res.json()) as JsonRpcResponse };
}

describe("McpEdgeRoute sessionless protocol (Phase 2)", () => {
  const NEXT = "2026-07-28";  // the released revision (was the 2026-XX-XX placeholder)

  it("server/discover returns supportedVersions + capabilities + serverInfo", async () => {
    const route = new McpEdgeRoute([]);
    const { body } = await postSessionless(
      route,
      { jsonrpc: "2.0", id: 1, method: "server/discover" },
      NEXT,
    );
    const result = body.result as {
      protocolVersion:   string;
      supportedVersions: string[];
      capabilities:      Record<string, unknown>;
      serverInfo:        { name: string };
    };
    expect(result.protocolVersion).toBe(NEXT);
    expect(result.supportedVersions).toContain(NEXT);
    expect(result.supportedVersions).toContain("2024-11-05");
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.serverInfo.name).toBe("cloister");
  });

  it("server/discover without MCP-Protocol-Version header returns -32601", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postMcp(route, { jsonrpc: "2.0", id: 2, method: "server/discover" });
    expect(res.error?.code).toBe(-32601);
  });

  it("initialize via sessionless header returns -32601 (SEP-2575 removed initialize)", async () => {
    const route = new McpEdgeRoute([]);
    const { body } = await postSessionless(
      route,
      { jsonrpc: "2.0", id: 3, method: "initialize" },
      NEXT,
    );
    expect(body.error?.code).toBe(-32601);
  });

  it("subscriptions/listen returns stub acknowledgment", async () => {
    const route = new McpEdgeRoute([]);
    const { body } = await postSessionless(
      route,
      {
        jsonrpc: "2.0", id: 4, method: "subscriptions/listen",
        params: { subscriptions: ["tools/list_changed"] },
      },
      NEXT,
    );
    const result = body.result as { acknowledged: boolean; subscriptions: unknown };
    expect(result.acknowledged).toBe(true);
    expect(result.subscriptions).toEqual(["tools/list_changed"]);
  });

  it("subscriptions/listen without MCP-Protocol-Version header returns -32601", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postMcp(route, { jsonrpc: "2.0", id: 5, method: "subscriptions/listen" });
    expect(res.error?.code).toBe(-32601);
  });

  it("unsupported protocol version returns HTTP-400 UnsupportedProtocolVersionError", async () => {
    const route = new McpEdgeRoute([]);
    const { res, body } = await postSessionless(
      route,
      { jsonrpc: "2.0", id: 6, method: "ping" },
      "1999-01-01", // not in supportedVersions
    );
    expect(res.status).toBe(400);
    expect(body.error?.message).toBe("UnsupportedProtocolVersionError");
    const data = body.error?.data as { supported: string[]; requested: string };
    expect(data.requested).toBe("1999-01-01");
    expect(data.supported).toContain(NEXT);
  });

  it("_meta protocolVersion mismatch returns HTTP-400", async () => {
    const route = new McpEdgeRoute([]);
    const { res, body } = await postSessionless(
      route,
      {
        jsonrpc: "2.0", id: 7, method: "ping",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2024-11-05" } },
      },
      NEXT,
    );
    expect(res.status).toBe(400);
    expect(body.error?.message).toContain("protocol version mismatch");
  });

  it("tools/list is shared across legacy and sessionless paths", async () => {
    const a = new FakeBackend("a_", [tool("a_one")]);
    const route = new McpEdgeRoute([a]);

    const { body: sessionlessBody } = await postSessionless(
      route,
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      NEXT,
    );
    const legacyBody = await postMcp(route, { jsonrpc: "2.0", id: 9, method: "tools/list" });

    const sessionlessNames = (sessionlessBody.result as { tools: McpTool[] }).tools.map(t => t.name);
    const legacyNames      = (legacyBody.result as { tools: McpTool[] }).tools.map(t => t.name);
    expect(sessionlessNames).toEqual(legacyNames);
    expect(sessionlessNames).toContain("a_one");
  });

  it("supportedProtocolVersions in constructor overrides the runtime default", async () => {
    const route = new McpEdgeRoute([], ["custom-version-1", "custom-version-2"]);
    const { body } = await postSessionless(
      route,
      { jsonrpc: "2.0", id: 10, method: "server/discover" },
      "custom-version-1",
    );
    const result = body.result as { supportedVersions: string[] };
    expect(result.supportedVersions).toEqual(["custom-version-1", "custom-version-2"]);
  });
});

// ── Mcp-Method / Mcp-Name header agreement (SEP-2243 / cloister-da49a6) ────
//
// MCP 2026-07-28 requires these headers on Streamable HTTP POST so
// intermediaries can route without parsing bodies. Cloister's TRUST decisions
// derive from the signed body (`canonicalRequestBytes` covers method+url+ts+
// nonce+body — the headers are NOT signed), so the headers are ADVISORY here:
// if present they MUST agree with the body, and disagreement is rejected with
// HeaderMismatchError (-32020) BEFORE the lease gate does any work. A request
// routed as one method and scope-checked as another is the seam this closes.
describe("Mcp-Method / Mcp-Name header agreement", () => {
  function postWithHeaders(
    route: McpEdgeRoute,
    body: unknown,
    extra: Record<string, string>,
    env: Env = fakeEnv(),
  ): Promise<Response> {
    return route.handle(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extra },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  const rpc = (method: string, params?: unknown) =>
    ({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) });

  it("Mcp-Method disagreeing with the body is rejected -32020 (HTTP 400)", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postWithHeaders(route, rpc("tools/call", { name: "bead_list", arguments: {} }), {
      "Mcp-Method": "tools/list",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32020);
    expect(body.error?.message).toContain("HeaderMismatch");
  });

  it("Mcp-Name disagreeing with params.name on tools/call is rejected -32020", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postWithHeaders(route, rpc("tools/call", { name: "bead_list", arguments: {} }), {
      "Mcp-Method": "tools/call",
      "Mcp-Name":   "bead_close",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32020);
  });

  it("agreeing headers pass through to normal dispatch", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postWithHeaders(route, rpc("tools/list"), { "Mcp-Method": "tools/list" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error).toBeUndefined();
  });

  it("absent headers are tolerated (body is the signed authority)", async () => {
    // The spec obliges CLIENTS to send them; cloister's trust layer does not
    // depend on them, so absence is not an error — enforcement of a client
    // obligation would only break legacy clients for zero trust benefit.
    const route = new McpEdgeRoute([]);
    const res = await postWithHeaders(route, rpc("tools/list"), {});
    expect(res.status).toBe(200);
  });

  it("mismatch is rejected BEFORE the lease gate runs", async () => {
    // Enforcing env (authority present), no lease headers at all: if the gate
    // ran first this would be ERR_UNAUTHENTICATED (-32001). Getting -32020
    // proves the header check precedes any gate work.
    const enforcing = { INTERLACE_ROOT_PUBKEY: "ed25519:AAAA" } as unknown as Env;
    const route = new McpEdgeRoute([]);
    const res = await postWithHeaders(route, rpc("tools/list"), { "Mcp-Method": "tools/call" }, enforcing);
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32020);
  });
});


// ── server/discover gate posture (cloister-dabbe1) ─────────────────────────
//
// Posture: server/discover stays lease-gated — a DOCUMENTED deviation from
// the spec's pre-auth discovery intent (ADR-0016 private registry; threat
// model §9 anti-enumeration). What the posture requires: an unauthenticated
// discover must be denied with the SAME shape as any other unauthenticated
// call, so the method's existence and the server's capability inventory leak
// nothing. Scope grammar entries (server:discover, subscriptions:listen)
// make the method grantable to non-admin certs — the grant is tested at the
// unit level in lease-middleware.test.ts.
describe("protocol version acceptance (cloister-c8e3bd)", () => {
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const call = (version: string) =>
    new McpEdgeRoute([]).handle(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "MCP-Protocol-Version": version },
        body: JSON.stringify(rpc),
      }),
      fakeEnv(),
    );

  it("accepts the released 2026-07-28 revision", async () => {
    const res = await call("2026-07-28");
    expect(res.status).toBe(200);
  });

  it("REJECTS the retired 2026-XX-XX placeholder", async () => {
    // Was accepted while SEP-2575 was in flight, for peers that negotiated the
    // placeholder before the spec shipped. The revision has shipped, so the
    // placeholder names nothing — this asserts the inbound surface actually
    // narrowed, rather than the constant merely being deleted from a list.
    const res = await call("2026-XX-XX");
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.message).toContain("UnsupportedProtocolVersion");
  });

  it("rejects an unknown version with UnsupportedProtocolVersionError", async () => {
    const res = await call("2031-01-01");
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.message).toContain("UnsupportedProtocolVersion");
  });
});

describe("server/discover gate posture", () => {
  it("unauthenticated discover is denied with the same shape as any unauthenticated call", async () => {
    const enforcing = { INTERLACE_ROOT_PUBKEY: "ed25519:AAAA" } as unknown as Env;
    const route = new McpEdgeRoute([]);
    const call = (method: string) =>
      route.handle(
        new Request("http://x/mcp", {
          method: "POST",
          headers: {
            "Content-Type":         "application/json",
            // MUST be a supported version: with an unsupported one, BOTH
            // calls return UnsupportedProtocolVersionError before the gate
            // and the test compares two version rejections — vacuously
            // identical while proving nothing about the gate. (Caught live.)
            "MCP-Protocol-Version": "2026-07-28",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        }),
        enforcing,
      );

    const discover = await call("server/discover");
    const list     = await call("tools/list");
    const dBody = (await discover.json()) as JsonRpcResponse;
    const lBody = (await list.json()) as JsonRpcResponse;

    // Same status, same error code, same message — no method-shaped oracle.
    expect(discover.status).toBe(list.status);
    expect(dBody.error?.code).toBe(lBody.error?.code);
    expect(dBody.error?.message).toBe(lBody.error?.message);
    // And the shape compared is the GATE's deny — here -32005: authority is
    // set with no CA bundle behind it, so per ADR-0053 the gate enforces and
    // fails closed at resolveCABundle. The load-bearing property is that the
    // code comes from the lease pipeline, not a version rejection (-32600) —
    // with an unsupported version this test compares two version errors and
    // proves nothing (caught live, twice: first -32600, then expecting the
    // wrong gate code).
    expect(dBody.error?.code).toBe(-32005);
  });
});


// ── 2026-07-28 result shape + removed methods (cloister-c8e3bd) ────────────
//
// Dual-stack rule: the released revision's obligations bind the SESSIONLESS
// surface. Legacy (2025-11-25) responses stay byte-shaped as before — that
// revision has no resultType, and its clients still legitimately send ping.
describe("2026-07-28 result shape and removed methods", () => {
  const route = () => new McpEdgeRoute([]);
  const post = (body: unknown, sessionless: boolean) =>
    route().handle(
      new Request("http://x/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionless ? { "MCP-Protocol-Version": "2026-07-28" } : {}),
        },
        body: JSON.stringify(body),
      }),
      fakeEnv(),
    );
  const rpc = (method: string) => ({ jsonrpc: "2.0", id: 1, method });

  it("sessionless results carry resultType complete + _meta serverInfo", async () => {
    const res = await post(rpc("tools/list"), true);
    const body = (await res.json()) as JsonRpcResponse;
    const result = body.result as Record<string, unknown>;
    expect(result.resultType).toBe("complete");
    const meta = result._meta as Record<string, unknown>;
    expect(meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "cloister", version: "0.1.0" });
  });

  it("legacy results carry neither — that revision has no such fields", async () => {
    const res = await post(rpc("tools/list"), false);
    const body = (await res.json()) as JsonRpcResponse;
    const result = body.result as Record<string, unknown>;
    expect(result.resultType).toBeUndefined();
    expect(result._meta).toBeUndefined();
  });

  it("ping is -32601 on the sessionless surface (removed in 2026-07-28)", async () => {
    const res = await post(rpc("ping"), true);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32601);
  });

  it("ping still works for legacy clients (dual-stack, 12-month window)", async () => {
    const res = await post(rpc("ping"), false);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error).toBeUndefined();
  });

  it("error responses carry no resultType — it is a field of results only", async () => {
    const res = await post(rpc("nonexistent/method"), true);
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect((body as Record<string, unknown>).resultType).toBeUndefined();
    expect((body.error as Record<string, unknown>).resultType).toBeUndefined();
  });
});


// ── CacheableResult on tools/list (SEP-2549 / cloister-db6ac8) ─────────────
//
// ttlMs + cacheScope are REQUIRED on list results in 2026-07-28. Rules here:
// cacheScope is "private" unconditionally — the response was authorized by a
// specific cert (ADR-0016 private registry), and an upstream's "public" must
// never widen that. ttlMs merges as the MINIMUM across backends that report
// one (serving a backend's entries past their declared freshness is a
// correctness bug, not a tuning choice); no reports ⇒ 0 (always revalidate).
describe("CacheableResult on tools/list", () => {
  const post = (backends: ToolBackend[]) =>
    new McpEdgeRoute(backends).handle(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      fakeEnv(),
    );

  function stubBackend(name: string, meta?: { ttlMs?: number; cacheScope?: "public" | "private" }): ToolBackend {
    return {
      handles: (t: string) => t === name,
      tools:   () => [{ name, description: name, inputSchemaJson: '{"type":"object"}' }],
      invoke:  async () => ({ content: [] }),
      ...(meta ? { cacheMeta: () => meta } : {}),
    } as unknown as ToolBackend;
  }

  it("sessionless tools/list carries ttlMs + cacheScope private", async () => {
    const res = await post([stubBackend("a_tool")]);
    const body = (await res.json()) as JsonRpcResponse;
    const result = body.result as Record<string, unknown>;
    expect(result.cacheScope).toBe("private");
    expect(typeof result.ttlMs).toBe("number");
  });

  it("ttlMs merges as the MINIMUM across reporting backends", async () => {
    const res = await post([
      stubBackend("a_tool", { ttlMs: 60000, cacheScope: "private" }),
      stubBackend("b_tool", { ttlMs: 5000,  cacheScope: "private" }),
      stubBackend("c_tool"), // silent backend must not veto the merge
    ]);
    const result = ((await res.json()) as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ttlMs).toBe(5000);
  });

  it("an upstream declaring public cannot widen the merged scope", async () => {
    const res = await post([stubBackend("a_tool", { ttlMs: 60000, cacheScope: "public" })]);
    const result = ((await res.json()) as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.cacheScope).toBe("private");
  });

  it("no backend reporting ⇒ ttlMs 0 (always revalidate)", async () => {
    const res = await post([stubBackend("a_tool")]);
    const result = ((await res.json()) as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ttlMs).toBe(0);
  });

  it("tools/list ordering is deterministic — sorted by name (SEP minor-3)", async () => {
    const res = await post([stubBackend("zeta_tool"), stubBackend("alpha_tool")]);
    const result = ((await res.json()) as JsonRpcResponse).result as { tools: Array<{ name: string }> };
    expect(result.tools.map(t => t.name)).toEqual(["alpha_tool", "zeta_tool"]);
  });

  it("legacy tools/list stays byte-shaped — no cache fields", async () => {
    const res = await new McpEdgeRoute([stubBackend("a_tool")]).handle(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      fakeEnv(),
    );
    const result = ((await res.json()) as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ttlMs).toBeUndefined();
    expect(result.cacheScope).toBeUndefined();
  });
});
