/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Tests for McpProxyToolBackend's dynamic tools/list path (ADR-0006).
 *
 * Scope:
 *   - Static behavior unchanged when dynamicTools is falsy
 *   - Derived catalog populated from upstream tools/list, names re-prefixed
 *   - TTL cache: second call within window does not re-fetch
 *   - Concurrent first-fetches share an in-flight Promise (no thundering herd)
 *   - Asserted overrides Derived on name collision
 *   - stripPrefix removes prefix from tool name on tools/call forward
 *   - Upstream failure leaves Asserted catalog as fallback
 *   - Runtime validation rejects dynamicTools + empty handlesPrefix
 */
import { describe, it, expect } from "vitest";
import { McpProxyToolBackend } from "../../src/manifest/backends/mcp-proxy.js";
import { instantiate } from "../../src/manifest/runtime.js";
import type { Env } from "../../src/types.js";
import type { Gateway, HttpForwardBackend } from "../../src/manifest/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function envWith(url: string): Env {
  return { MACHE_MCP_URL: url } as unknown as Env;
}

const TOOLS_LIST_RESULT = {
  tools: [
    {
      name:        "get_overview",
      description: "structural overview",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
    },
    {
      name:        "find_callers",
      description: "find symbol callers",
      inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: body }), {
    status:  200,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockFetcher {
  fetcher: typeof fetch;
  calls:   Array<{ url: string; method: string; body: unknown }>;
}

function mockFetch(respond: (method: string, body: unknown) => Response | Promise<Response>): MockFetcher {
  const calls: MockFetcher["calls"] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    return await respond(method, body);
  };
  return { fetcher, calls };
}

// ── Static behavior unchanged ─────────────────────────────────────────────

describe("McpProxyToolBackend — static (dynamicTools=false)", () => {
  it("does not fetch tools/list and returns only the Asserted catalog", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL",
      tools: [
        { name: "lsp_hover", description: "h", inputSchemaJson: '{"type":"object"}' },
      ],
    };
    const { fetcher, calls } = mockFetch(() => jsonResponse(TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "lsp_", fetcher);

    await b.refreshTools(envWith("http://stub/")); // should be a no-op
    expect(calls.length).toBe(0);

    const tools = b.tools();
    expect(tools.map(t => t.name)).toEqual(["lsp_hover"]);
  });
});

// ── Derived catalog ───────────────────────────────────────────────────────

