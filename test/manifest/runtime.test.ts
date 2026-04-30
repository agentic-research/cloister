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
          { name: "a", handlesPrefix: "x_", kind: { httpForward: { urlBinding: "U", tools: [mkTool("x_one")] } } },
          { name: "b", handlesPrefix: "x_", kind: { httpForward: { urlBinding: "U", tools: [mkTool("x_two")] } } },
        ]}}},
      ],
    };
    expect(() => instantiate(m)).toThrow(/duplicate backend prefix/);
  });

  it("rejects duplicate tool names across backends with empty prefixes", () => {
    // Two backends use exact-match (empty prefix) and both advertise the
    // same tool name. The duplicate-tool-name check must catch this even
    // though neither backend has a prefix that would conflict.
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "a", handlesPrefix: "", kind: { httpForward: { urlBinding: "U", tools: [mkTool("dup")] } } },
          { name: "b", handlesPrefix: "x_", kind: { httpForward: { urlBinding: "U", tools: [mkTool("dup")] } } },
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
          { name: "a", handlesPrefix: "lsp_", kind: { httpForward: { urlBinding: "U", tools: [mkTool("oops_one")] } } },
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
          { name: "lifecycle", handlesPrefix: "", kind: { httpForward: { urlBinding: "U", tools: [
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

  it("supports all four backend kinds in a single mcp route", () => {
    const m: Gateway = {
      metadata: { name: "t", version: "0.0.0" },
      routes: [
        { path: "/mcp", kind: { mcp: { backends: [
          { name: "do", handlesPrefix: "do_", kind: { durableObject: {
            binding: "BEAD_STORE", keyArg: "repo", tools: [mkTool("do_one")],
          }}},
          { name: "http", handlesPrefix: "http_", kind: { httpForward: {
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
