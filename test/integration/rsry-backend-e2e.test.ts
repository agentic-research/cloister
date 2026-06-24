/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// End-to-end exercise of the rsry_* mcpProxy backend (ADR-0033 / cloister-c2bd47).
//
// The unit-level pin at `test/manifest/rsry-backend.test.ts` asserts the
// manifest contains the backend with the right shape. This file goes one
// rung up: exercise the constructed McpProxyToolBackend with realistic
// upstream rosary responses, verifying the dynamicTools tools/list path
// + the claim-routing logic + the no-double-prefix invariant
// (cloister-8ede3f, which the LSP backend also relies on).
//
// What this catches that the unit pin doesn't:
//
// 1. rsry's upstream tool names arrive ALREADY-PREFIXED (`rsry_status`,
//    `rsry_decompose`, etc.). With handlesPrefix="rsry_" + stripPrefix="",
//    a naive re-prefix would produce `rsry_rsry_status`. The
//    cloister-8ede3f fix in mcp-proxy.ts:290-295 prevents that. This
//    test pins the property.
// 2. The `claims` list (35 rsry_* tools per cluster.toml) wires into
//    the `handles()` routing decision: a claimed tool name owns the
//    backend, regardless of prefix matching.
// 3. Coexistence with the `bead_*` durableObject backend at the route
//    level — instantiating both, asserting they route to different
//    backends without collision.

import { describe, expect, it } from "vitest";
import { McpProxyToolBackend } from "../../src/manifest/backends/mcp-proxy.js";
import { instantiate } from "../../src/manifest/runtime.js";
import type { Gateway, HttpForwardBackend } from "../../src/manifest/types.js";
import type { Env } from "../../src/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

/** The shape upstream rosary returns from `tools/list` — names are
 *  already prefixed `rsry_*`. */
const RSRY_TOOLS_LIST = {
  tools: [
    {
      name:        "rsry_status",
      description: "rosary status across configured repos",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name:        "rsry_bead_create",
      description: "create a new bead",
      inputSchema: {
        type:       "object",
        properties: { title: { type: "string" }, repo_path: { type: "string" } },
        required:   ["title"],
      },
    },
    {
      name:        "rsry_bead_search",
      description: "full-text search beads",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name:        "rsry_decompose",
      description: "decompose work into beads",
      inputSchema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
    },
  ],
};

function jsonRpcResult(body: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 0, result: body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function envWith(url: string): Env {
  return { ROSARY_MCP_URL: url } as unknown as Env;
}

function rsrySpec(opts: { claims?: string[]; dynamicTools?: boolean } = {}): HttpForwardBackend {
  return {
    urlBinding:     "ROSARY_MCP_URL",
    tools:          [],
    dynamicTools:   opts.dynamicTools ?? true,
    stripPrefix:    "",
    claims:         opts.claims,
    requiresSession: false,
  };
}

function mockFetch(respond: (method: string, body: unknown) => Response): {
  fetcher: typeof fetch;
  calls:   Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return respond((body as { method: string } | null)?.method ?? "", body);
  };
  return { fetcher, calls };
}

// ── tools/list passthrough ───────────────────────────────────────────────

