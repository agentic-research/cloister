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

test("emit-cloister-capnp: gateway vaultProxyServices emit into Cloister.Gateway", () => {
  const c = minimalCluster();
  c.gateway = {
    metadata: { name: "cloister-harness", version: "0.1.0" },
    actor: { fingerprint: "", algorithm: "ed25519", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
    policy: { maxCertLifetimeSeconds: 300, requireInterlock: false, minAlgorithm: "ed25519" },
    vaultProxyServices: [
      {
        name: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
        defaultAllowedSubs: ["sha256:harness:*"],
        rateLimitPerMinute: 120,
        injection: { headerNamed: { name: "x-api-key" } },
      },
      {
        name: "anthropic-compatible",
        upstreamBaseUrl: "https://gw.example/anthropic",
        defaultAllowedSubs: [],
        rateLimitPerMinute: 60,
        injection: { authorizationBearer: null },
      },
    ],
  };
  const out = emitCloisterCapnp(c);
  assert.match(out, /vaultProxyServices = \[/);
  assert.match(out, /name = "anthropic"/);
  assert.match(out, /upstreamBaseUrl = "https:\/\/api\.anthropic\.com"/);
  assert.match(out, /defaultAllowedSubs = \["sha256:harness:\*"\]/);
  assert.match(out, /injection = \(headerNamed = \(name = "x-api-key"\)\)/);
  assert.match(out, /name = "anthropic-compatible"/);
  assert.match(out, /injection = \(authorizationBearer = void\)/);
});

// ── Contract 5b: tenantDispatch variant (ADR-0030 §A2 / cloister-0f144c) ──

test("emit-cloister-capnp: tenantDispatch variant emits tenants table with name/mode/matchValue/binding", () => {
  // Per ADR-0030 §A2: per-tenant SNI + path-prefix dispatch. The runtime
  // class (TenantDispatchRoute) exists; the operator-facing emission to
  // cloister.capnp lands here so the manifest pipeline can ship a
  // multi-tenant config end-to-end.
  const c = minimalCluster();
  c.routes.push({
    path: "/",
    kind: {
      tenantDispatch: {
        tenants: [
          { name: "alice", mode: "sni",         matchValue: "alice.cluster.example", binding: "T_ALICE" },
          { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",                 binding: "T_BOB"   },
        ],
      },
    },
  });
  const out = emitCloisterCapnp(c);
  // Variant marker emitted.
  assert.match(out, /kind = \(tenantDispatch = \(/);
  // Inline tenants list with each row's four fields.
  assert.match(out, /name       = "alice"/);
  assert.match(out, /mode       = "sni"/);
  assert.match(out, /matchValue = "alice.cluster.example"/);
  assert.match(out, /binding    = "T_ALICE"/);
  assert.match(out, /name       = "bob"/);
  assert.match(out, /mode       = "path-prefix"/);
  assert.match(out, /matchValue = "\/t\/bob"/);
  assert.match(out, /binding    = "T_BOB"/);
});

test("emit-cloister-capnp: tenantDispatch with empty tenants list emits an empty array (operator can ship a placeholder)", () => {
  const c = minimalCluster();
  c.routes.push({
    path: "/",
    kind: { tenantDispatch: { tenants: [] } },
  });
  const out = emitCloisterCapnp(c);
  assert.match(out, /tenants = \[/);
  // Empty list still produces a valid capnp List(TenantDispatchRow) syntax.
  // The runtime's compileDispatchTable will accept an empty table (no
  // routes match → request falls through), so the emitter doesn't
  // pre-validate operator intent here.
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
  // Default is the EMPTY opt-out, not a truthy placeholder: a non-empty
  // fingerprint is published verbatim on /.well-known/interlace/index.json,
  // so the old "sha256:placeholder-pinned-at-deploy-time" default sailed past
  // the empty-check opt-out and advertised a fabricated identity.
  assert.match(out, /fingerprint     = ""/);
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

// ── Phase 4a (cloister-c919d7 / ADR-0031): emitter consumes [gateway] ────

function clusterWithGateway(gateway) {
  return {
    metadata: { name: "with-gateway", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [{ path: "/health", kind: { health: null } }],
    gateway,
  };
}

test("Phase 4a: missing gateway field → fall through to ART-default + warn on stderr", () => {
  // Pre-Phase-4a cluster.toml back-compat: the emitter's
  // `isEmptyGateway` predicate triggers fall-through when the gateway
  // is undefined OR all-empty. Output matches the Phase 2 hardcoded
  // template byte-for-byte.
  const out = emitCloisterCapnp(minimalCluster(), { quiet: true });
  assert.match(out, /metadata = \(name = "cloister-art", version = "0\.1\.0"\)/);
  // Default is the EMPTY opt-out, not a truthy placeholder: a non-empty
  // fingerprint is published verbatim on /.well-known/interlace/index.json,
  // so the old "sha256:placeholder-pinned-at-deploy-time" default sailed past
  // the empty-check opt-out and advertised a fabricated identity.
  assert.match(out, /fingerprint     = ""/);
  assert.match(out, /requireInterlock       = true/);
});

test("Phase 4a: populated [gateway] → operator values land verbatim", () => {
  const out = emitCloisterCapnp(clusterWithGateway({
    metadata: { name: "cloister-custom", version: "1.2.3" },
    actor: {
      fingerprint:     "sha256:deadbeef",
      algorithm:       "ml-dsa-44",
      pubkeyBinding:   "MY_PUBKEY",
      attestationRepo: "https://example.com/chain",
      tunnelEndpoint:  "tunnel.example.com",
    },
    policy: {
      maxCertLifetimeSeconds: 600,
      requireInterlock:       false,
      minAlgorithm:           "ml-dsa-44",
    },
  }), { quiet: true });
  // Operator-authored metadata + actor + policy must render unchanged.
  assert.match(out, /metadata = \(name = "cloister-custom", version = "1\.2\.3"\)/);
  assert.match(out, /fingerprint     = "sha256:deadbeef"/);
  assert.match(out, /algorithm       = "ml-dsa-44"/);
  assert.match(out, /pubkeyBinding   = "MY_PUBKEY"/);
  assert.match(out, /attestationRepo = "https:\/\/example\.com\/chain"/);
  assert.match(out, /tunnelEndpoint  = "tunnel\.example\.com"/);
  assert.match(out, /maxCertLifetimeSeconds = 600/);
  assert.match(out, /requireInterlock       = false/);
  assert.match(out, /minAlgorithm           = "ml-dsa-44"/);
});

test("Phase 4a: oss-launch-minimal shape (empty fingerprint to disable Interlace) lands verbatim", () => {
  // Critical regression test: oss-launch-minimal explicitly sets
  // `actor.fingerprint = ""` + `actor.pubkeyBinding = ""` to disable
  // the `.well-known/interlace/` discovery doc. A naive field-level
  // merge would clobber those explicit empty values with the
  // placeholder template; this test pins the verbatim-pass behavior.
  const out = emitCloisterCapnp(clusterWithGateway({
    metadata: { name: "cloister-oss-minimal", version: "0.1.0" },
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
  }), { quiet: true });
  assert.match(out, /fingerprint     = ""/);
  assert.match(out, /pubkeyBinding   = ""/);
  assert.match(out, /requireInterlock       = false/);
  // Negative: the ART-default placeholder must NOT appear.
  assert.doesNotMatch(out, /sha256:placeholder-pinned-at-deploy-time/);
  assert.doesNotMatch(out, /INTERLACE_MASTER_PUBKEY/);
});

test("Phase 4a: byte-stable across two emit calls with populated gateway", () => {
  const c = clusterWithGateway({
    metadata: { name: "cloister-bytes", version: "0.0.1" },
    actor: {
      fingerprint:     "sha256:cafebabe",
      algorithm:       "ed25519",
      pubkeyBinding:   "INTERLACE_MASTER_PUBKEY",
      attestationRepo: "",
      tunnelEndpoint:  "",
    },
    policy: {
      maxCertLifetimeSeconds: 300,
      requireInterlock:       true,
      minAlgorithm:           "ed25519",
    },
  });
  const a = emitCloisterCapnp(c, { quiet: true });
  const b = emitCloisterCapnp(c, { quiet: true });
  assert.equal(a, b, "byte-stable output across runs is the drift-gate invariant");
});

test("Phase 4a: quiet option suppresses the fall-through warning", () => {
  // Sanity check the quiet path — used by drift gate / tests where
  // stderr is asserted-on separately. Default path emits to stderr;
  // quiet must not.
  const origWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk) => { buf += String(chunk); return true; };
  try {
    emitCloisterCapnp(minimalCluster(), { quiet: true });
    assert.equal(buf, "", "quiet mode must not write to stderr");
  } finally {
    process.stderr.write = origWrite;
  }
});