describe("McpProxyToolBackend — dynamic (dynamicTools=true)", () => {
  it("fetches tools/list and re-prefixes names with handlesPrefix", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL",
      tools: [],
      dynamicTools: true,
      stripPrefix:  "mache_",
    };
    const { fetcher, calls } = mockFetch(() => jsonResponse(TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    expect(b.tools()).toEqual([]); // empty before refresh

    await b.refreshTools(envWith("http://mache.stub/mcp"));
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("POST");
    expect((calls[0]!.body as { method: string }).method).toBe("tools/list");

    const tools = b.tools();
    expect(tools.map(t => t.name).sort()).toEqual(["mache_find_callers", "mache_get_overview"]);
    const overview = tools.find(t => t.name === "mache_get_overview")!;
    expect(overview.description).toBe("structural overview");
    expect(overview.inputSchema.required).toEqual(["repo"]);
  });

  it("caches the result for the TTL window — second call does not refetch", async () => {
    let callCount = 0;
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
    };
    const fetcher: typeof fetch = async () => {
      callCount++;
      return jsonResponse(TOOLS_LIST_RESULT);
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    await b.refreshTools(envWith("http://mache.stub/"));
    await b.refreshTools(envWith("http://mache.stub/"));
    await b.refreshTools(envWith("http://mache.stub/"));

    expect(callCount).toBe(1);
  });

  it("concurrent first-fetches share an in-flight Promise (no thundering herd)", async () => {
    let callCount = 0;
    let resolveResp: ((r: Response) => void) | null = null;
    const respPromise = new Promise<Response>(r => { resolveResp = r; });

    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
    };
    const fetcher: typeof fetch = async () => {
      callCount++;
      return await respPromise;
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    // Kick off three concurrent refreshes before the first one resolves.
    const r1 = b.refreshTools(envWith("http://x/"));
    const r2 = b.refreshTools(envWith("http://x/"));
    const r3 = b.refreshTools(envWith("http://x/"));

    // Resolve the underlying fetch.
    resolveResp!(jsonResponse(TOOLS_LIST_RESULT));
    await Promise.all([r1, r2, r3]);

    expect(callCount).toBe(1);
    expect(b.tools().length).toBe(2);
  });

  it("Asserted overrides Derived on name collision", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL",
      tools: [
        // Asserted entry shadowing what upstream would return as get_overview.
        {
          name:            "mache_get_overview",
          description:     "asserted override",
          inputSchemaJson: '{"type":"object","properties":{"pinned":{"type":"boolean"}}}',
        },
      ],
      dynamicTools: true,
      stripPrefix:  "mache_",
    };
    const { fetcher } = mockFetch(() => jsonResponse(TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    await b.refreshTools(envWith("http://x/"));
    const overview = b.tools().find(t => t.name === "mache_get_overview")!;
    // Asserted description should win over the Derived "structural overview".
    expect(overview.description).toBe("asserted override");
    expect((overview.inputSchema.properties as Record<string, unknown>).pinned).toBeDefined();
  });

  it("upstream failure leaves Asserted catalog as fallback (no exception thrown)", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL",
      tools: [
        { name: "mache_pinned", description: "asserted-only", inputSchemaJson: '{"type":"object"}' },
      ],
      dynamicTools: true,
      stripPrefix:  "mache_",
    };
    const fetcher: typeof fetch = async () => new Response("bad gateway", { status: 502 });
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    // Should not throw; cache stays empty, Asserted fallback wins.
    await expect(b.refreshTools(envWith("http://x/"))).resolves.toBeUndefined();
    expect(b.tools().map(t => t.name)).toEqual(["mache_pinned"]);
  });

  it("strips the configured prefix before forwarding tools/call", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
    };
    const { fetcher, calls } = mockFetch((_method, body) => {
      const req = body as { method: string };
      if (req.method === "tools/list") return jsonResponse(TOOLS_LIST_RESULT);
      // tools/call: assert the wire name is bare and respond with a stub result.
      const params = (body as { params: { name: string; arguments: unknown } }).params;
      return jsonResponse({
        content: [{ type: "text", text: JSON.stringify({ wireName: params.name, args: params.arguments }) }],
      });
    });
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    const result = await b.invoke("mache_get_overview", { repo: "x" }, envWith("http://stub/"));
    const callBody = calls.find(c => (c.body as { method: string }).method === "tools/call")!;
    expect(((callBody.body as { params: { name: string } }).params.name)).toBe("get_overview");
    expect(result).toEqual({ wireName: "get_overview", args: { repo: "x" } });
  });

  it("handles() returns true for prefixed names even before refreshTools runs", () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
    };
    const b = new McpProxyToolBackend(spec, "mache_", (() => { throw new Error("nope"); }) as unknown as typeof fetch);
    expect(b.handles("mache_get_overview")).toBe(true);
    expect(b.handles("rsry_status")).toBe(false);
  });
});

// ── MCP Streamable HTTP session-id handshake ─────────────────────────────