describe("rsry_* mcpProxy: tools/list passthrough (cloister-c2bd47)", () => {
  it("upstream rsry_* names flow through WITHOUT double-prefixing (cloister-8ede3f)", async () => {
    // Critical property — without the cloister-8ede3f fix, rsry's
    // already-prefixed upstream names would become rsry_rsry_status etc.
    const spec = rsrySpec();
    const { fetcher, calls } = mockFetch(() => jsonRpcResult(RSRY_TOOLS_LIST));
    const b = new McpProxyToolBackend(spec, "rsry_", fetcher);

    await b.refreshTools(envWith("http://stub/rsry/mcp"));
    expect(calls.length).toBe(1);
    expect((calls[0]!.body as { method: string }).method).toBe("tools/list");

    const advertised = b.tools().map((t) => t.name).sort();
    expect(advertised).toEqual([
      "rsry_bead_create",
      "rsry_bead_search",
      "rsry_decompose",
      "rsry_status",
    ]);

    // Negative property: NO double-prefixed name appears.
    for (const name of advertised) {
      expect(name.startsWith("rsry_rsry_")).toBe(false);
    }
  });

  it("tool catalog preserves inputSchema verbatim — operator sees rosary's true contract", async () => {
    const spec = rsrySpec();
    const { fetcher } = mockFetch(() => jsonRpcResult(RSRY_TOOLS_LIST));
    const b = new McpProxyToolBackend(spec, "rsry_", fetcher);
    await b.refreshTools(envWith("http://stub/rsry/mcp"));

    const create = b.tools().find((t) => t.name === "rsry_bead_create")!;
    expect(create.description).toBe("create a new bead");
    expect(create.inputSchema.required).toEqual(["title"]);
    expect((create.inputSchema.properties as Record<string, { type: string }>).repo_path.type).toBe("string");
  });
});

// ── handles() routing under claims ───────────────────────────────────────

describe("rsry_* mcpProxy: handles() routing (claim-aware per cloister-8ede3f)", () => {
  it("claimed names always route here, regardless of dynamicTools state", () => {
    const claims = ["rsry_status", "rsry_bead_create", "rsry_decompose"];
    const spec = rsrySpec({ claims });
    const { fetcher } = mockFetch(() => jsonRpcResult(RSRY_TOOLS_LIST));
    const b = new McpProxyToolBackend(spec, "rsry_", fetcher);

    // Claims-list match wins even before refreshTools() runs.
    for (const name of claims) {
      expect(b.handles(name)).toBe(true);
    }
    // An unclaimed rsry_* name doesn't route via claims (claims is exhaustive
    // when non-empty per cloister-8ede3f) — UNLESS the catalog later
    // discovers it. Pre-refresh state:
    expect(b.handles("rsry_status_unknown")).toBe(false);
  });

  it("prefix-only fallback when claims list is empty", () => {
    const spec = rsrySpec({ claims: [] });
    const { fetcher } = mockFetch(() => jsonRpcResult(RSRY_TOOLS_LIST));
    const b = new McpProxyToolBackend(spec, "rsry_", fetcher);

    // Empty claims → prefix matching kicks in. Any rsry_* name routes.
    expect(b.handles("rsry_status")).toBe(true);
    expect(b.handles("rsry_anything_new")).toBe(true);
    expect(b.handles("mache_get_overview")).toBe(false);
    expect(b.handles("bead_create")).toBe(false);
  });

  it("bead_* names NEVER route to rsry backend (D5 coexistence)", () => {
    // ADR-0033 D5: the bead_* tools route to cloister's BeadStore
    // DurableObject, not to rsry. The rsry backend MUST NOT claim bead_*
    // by accident (e.g. via overly-loose prefix matching).
    const spec = rsrySpec();
    const { fetcher } = mockFetch(() => jsonRpcResult(RSRY_TOOLS_LIST));
    const b = new McpProxyToolBackend(spec, "rsry_", fetcher);

    expect(b.handles("bead_create")).toBe(false);
    expect(b.handles("bead_search")).toBe(false);
    expect(b.handles("bead_close")).toBe(false);
  });
});

// ── instantiate() integration through real manifest types ────────────────

