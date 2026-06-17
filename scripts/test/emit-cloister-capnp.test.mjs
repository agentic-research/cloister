// scripts/test/emit-cloister-capnp.test.mjs
//
// Phase 2 (Commit 3) contract tests for scripts/emit-cloister-capnp.mjs —
// the cluster.toml + cluster.lock.toml → cloister.capnp emitter.
//
// Per cloister-345ad1 / ADR-0031.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { emitCloisterCapnp } from "../emit-cloister-capnp.mjs";

// ── Fixtures ──────────────────────────────────────────────────────────────

function minimalCluster() {
  return {
    metadata: { name: "test", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [
      { path: "/health", kind: { health: null } },
      { path: "/.well-known/interlace/index.json", kind: { wellKnownInterlace: null } },
    ],
  };
}

function clusterWithMcp() {
  return {
    metadata: { name: "test-mcp", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [
      { path: "/health", kind: { health: null } },
      {
        path: "/mcp",
        kind: {
          mcp: {
            backends: [
              {
                name: "bead",
                handlesPrefix: "bead_",
                kind: {
                  durableObject: {
                    binding: "BEAD_STORE",
                    keyArg: "repo",
                    tools: [
                      { name: "bead_create", description: "Create a bead.", inputSchemaJson: '{"type":"object"}' },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

// ── Contract 1: byte-stable output ────────────────────────────────────────

test("emit-cloister-capnp: two runs on the same input produce identical bytes", () => {
  const c = clusterWithMcp();
  const a = emitCloisterCapnp(c);
  const b = emitCloisterCapnp(c);
  assert.equal(a, b, "byte-stable output is the load-bearing property of the drift gate");
});

// ── Contract 2: header + capnp preamble ───────────────────────────────────

test("emit-cloister-capnp: emits capnp file id + import preamble + gateway const declaration", () => {
  const out = emitCloisterCapnp(minimalCluster());
  assert.match(out, /@0xa1c0157e1a1f0001;/);
  assert.match(out, /using Cloister = import "\/cloister\/manifest\/cloister.capnp";/);
  assert.match(out, /const gateway :Cloister.Gateway = \(/);
});

// ── Contract 3: void route variants emit single-line `kind = (<variant> = void)` ──

test("emit-cloister-capnp: void route variants emit single-line form (kind = (health = void))", () => {
  const out = emitCloisterCapnp(minimalCluster());
  assert.match(out, /\( path = "\/health", kind = \(health = void\) \)/);
  assert.match(out, /kind = \(wellKnownInterlace = void\)/);
});

// ── Contract 4: serviceBindingProxy carries its payload (binding, upstreamHost, stripPrefix) ──

test("emit-cloister-capnp: serviceBindingProxy route emits multi-line payload form", () => {
  const c = minimalCluster();
  c.routes.push({
    path: "/identity",
    kind: {
      serviceBindingProxy: {
        binding: "NOTME",
        upstreamHost: "notme-bot",
        stripPrefix: "/identity",
      },
    },
  });
  const out = emitCloisterCapnp(c);
  assert.match(out, /kind = \(serviceBindingProxy = \(/);
  assert.match(out, /binding      = "NOTME"/);
  assert.match(out, /upstreamHost = "notme-bot"/);
  assert.match(out, /stripPrefix  = "\/identity"/);
});

// ── Contract 5: vaultProxy + httpProxy payloads ──────────────────────────

test("emit-cloister-capnp: vaultProxy + httpProxy variants emit their payload fields", () => {
  const c = minimalCluster();
  c.routes.push({ path: "/vault/proxy", kind: { vaultProxy: { bundleIdName: "router" } } });
  c.routes.push({ path: "/proxy", kind: { httpProxy: { urlBinding: "LLO_MCP_URL", stripPrefix: "/proxy" } } });
  const out = emitCloisterCapnp(c);
  assert.match(out, /bundleIdName = "router"/);
  assert.match(out, /urlBinding  = "LLO_MCP_URL"/);
  assert.match(out, /stripPrefix = "\/proxy"/);
});

// ── Contract 6: mcp route with durableObject backend (tools list rendered inline) ──

test("emit-cloister-capnp: mcp route renders durableObject backend with tools block", () => {
  const out = emitCloisterCapnp(clusterWithMcp());
  assert.match(out, /kind = \(mcp = \(/);
  assert.match(out, /backends = \[/);
  assert.match(out, /name          = "bead"/);
  assert.match(out, /handlesPrefix = "bead_"/);
  assert.match(out, /kind = \(durableObject = \(/);
  assert.match(out, /binding = "BEAD_STORE"/);
  assert.match(out, /keyArg  = "repo"/);
  assert.match(out, /name = "bead_create"/);
  assert.match(out, /description = "Create a bead."/);
});

// ── Contract 7: lockfile [[generated_backends]] inject into /mcp ─────────

test("emit-cloister-capnp: [[generated_backends]] rows inject into /mcp backends list", () => {
  const c = clusterWithMcp();
  const lockfile = {
    schema: "cloister/lockfile/v1",
    generated_backends: [
      {
        input: "llo",
        name: "lsp",
        handlesPrefix: "lsp_",
        claims: ["lsp_hover", "lsp_defs"],
        dynamicTools: true,
        urlBinding: "LLO_MCP_URL",
        serviceBinding: "LSP_MCP",
      },
    ],
  };
  const out = emitCloisterCapnp(c, lockfile);
  assert.match(out, /name          = "lsp"/);
  assert.match(out, /handlesPrefix = "lsp_"/);
  assert.match(out, /urlBinding      = "LLO_MCP_URL"/);
  assert.match(out, /serviceBinding  = "LSP_MCP"/);
  assert.match(out, /dynamicTools    = true/);
  assert.match(out, /claims          = \[ "lsp_hover", "lsp_defs" \]/);
});

// ── Contract 8: collision — generated row WINS over cluster.toml hand-shell ──

test("emit-cloister-capnp: generated backend replaces hand-declared shell with same name", () => {
  const c = clusterWithMcp();
  // Add a hand-shell named "lsp" to /mcp.
  c.routes[1].kind.mcp.backends.push({
    name: "lsp",
    handlesPrefix: "lsp_",
    kind: {
      mcpProxy: {
        urlBinding: "OLD_URL",
        tools: [],
        dynamicTools: false,
        stripPrefix: "",
        requiresSession: false,
        protocolMode: "",
        serviceBinding: "",
        claims: [],
      },
    },
  });
  const lockfile = {
    generated_backends: [
      {
        input: "llo",
        name: "lsp",
        handlesPrefix: "lsp_",
        claims: ["lsp_hover"],
        dynamicTools: true,
        urlBinding: "NEW_URL",
        serviceBinding: "LSP_MCP",
      },
    ],
  };
  const out = emitCloisterCapnp(c, lockfile);
  // The generated row's URL replaces the hand-shell's.
  assert.ok(!out.includes("OLD_URL"), "hand-shell URL must be replaced by generated row");
  assert.match(out, /urlBinding      = "NEW_URL"/);
});

// ── Contract 9: no /mcp route + generated backends → synthesized /mcp ────

test("emit-cloister-capnp: lockfile with generated_backends + no /mcp route → synthesizes /mcp route", () => {
  const c = minimalCluster(); // No /mcp route.
  const lockfile = {
    generated_backends: [
      {
        input: "x",
        name: "gen",
        handlesPrefix: "g_",
        claims: ["g_a"],
        dynamicTools: true,
        urlBinding: "X_URL",
        serviceBinding: "",
      },
    ],
  };
  const out = emitCloisterCapnp(c, lockfile);
  assert.match(out, /\( path = "\/mcp",/);
  assert.match(out, /name          = "gen"/);
});

// ── Contract 10: defaults — actor + policy come from the pinned template ─

test("emit-cloister-capnp: actor + policy pinned to ART-default template (Phase 2 scope)", () => {
  const out = emitCloisterCapnp(minimalCluster());
  // Phase 3+ will let operators override these via cluster.toml; until
  // then they're carried-forward defaults that match the existing
  // ART-default cloister.capnp file at HEAD.
  assert.match(out, /fingerprint     = "sha256:placeholder-pinned-at-deploy-time"/);
  assert.match(out, /algorithm       = "ed25519"/);
  assert.match(out, /pubkeyBinding   = "INTERLACE_MASTER_PUBKEY"/);
  assert.match(out, /maxCertLifetimeSeconds = 300/);
  assert.match(out, /requireInterlock       = true/);
  assert.match(out, /minAlgorithm           = "ed25519"/);
});

// ── Contract 11: capnp text parses through `capnp eval` (smoke) ──────────
//
// This is the load-bearing structural check — if the emitter writes
// syntactically invalid capnp, every downstream emitter chokes. We don't
// shell out here (slow + capnp may not be installed in every CI shape);
// the e2e harness in scripts/test/e2e-manifest-pipeline.test.mjs does
// that. Here we just smoke-check the basic shape.

test("emit-cloister-capnp: closing tokens are balanced (count of '(' == count of ')')", () => {
  const out = emitCloisterCapnp(clusterWithMcp());
  // Stripped of comments + strings so we only count structural parens.
  const stripped = out
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
    .replace(/"[^"]*"/g, "");
  const opens = (stripped.match(/\(/g) || []).length;
  const closes = (stripped.match(/\)/g) || []).length;
  assert.equal(opens, closes, "structural paren balance is required for capnp eval to parse");
  const openBrackets = (stripped.match(/\[/g) || []).length;
  const closeBrackets = (stripped.match(/\]/g) || []).length;
  assert.equal(openBrackets, closeBrackets, "structural bracket balance is required");
});