describe("McpProxyToolBackend — requiresSession", () => {
  function sessionResponseWithId(id: string, body: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: body }), {
      status:  200,
      headers: {
        "Content-Type":   "application/json",
        "Mcp-Session-Id": id,
      },
    });
  }

  it("performs initialize handshake on first contact and sends Mcp-Session-Id afterward", async () => {
    const SID = "mcp-session-test-abc";
    const calls: Array<{ method: string; sessionHeader: string | null }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const sessionHeader = (init?.headers as Record<string, string> | undefined)?.["Mcp-Session-Id"] ?? null;
      const method = body?.method ?? "?";
      calls.push({ method, sessionHeader });

      if (method === "initialize") {
        return sessionResponseWithId(SID, { protocolVersion: "2024-11-05", capabilities: {} });
      }
      if (method === "tools/list") return jsonResponse(TOOLS_LIST_RESULT);
      return jsonResponse({ content: [{ type: "text", text: "{}" }] });
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: true,
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    await b.refreshTools(envWith("http://stub/mcp"));

    // initialize first (no session header), then tools/list (with session header).
    const initCall = calls.find(c => c.method === "initialize");
    const listCall = calls.find(c => c.method === "tools/list");
    expect(initCall?.sessionHeader).toBeNull();
    expect(listCall?.sessionHeader).toBe(SID);

    // Subsequent invoke should reuse the same session, no second initialize.
    const beforeCount = calls.filter(c => c.method === "initialize").length;
    await b.invoke("mache_get_overview", { repo: "x" }, envWith("http://stub/mcp"));
    const afterCount = calls.filter(c => c.method === "initialize").length;
    expect(afterCount).toBe(beforeCount);

    const callCall = calls.find(c => c.method === "tools/call");
    expect(callCall?.sessionHeader).toBe(SID);
  });

  it("resets session and retries once on 4xx invalid-session response", async () => {
    let initializeCount = 0;
    let toolsCallCount  = 0;
    const SID_OLD = "mcp-session-old";
    const SID_NEW = "mcp-session-new";
    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const method = body?.method ?? "?";
      const sessionHeader = (init?.headers as Record<string, string> | undefined)?.["Mcp-Session-Id"] ?? null;

      if (method === "initialize") {
        initializeCount++;
        return sessionResponseWithId(initializeCount === 1 ? SID_OLD : SID_NEW, {});
      }
      if (method === "tools/call") {
        toolsCallCount++;
        // First call (with old session) ⇒ 400 invalid; second (with new) ⇒ ok.
        if (sessionHeader === SID_OLD) {
          return new Response("invalid session", { status: 400 });
        }
        return jsonResponse({ content: [{ type: "text", text: '{"ok":true}' }] });
      }
      return jsonResponse({});
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    false,
      stripPrefix:     "",
      requiresSession: true,
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    const result = await b.invoke("mache_x", {}, envWith("http://stub/mcp"));
    expect(result).toEqual({ ok: true });
    expect(initializeCount).toBe(2);  // old session + reset → new session
    expect(toolsCallCount).toBe(2);   // failed call + retry
  });

  it("requiresSession=false performs no initialize and sends no session header", async () => {
    const calls: Array<{ method: string; hasSessionHeader: boolean }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      calls.push({
        method:           body?.method ?? "?",
        hasSessionHeader: "Mcp-Session-Id" in headers,
      });
      return jsonResponse(TOOLS_LIST_RESULT);
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: false,
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    await b.refreshTools(envWith("http://stub/mcp"));
    expect(calls.find(c => c.method === "initialize")).toBeUndefined();
    expect(calls.every(c => !c.hasSessionHeader)).toBe(true);
  });

  it("concurrent first-calls share one initialize round-trip", async () => {
    const SID = "mcp-session-shared";
    let initializeCount = 0;
    let resolveInit: ((r: Response) => void) | null = null;
    const initPromise = new Promise<Response>(r => { resolveInit = r; });

    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const method = body?.method ?? "?";
      if (method === "initialize") {
        initializeCount++;
        return await initPromise;
      }
      return jsonResponse(TOOLS_LIST_RESULT);
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: true,
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    const r1 = b.refreshTools(envWith("http://stub/mcp"));
    const r2 = b.refreshTools(envWith("http://stub/mcp"));

    resolveInit!(sessionResponseWithId(SID, {}));
    await Promise.all([r1, r2]);

    expect(initializeCount).toBe(1);
  });
});

// ── Runtime validation ────────────────────────────────────────────────────