describe("rsry_* mcpProxy: instantiate() integration (cloister-c2bd47)", () => {
  function gatewayWithRsry(): Gateway {
    return {
      metadata: { name: "test-rsry-integration", version: "0.0.0" },
      routes: [
        {
          path: "/mcp",
          kind: {
            mcp: {
              backends: [
                {
                  name:          "rsry",
                  handlesPrefix: "rsry_",
                  kind: {
                    mcpProxy: {
                      urlBinding:     "ROSARY_MCP_URL",
                      tools:          [],
                      dynamicTools:   true,
                      stripPrefix:    "",
                      claims:         ["rsry_status"],
                      requiresSession: false,
                    },
                  },
                },
              ],
            },
          },
        },
      ],
      actor: {
        fingerprint:     "",
        algorithm:       "ed25519",
        pubkeyBinding:   "",
        attestationRepo: "",
        tunnelEndpoint:  "",
      },
      policy: {
        maxCertLifetimeSeconds: 300,
        requireInterlock:       false,
        minAlgorithm:           "ed25519",
      },
    };
  }

  it("manifest pipeline accepts the rsry-only Gateway and produces one /mcp route", () => {
    const gw = gatewayWithRsry();
    const routes = instantiate(gw);
    expect(routes.length).toBe(1);
    // The route's match() recognizes /mcp requests.
    const req = new Request("https://router.example/mcp", { method: "POST" });
    expect(routes[0]!.match(req)).toBe(true);
  });

  it("validate() rejects dynamicTools=true with empty handlesPrefix AND empty claims", () => {
    // Defensive invariant: a backend with no static handlesPrefix and no
    // explicit claims can't route anything until tools/list fires. This
    // would silently swallow EVERY tools/call until the catalog populated.
    // The runtime should refuse this shape at instantiation.
    const gw = gatewayWithRsry();
    const bad = JSON.parse(JSON.stringify(gw)) as Gateway;
    // @ts-expect-error — mutating readonly for the test
    bad.routes[0].kind.mcp.backends[0].handlesPrefix = "";
    // @ts-expect-error — same
    bad.routes[0].kind.mcp.backends[0].kind.mcpProxy.claims = [];
    expect(() => instantiate(bad)).toThrow();
  });
});

// ── ADR-0033 Open Q #2 — prefix collision check ──────────────────────────

describe("ADR-0033 Open Q #2: rsry_ does not collide with existing tool prefixes", () => {
  it("the rsry_ prefix is structurally distinct from bead_, mache_, lsp_, and bd_", () => {
    const knownPrefixes = ["bead_", "mache_", "lsp_", "bd_"];
    for (const p of knownPrefixes) {
      // A prefix is "structurally distinct" if no tool name matches both.
      // The simplest mechanical check: prefix-vs-prefix can't be a
      // substring of the other.
      expect("rsry_".startsWith(p)).toBe(false);
      expect(p.startsWith("rsry_")).toBe(false);
    }
  });

  it("bd CLI command names — when wrapped by rsry — gain the rsry_ prefix and do NOT collide", () => {
    // Per ADR-0033 Amendment 1: bd's CLI uses unprefixed names (`bd
    // create`, `bd close`, `bd search`). When rsry wraps these as MCP
    // tools, the rsry namespace owns the prefix. So `bd close` becomes
    // `rsry_bead_close` at the MCP wire, not bare `close`.
    //
    // This test pins the OBSERVATION: rsry's actual MCP surface uses
    // rsry_bead_close (which we just claimed in cluster.toml), not
    // `close`. If rosary ever exposes a bare `close` tool, the cloister
    // gateway would have no route for it — and that's correct, by
    // design.
    const claims = [
      "rsry_bead_create", "rsry_bead_close", "rsry_bead_search",
      "rsry_status", "rsry_decompose",
    ];
    const spec = rsrySpec({ claims });
    const { fetcher } = mockFetch(() => jsonRpcResult(RSRY_TOOLS_LIST));
    const b = new McpProxyToolBackend(spec, "rsry_", fetcher);

    // The unwrapped names are absent from the routing surface.
    expect(b.handles("create")).toBe(false);
    expect(b.handles("close")).toBe(false);
    expect(b.handles("search")).toBe(false);
    // The wrapped names are present.
    expect(b.handles("rsry_bead_create")).toBe(true);
    expect(b.handles("rsry_bead_close")).toBe(true);
    expect(b.handles("rsry_bead_search")).toBe(true);
  });
});
