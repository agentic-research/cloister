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

// ── Contract 7: lockfile injection is a SEPARATE layer (build-manifest.mjs) ──
//
// The Phase 2 design keeps the [[generated_backends]] overlay where it
// already lives — `scripts/build-manifest.mjs:overlayLockfileBackends`.
// THIS emitter writes only the cluster.toml-declared routes. If we
// merged lockfile rows here too, build-manifest would see them as
// hand-shell collisions on every regeneration. Keep the layers
// separate; one source of truth per overlay.
//
// (The pre-Commit-3 iteration injected lockfile rows; we backed that
// out after observing the double-overlay collision in real
// `task manifest` runs. Documented for the next person who's tempted
// to re-add the injection — they'd hit the same problem.)
//
// No assertion here — the contract is documented absence, not a
// behavior to test.

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