describe("manifest runtime: dynamicTools validation", () => {
  it("rejects dynamicTools=true with empty handlesPrefix", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      actor:    { fingerprint: "", algorithm: "ed25519", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
      policy:   { maxCertLifetimeSeconds: 300, requireInterlock: false, minAlgorithm: "ed25519" },
      supportedProtocolVersions: [],
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "x", handlesPrefix: "", kind: { mcpProxy: {
            urlBinding: "U", tools: [], dynamicTools: true, stripPrefix: "",
          } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/dynamicTools=true.*empty handlesPrefix|ADR-0006/);
  });

  it("accepts dynamicTools=true with non-empty prefix and empty Asserted tools", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      actor:    { fingerprint: "", algorithm: "ed25519", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
      policy:   { maxCertLifetimeSeconds: 300, requireInterlock: false, minAlgorithm: "ed25519" },
      supportedProtocolVersions: [],
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "mache", handlesPrefix: "mache_", kind: { mcpProxy: {
            urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
          } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });
});

// ── Sessionless client path (ADR-0015 Phase 2 / SEP-2575) ─────────────────
//
// These complement the fixture-based compliance tests in test/spec/. The
// fixture asserts violations in aggregate; these tests pin specific wire-
// level properties of the sessionless client (header presence, _meta
// shape, no initialize, server/discover precedes tools/list).

describe("McpProxyToolBackend — protocolMode: 'next' (sessionless)", () => {
  it("sends MCP-Protocol-Version header on every request and inline _meta", async () => {
    const recorded: Array<{ method: string; headers: Record<string, string>; body: { params?: { _meta?: Record<string, unknown> } } }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const headers: Record<string, string> = {};
      const raw = init?.headers ?? {};
      if (raw instanceof Headers) raw.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      else if (Array.isArray(raw)) for (const [k, v] of raw) headers[k.toLowerCase()] = String(v);
      else for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);

      const body = init?.body ? JSON.parse(String(init.body)) : { method: "?" };
      recorded.push({ method: body.method, headers, body });

      if (body.method === "server/discover") return jsonResponse({ protocolVersion: "2026-XX-XX", capabilities: {} });
      if (body.method === "tools/list")      return jsonResponse(TOOLS_LIST_RESULT);
      return jsonResponse({ content: [{ type: "text", text: "{}" }] });
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: false,
      protocolMode:    "next",
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);
    await b.refreshTools(envWith("http://stub/mcp"));

    // Every outbound request carries MCP-Protocol-Version + _meta.
    for (const call of recorded) {
      expect(call.headers["mcp-protocol-version"]).toBeDefined();
      expect(call.headers["mcp-session-id"]).toBeUndefined();
      const meta = call.body.params?._meta;
      expect(meta).toBeDefined();
      expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(meta?.clientInfo).toBeDefined();
      expect(meta?.clientCapabilities).toBeDefined();
    }
  });

  it("calls server/discover instead of initialize, in that order", async () => {
    const seenMethods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : { method: "?" };
      seenMethods.push(body.method);
      if (body.method === "server/discover") return jsonResponse({ protocolVersion: "2026-XX-XX", capabilities: {} });
      if (body.method === "tools/list")      return jsonResponse(TOOLS_LIST_RESULT);
      return jsonResponse({});
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: false,
      protocolMode:    "next",
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);
    await b.refreshTools(envWith("http://stub/mcp"));

    expect(seenMethods).toContain("server/discover");
    expect(seenMethods).not.toContain("initialize");
    // server/discover must arrive before tools/list.
    const discoverIdx = seenMethods.indexOf("server/discover");
    const listIdx     = seenMethods.indexOf("tools/list");
    expect(discoverIdx).toBeLessThan(listIdx);
  });

  it("invoke() forwards _meta on tools/call and never sends a session header", async () => {
    let callBody: { params?: { _meta?: Record<string, unknown> } } | null = null;
    let callHeaders: Record<string, string> = {};
    const fetcher: typeof fetch = async (_input, init) => {
      const headers: Record<string, string> = {};
      const raw = init?.headers ?? {};
      if (raw instanceof Headers) raw.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      else if (Array.isArray(raw)) for (const [k, v] of raw) headers[k.toLowerCase()] = String(v);
      else for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);

      const body = init?.body ? JSON.parse(String(init.body)) : { method: "?" };
      if (body.method === "server/discover") return jsonResponse({ protocolVersion: "2026-XX-XX", capabilities: {} });
      if (body.method === "tools/list")      return jsonResponse(TOOLS_LIST_RESULT);
      if (body.method === "tools/call") {
        callBody = body;
        callHeaders = headers;
        return jsonResponse({ content: [{ type: "text", text: '{"ok":true}' }] });
      }
      return jsonResponse({});
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: false,
      protocolMode:    "next",
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);
    await b.refreshTools(envWith("http://stub/mcp"));
    await b.invoke("mache_get_overview", { repo: "x" }, envWith("http://stub/mcp"));

    expect(callBody).not.toBeNull();
    expect(callBody!.params?._meta).toBeDefined();
    expect(callHeaders["mcp-protocol-version"]).toBe("2026-07-28");
    expect(callHeaders["mcp-session-id"]).toBeUndefined();
  });
});

