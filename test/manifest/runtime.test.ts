/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { instantiate } from "../../src/manifest/runtime.js";
import type { Gateway } from "../../src/manifest/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const mkTool = (name: string) => ({
  name,
  description: `${name} (test)`,
  inputSchemaJson: '{"type":"object"}',
});

// ── Validation ─────────────────────────────────────────────────────────────

describe("manifest runtime: validation", () => {
  it("rejects duplicate route paths", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/health", kind: { health: null } },
        { path: "/health", kind: { health: null } },
      ],
    };
    expect(() => instantiate(m)).toThrow(/duplicate route path/);
  });

  it("rejects duplicate backend prefixes across an mcp route", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "a", handlesPrefix: "x_", kind: { mcpProxy: { urlBinding: "U", tools: [mkTool("x_one")] } } },
          { name: "b", handlesPrefix: "x_", kind: { mcpProxy: { urlBinding: "U", tools: [mkTool("x_two")] } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/duplicate backend prefix/);
  });

  // cloister-2d987e: the P3 resolver can emit multiple dynamicTools
  // backends from ONE input's server.json that all share an
  // `advertisedPrefix` (e.g. mache's navigation/callgraph/lsp/lifecycle/
  // linter/mutate groups all advertise under "mache_"). Since each backend
  // has a non-empty `claims` set, McpProxyToolBackend.handles() dispatches
  // by exact upstream-name membership in `claims`, never falling back to
  // prefix matching — so sharing a prefix across claims-backed backends
  // is NOT the ADR-0002 first-wins-shadow hazard the original check
  // guarded against.
  it("allows multiple claims-backed backends to share a prefix (multi-group same-prefix server.json)", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "navigation", handlesPrefix: "mache_", kind: { mcpProxy: {
            urlBinding: "MACHE_MCP_URL", dynamicTools: true, tools: [],
            claims: ["get_overview", "list_directory"],
          }}},
          { name: "callgraph", handlesPrefix: "mache_", kind: { mcpProxy: {
            urlBinding: "MACHE_MCP_URL", dynamicTools: true, tools: [],
            claims: ["find_callers", "find_callees"],
          }}},
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });

  it("still rejects a claims-backed backend sharing a prefix with a claims-less backend", () => {
    // The claims-less backend falls back to prefix matching in handles()
    // — the original first-wins-shadow hazard still applies here.
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "a", handlesPrefix: "mache_", kind: { mcpProxy: {
            urlBinding: "U", dynamicTools: true, tools: [], claims: ["find_callers"],
          }}},
          { name: "b", handlesPrefix: "mache_", kind: { mcpProxy: {
            urlBinding: "U", tools: [mkTool("mache_other")],
          }}},
        ]}}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/shares prefix.*claims-less backend/);
  });

  it("rejects duplicate tool names across backends with empty prefixes", () => {
    // Two backends use exact-match (empty prefix) and both advertise the
    // same tool name. The duplicate-tool-name check must catch this even
    // though neither backend has a prefix that would conflict.
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "a", handlesPrefix: "", kind: { mcpProxy: { urlBinding: "U", tools: [mkTool("dup")] } } },
          { name: "b", handlesPrefix: "x_", kind: { mcpProxy: { urlBinding: "U", tools: [mkTool("dup")] } } },
        ]}}},
      ],
    };
    // First validator that fires is "doesn't start with prefix" (for the second backend)
    // — both errors are correct; this case proves we catch one of them.
    expect(() => instantiate(m)).toThrow(/duplicate (backend prefix|tool name)|does not start with/);
  });

  it("rejects tool name not matching backend prefix (when prefix is non-empty)", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "a", handlesPrefix: "lsp_", kind: { mcpProxy: { urlBinding: "U", tools: [mkTool("oops_one")] } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/does not start with backend prefix/);
  });

  it("allows empty handlesPrefix with arbitrary tool names (exact-match mode)", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "lifecycle", handlesPrefix: "", kind: { mcpProxy: { urlBinding: "U", tools: [
            mkTool("reparse"), mkTool("status"),
          ] } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });

  it("rejects health route with wrong path", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [{ path: "/wrong", kind: { health: null } }],
    };
    expect(() => instantiate(m)).toThrow(/health route must have path/);
  });

  it("rejects mcp route with wrong path", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/wrong", kind: { mcp: { backends: [] } } },
      ],
    };
    expect(() => instantiate(m)).toThrow(/mcp route must have path/);
  });

  it("rejects unsupported serviceBindingProxy bindings", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/identity", kind: { serviceBindingProxy: {
          binding: "OTHER", upstreamHost: "notme-bot", stripPrefix: "/identity",
        }}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/binding "NOTME"/);
  });
});

