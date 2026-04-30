/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Tests for HttpForwardToolBackend's dynamic tools/list path (ADR-0006).
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
import { HttpForwardToolBackend } from "../../src/manifest/backends/http-forward.js";
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

describe("HttpForwardToolBackend — static (dynamicTools=false)", () => {
  it("does not fetch tools/list and returns only the Asserted catalog", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL",
      tools: [
        { name: "lsp_hover", description: "h", inputSchemaJson: '{"type":"object"}' },
      ],
    };
    const { fetcher, calls } = mockFetch(() => jsonResponse(TOOLS_LIST_RESULT));
    const b = new HttpForwardToolBackend(spec, "lsp_", fetcher);

    await b.refreshTools(envWith("http://stub/")); // should be a no-op
    expect(calls.length).toBe(0);

    const tools = b.tools();
    expect(tools.map(t => t.name)).toEqual(["lsp_hover"]);
  });
});

// ── Derived catalog ───────────────────────────────────────────────────────

describe("HttpForwardToolBackend — dynamic (dynamicTools=true)", () => {
  it("fetches tools/list and re-prefixes names with handlesPrefix", async () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL",
      tools: [],
      dynamicTools: true,
      stripPrefix:  "mache_",
    };
    const { fetcher, calls } = mockFetch(() => jsonResponse(TOOLS_LIST_RESULT));
    const b = new HttpForwardToolBackend(spec, "mache_", fetcher);

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
    const b = new HttpForwardToolBackend(spec, "mache_", fetcher);

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
    const b = new HttpForwardToolBackend(spec, "mache_", fetcher);

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
    const b = new HttpForwardToolBackend(spec, "mache_", fetcher);

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
    const b = new HttpForwardToolBackend(spec, "mache_", fetcher);

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
    const b = new HttpForwardToolBackend(spec, "mache_", fetcher);

    const result = await b.invoke("mache_get_overview", { repo: "x" }, envWith("http://stub/"));
    const callBody = calls.find(c => (c.body as { method: string }).method === "tools/call")!;
    expect(((callBody.body as { params: { name: string } }).params.name)).toBe("get_overview");
    expect(result).toEqual({ wireName: "get_overview", args: { repo: "x" } });
  });

  it("handles() returns true for prefixed names even before refreshTools runs", () => {
    const spec: HttpForwardBackend = {
      urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
    };
    const b = new HttpForwardToolBackend(spec, "mache_", (() => { throw new Error("nope"); }) as unknown as typeof fetch);
    expect(b.handles("mache_get_overview")).toBe(true);
    expect(b.handles("rsry_status")).toBe(false);
  });
});

// ── Runtime validation ────────────────────────────────────────────────────

describe("manifest runtime: dynamicTools validation", () => {
  it("rejects dynamicTools=true with empty handlesPrefix", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "x", handlesPrefix: "", kind: { httpForward: {
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
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "mache", handlesPrefix: "mache_", kind: { httpForward: {
            urlBinding: "MACHE_MCP_URL", tools: [], dynamicTools: true, stripPrefix: "mache_",
          } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });
});