// ── claims-aware filtering (cloister-8ede3f) ─────────────────────────────
//
// HttpForwardBackend.claims @7 lets a backend declare which upstream tool
// names it owns. When non-empty, the derived `tools/list` set is filtered
// to that explicit list — the foundation for a single MCP upstream (LLO)
// being split across N backends in the same manifest (one per group).
//
// The four cases pin the precedence rules:
//   1. LSP-shape: claims set, prefix matches upstream (lsp_*) — names
//      pass through verbatim, no double-prefix.
//   2. Mache-shape: claims empty, prefix non-empty — legacy add-prefix
//      behavior preserved.
//   3. Prefix-less + claims: prefix empty, claims set — only the named
//      tools surface, advertised verbatim.
//   4. Empty everything: prefix empty + claims empty — legacy
//      claim-everything behavior; pinned so future changes can't silently
//      regress.

describe("McpProxyToolBackend — claims filter (cloister-8ede3f)", () => {
  const LLO_TOOLS_LIST_RESULT = {
    tools: [
      { name: "lsp_hover",          description: "hover",          inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "lsp_defs",           description: "defs",           inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "lsp_refs",           description: "refs",           inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "lsp_symbols",        description: "symbols",        inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "lsp_diagnostics",    description: "diagnostics",    inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "status",             description: "lifecycle status",inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "enrich",             description: "enrich pass",    inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "reparse",            description: "reparse tree",   inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "sheaf_set_topology", description: "set topology",   inputSchema: { type: "object", properties: {}, required: [] } },
    ],
  };

  it("LSP-shape: claims set + prefix matches upstream — verbatim names, no double-prefix", async () => {
    const spec: HttpForwardBackend = {
      urlBinding:   "LLO_MCP_URL",
      tools:        [],
      dynamicTools: true,
      stripPrefix:  "",   // upstream already uses lsp_ prefix; do not strip
      claims:       ["lsp_hover", "lsp_defs", "lsp_refs", "lsp_symbols", "lsp_diagnostics"],
    };
    const { fetcher } = mockFetch(() => jsonResponse(LLO_TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "lsp_", fetcher);

    await b.refreshTools({ LLO_MCP_URL: "http://llo.stub/mcp" } as unknown as Env);

    const names = b.tools().map(t => t.name).sort();
    expect(names).toEqual([
      "lsp_defs", "lsp_diagnostics", "lsp_hover", "lsp_refs", "lsp_symbols",
    ]);
    // No `lsp_lsp_*` double-prefix surfaces.
    expect(names.some(n => n.startsWith("lsp_lsp_"))).toBe(false);

    expect(b.handles("lsp_hover")).toBe(true);
    expect(b.handles("lsp_defs")).toBe(true);
    expect(b.handles("status")).toBe(false);
    expect(b.handles("sheaf_set_topology")).toBe(false);
  });

  it("Mache-shape: claims empty + prefix non-empty — legacy add-prefix preserved", async () => {
    const spec: HttpForwardBackend = {
      urlBinding:   "MACHE_MCP_URL",
      tools:        [],
      dynamicTools: true,
      stripPrefix:  "mache_",
      claims:       [],
    };
    const upstream = {
      tools: [
        { name: "get_overview",  description: "overview", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "find_callers", description: "callers",  inputSchema: { type: "object", properties: {}, required: [] } },
      ],
    };
    const { fetcher } = mockFetch(() => jsonResponse(upstream));
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    await b.refreshTools(envWith("http://mache.stub/mcp"));

    expect(b.tools().map(t => t.name).sort()).toEqual(["mache_find_callers", "mache_get_overview"]);
    expect(b.handles("mache_get_overview")).toBe(true);
    expect(b.handles("get_overview")).toBe(false);
  });

  it("cloister-2d987e Bug 3: resolver-generated mache shape — non-empty claims + non-empty prefix + derived stripPrefix", async () => {
    // The P3 resolver shape for a group like mache's "callgraph"
    // (advertisedPrefix="mache_", upstreamNames=["find_callers", ...] —
    // BARE, not already prefixed). Before cloister-2d987e's stripPrefix
    // derivation fix, deriveGeneratedBackends never set stripPrefix, so
    // handles("mache_find_callers") returned false: claims held the bare
    // "find_callers", the advertised/incoming name was "mache_find_callers",
    // and there was no stripPrefix to reconcile the two. mache's tools
    // were tools/list-visible but NOT tools/call-dispatchable.
    const spec: HttpForwardBackend = {
      urlBinding:   "MACHE_MCP_URL",
      tools:        [],
      dynamicTools: true,
      stripPrefix:  "mache_", // derived by resolve-inputs.mjs:deriveStripPrefix
      claims:       ["find_callers", "find_callees"],
    };
    const upstream = {
      tools: [
        { name: "find_callers", description: "callers", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "find_callees", description: "callees", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "get_overview", description: "overview", inputSchema: { type: "object", properties: {}, required: [] } }, // belongs to a sibling group, not this backend's claims
      ],
    };
    const { fetcher } = mockFetch(() => jsonResponse(upstream));
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);

    await b.refreshTools(envWith("http://mache.stub/mcp"));

    // tools() advertises the bare upstream names under the prefix.
    expect(b.tools().map(t => t.name).sort()).toEqual(["mache_find_callees", "mache_find_callers"]);

    // The exact failure this bug produced, now fixed: the EXTERNALLY
    // advertised/called name must dispatch to this backend.
    expect(b.handles("mache_find_callers")).toBe(true);
    expect(b.handles("mache_find_callees")).toBe(true);
    // A sibling group's tool (same prefix, different claims) must NOT
    // be claimed by this backend, in either the advertised or bare form.
    expect(b.handles("mache_get_overview")).toBe(false);
    expect(b.handles("get_overview")).toBe(false);
    // handles() checks `claims.has(toolName)` verbatim BEFORE applying
    // stripPrefix (see mcp-proxy.ts:handles()), so the bare upstream
    // name also matches directly — stripPrefix is the fallback for the
    // ADVERTISED name, not a requirement that the bare name stop
    // matching. Both forms dispatching to this backend is correct.
    expect(b.handles("find_callers")).toBe(true);
  });

  it("cloister-2d987e Bug 3 regression: llo's already-prefixed shape is unaffected by stripPrefix derivation", async () => {
    // llo's groups declare upstreamNames that ALREADY carry
    // advertisedPrefix (e.g. "lsp_hover" under advertisedPrefix "lsp_").
    // deriveStripPrefix must leave stripPrefix="" for this shape — this
    // pins that the Bug 3 fix doesn't regress the working already-
    // prefixed case (llo is the only real-world producer of it today).
    const spec: HttpForwardBackend = {
      urlBinding:   "LLO_MCP_URL",
      tools:        [],
      dynamicTools: true,
      stripPrefix:  "", // still empty — llo's upstreamNames are already prefixed
      claims:       ["lsp_hover", "lsp_defs"],
    };
    const { fetcher } = mockFetch(() => jsonResponse(LLO_TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "lsp_", fetcher);

    await b.refreshTools({ LLO_MCP_URL: "http://llo.stub/mcp" } as unknown as Env);

    expect(b.tools().map(t => t.name).sort()).toEqual(["lsp_defs", "lsp_hover"]);
    expect(b.handles("lsp_hover")).toBe(true);
    expect(b.handles("lsp_defs")).toBe(true);
    expect(b.handles("lsp_refs")).toBe(false); // claimed by a sibling group, not this one
  });

  it("prefix-less + claims: empty handlesPrefix, claims drives selection — verbatim", async () => {
    const spec: HttpForwardBackend = {
      urlBinding:   "LLO_MCP_URL",
      tools:        [],
      dynamicTools: true,
      stripPrefix:  "",
      claims:       ["status", "enrich", "reparse"],
    };
    const { fetcher } = mockFetch(() => jsonResponse(LLO_TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "", fetcher);

    await b.refreshTools({ LLO_MCP_URL: "http://llo.stub/mcp" } as unknown as Env);

    expect(b.tools().map(t => t.name).sort()).toEqual(["enrich", "reparse", "status"]);
    expect(b.handles("status")).toBe(true);
    expect(b.handles("enrich")).toBe(true);
    expect(b.handles("reparse")).toBe(true);
    expect(b.handles("lsp_hover")).toBe(false);
    expect(b.handles("sheaf_set_topology")).toBe(false);
  });

  it("empty everything: prefix='' + claims=[] — legacy claim-all behavior pinned", async () => {
    // This is the over-claim guard: when both prefix and claims are empty,
    // the backend claims every upstream tool. Single-backend-per-upstream
    // shape; pinned so a future regression surfaces.
    const spec: HttpForwardBackend = {
      urlBinding:   "LLO_MCP_URL",
      tools:        [],
      dynamicTools: true,
      stripPrefix:  "",
      claims:       [],
    };
    const { fetcher } = mockFetch(() => jsonResponse(LLO_TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "", fetcher);

    await b.refreshTools({ LLO_MCP_URL: "http://llo.stub/mcp" } as unknown as Env);

    expect(b.tools().map(t => t.name).sort()).toEqual([
      "enrich",
      "lsp_defs",
      "lsp_diagnostics",
      "lsp_hover",
      "lsp_refs",
      "lsp_symbols",
      "reparse",
      "sheaf_set_topology",
      "status",
    ]);
    expect(b.handles("status")).toBe(true);
    expect(b.handles("lsp_hover")).toBe(true);
  });
});

describe("McpProxyToolBackend — protocolMode: 'auto' downgrade", () => {
  it("downgrades to current-spec when upstream rejects sessionless on server/discover", async () => {
    let discoverCount = 0;
    let initializeCount = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : { method: "?" };
      if (body.method === "server/discover") {
        discoverCount++;
        return new Response("not supported", { status: 400 });
      }
      if (body.method === "initialize") {
        initializeCount++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2024-11-05" } }), {
          status:  200,
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sid-1" },
        });
      }
      if (body.method === "tools/list") return jsonResponse(TOOLS_LIST_RESULT);
      return jsonResponse({});
    };

    const spec: HttpForwardBackend = {
      urlBinding:      "MACHE_MCP_URL",
      tools:           [],
      dynamicTools:    true,
      stripPrefix:     "mache_",
      requiresSession: true,
      protocolMode:    "auto",
    };
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);
    await b.refreshTools(envWith("http://stub/mcp"));

    expect(discoverCount).toBe(1);
    expect(initializeCount).toBe(1);
    // Derived catalog populated via the legacy path.
    expect(b.tools().map(t => t.name).sort()).toEqual(["mache_find_callers", "mache_get_overview"]);
  });
});