// ── Instantiation ──────────────────────────────────────────────────────────

describe("manifest runtime: instantiation", () => {
  it("returns one EdgeRoute per route entry", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/health", kind: { health: null } },
        { path: "/identity", kind: { serviceBindingProxy: {
          binding: "NOTME", upstreamHost: "notme-bot", stripPrefix: "/identity",
        }}},
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "bead", handlesPrefix: "bead_", kind: { durableObject: {
            binding: "BEAD_STORE", keyArg: "repo",
            tools: [mkTool("bead_create")],
          }}},
        ]}}},
      ],
    };
    const routes = instantiate(m);
    expect(routes).toHaveLength(3);
  });

  it("allows MULTIPLE empty-prefix backends in the same mcp route (exact-match mode)", () => {
    // Two backends with handlesPrefix="" must coexist; tool-name uniqueness
    // is the right invariant in exact-match mode, not prefix uniqueness.
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "lifecycle", handlesPrefix: "", kind: { mcpProxy: { urlBinding: "U", tools: [
            mkTool("reparse"), mkTool("status"),
          ] } } },
          { name: "ops", handlesPrefix: "", kind: { mcpProxy: { urlBinding: "V", tools: [
            mkTool("snapshot"),
          ] } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });

  it("still rejects duplicate tool names across two empty-prefix backends", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "a", handlesPrefix: "", kind: { mcpProxy: { urlBinding: "U", tools: [mkTool("dup")] } } },
          { name: "b", handlesPrefix: "", kind: { mcpProxy: { urlBinding: "V", tools: [mkTool("dup")] } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/duplicate tool name/);
  });

  it("supports all four backend kinds in a single mcp route", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "do", handlesPrefix: "do_", kind: { durableObject: {
            binding: "BEAD_STORE", keyArg: "repo", tools: [mkTool("do_one")],
          }}},
          { name: "http", handlesPrefix: "http_", kind: { mcpProxy: {
            urlBinding: "LLO_MCP_URL", tools: [mkTool("http_one")],
          }}},
          { name: "svc", handlesPrefix: "svc_", kind: { serviceBinding: {
            binding: "NOTME", tools: [mkTool("svc_one")],
          }}},
          { name: "uds", handlesPrefix: "uds_", kind: { udsForward: {
            socketPath: "/tmp/ignored.sock", tools: [mkTool("uds_one")],
          }}},
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });
});

// ── httpProxy route kind ───────────────────────────────────────────────────

describe("manifest runtime: httpProxy route kind", () => {
  it("matches its declared path and the path/* prefix; not other paths", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/proxy", kind: { httpProxy: {
          urlBinding: "ROSARY_MCP_URL", stripPrefix: "/proxy",
        }}},
      ],
    };
    const [route] = instantiate(m);
    expect(route.match(new Request("http://x/proxy"))).toBe(true);
    expect(route.match(new Request("http://x/proxy/something"))).toBe(true);
    expect(route.match(new Request("http://x/proxyx"))).toBe(false); // not a prefix
    expect(route.match(new Request("http://x/other"))).toBe(false);
  });

  it("returns 503 when the urlBinding is empty", async () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/proxy", kind: { httpProxy: { urlBinding: "ROSARY_MCP_URL", stripPrefix: "/proxy" } } },
      ],
    };
    const [route] = instantiate(m);
    const res = await route.handle(
      new Request("http://x/proxy/anything"),
      { ROSARY_MCP_URL: "" } as unknown as Parameters<typeof route.handle>[1],
    );
    expect(res.status).toBe(503);
  });
});