// ── Outbound Mcp-Method / Mcp-Name derivation (SEP-2243 / cloister-da49a6) ─
//
// Cloister's edge rejects requests whose routing headers disagree with the
// body. The proxy leg must therefore DERIVE its outbound headers from the body
// it sends — emitting anything else would make cloister the lying
// intermediary its own edge rejects.
describe("McpProxyToolBackend — outbound header derivation", () => {
  function headerCapturingFetch(respond: (method: string, body: unknown) => Response) {
    const seen: Array<{ headers: Record<string, string>; body: { method?: string; params?: { name?: string } } }> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { h[k.toLowerCase()] = v; });
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seen.push({ headers: h, body });
      return respond(body?.method ?? "", body);
    };
    return { fetcher, seen };
  }

  const spec: HttpForwardBackend = {
    urlBinding: "MACHE_MCP_URL",
    tools: [],
    dynamicTools: true,
    protocolMode: "next",   // sessionless: no initialize leg to special-case
  };

  it("every outbound POST carries Mcp-Method equal to its body method", async () => {
    const { fetcher, seen } = headerCapturingFetch(() => jsonResponse(TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);
    await b.refreshTools(envWith("http://stub/"));
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.headers["mcp-method"]).toBe(call.body.method);
    }
  });

  it("tools/call carries Mcp-Name equal to params.name; tools/list carries none", async () => {
    const { fetcher, seen } = headerCapturingFetch((method) =>
      method === "tools/call"
        ? jsonResponse({ content: [{ type: "text", text: "ok" }] })
        : jsonResponse(TOOLS_LIST_RESULT));
    const b = new McpProxyToolBackend(spec, "mache_", fetcher);
    await b.refreshTools(envWith("http://stub/"));
    await b.invoke("mache_search", { q: "x" }, envWith("http://stub/"));

    const listCalls = seen.filter(c => c.body?.method === "tools/list");
    const toolCalls = seen.filter(c => c.body?.method === "tools/call");
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].headers["mcp-name"]).toBe(toolCalls[0].body.params?.name);
    for (const c of listCalls) expect(c.headers["mcp-name"]).toBeUndefined();
  });
});