// ── UdsForwardToolBackend manifest-runtime integration ─────────────────────
//
// Deep behavioral coverage (round-trip wire, success/error paths) lives in
// test/manifest/uds-forward-backend.test.ts. These tests verify slot-in to
// the manifest runtime and that invocation without COMPANION_URL fails
// with the expected diagnostic (mirrors LeylineNet's pattern).

describe("UdsForwardToolBackend (manifest integration)", () => {
  it("advertises tools and matches handlesPrefix", async () => {
    const { UdsForwardToolBackend } = await import("../../src/manifest/backends/uds-forward.js");
    const b = new UdsForwardToolBackend(
      { socketPath: "/tmp/x.sock", tools: [{ name: "x_one", description: "", inputSchemaJson: '{"type":"object"}' }] },
      "x_",
    );
    expect(b.tools().map(t => t.name)).toEqual(["x_one"]);
    expect(b.handles("x_one")).toBe(true);
    expect(b.handles("other")).toBe(false);
  });

  it("throws JsonRpcInvocationError(-32603) when COMPANION_URL is unset", async () => {
    const { UdsForwardToolBackend } = await import("../../src/manifest/backends/uds-forward.js");
    const b = new UdsForwardToolBackend(
      { socketPath: "/tmp/x.sock", tools: [{ name: "x_one", description: "", inputSchemaJson: '{"type":"object"}' }] },
      "x_",
    );
    await expect(b.invoke("x_one", {}, {} as never)).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("COMPANION_URL"),
    });
  });
});

// ── LeylineNetToolBackend manifest-runtime integration ─────────────────────
//
// The deep behavioral coverage (success paths, error paths, wire fidelity)
// lives in test/manifest/leyline-net-backend.test.ts. These tests verify
// that the backend slots into the manifest runtime correctly and that
// invocation without COMPANION_URL fails with the expected diagnostic.

describe("LeylineNetToolBackend (manifest integration)", () => {
  it("advertises tools and matches handlesPrefix", async () => {
    const { LeylineNetToolBackend } = await import("../../src/manifest/backends/leyline-net.js");
    const b = new LeylineNetToolBackend(
      {
        companionUrlBinding: "COMPANION_URL",
        upstreamId:          "rosary",
        tools: [{ name: "rsry_status", description: "rosary status", inputSchemaJson: '{"type":"object"}' }],
      },
      "rsry_",
    );
    expect(b.tools().map(t => t.name)).toEqual(["rsry_status"]);
    expect(b.handles("rsry_status")).toBe(true);
    expect(b.handles("bead_create")).toBe(false);
  });

  it("throws JsonRpcInvocationError(-32603) when companion URL is unset", async () => {
    const { LeylineNetToolBackend } = await import("../../src/manifest/backends/leyline-net.js");
    const b = new LeylineNetToolBackend(
      {
        companionUrlBinding: "COMPANION_URL",
        upstreamId:          "rosary",
        tools: [{ name: "rsry_status", description: "", inputSchemaJson: '{"type":"object"}' }],
      },
      "rsry_",
    );
    await expect(b.invoke("rsry_status", {}, {} as never)).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("COMPANION_URL"),
    });
  });

  it("instantiates via the manifest runtime alongside other kinds", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "rosary", handlesPrefix: "rsry_", kind: { leylineNet: {
            companionUrlBinding: "COMPANION_URL",
            upstreamId:          "rosary",
            tools: [mkTool("rsry_status")],
          } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).not.toThrow();
  });
});
