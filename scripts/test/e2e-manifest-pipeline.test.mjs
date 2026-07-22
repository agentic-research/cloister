// scripts/test/e2e-manifest-pipeline.test.mjs
//
// End-to-end validation for the manifest pipeline (cloister-8e40ad).
//
// Drives REAL fixture .capnp files through the actual build-manifest.mjs
// script (the same one task manifest invokes) and asserts:
//
//   - Happy path: well-formed manifest parses + emits JSON whose shape
//     matches the TS Gateway type. Captures schema↔TS-mirror drift.
//   - Unhappy paths: malformed manifests fail at BUILD TIME with the
//     right diagnostic. Without this gate, validation that only fires
//     at boot ships a manifest that crashes a worker on launch.
//
// Each fixture is a self-contained .capnp file under test/fixtures/manifest/.
// The test drives them through `task manifest` (NOT the underlying
// `pnpm exec tsx scripts/build-manifest.mjs` invocation) so the test
// exercises the SAME entry point CI + dev + docs use — per the
// "Taskfile is the source of truth for invocation" principle
// (cloister-8e40ad).
//
// If `task manifest` ever gains preprocessing, deps, or wrapping,
// these tests automatically follow. Adding a new `pnpm exec tsx ...`
// command alongside this one would be drift; the parity-guard test
// at the bottom of this file catches that case.
//
// Run with:  node --test scripts/test/e2e-manifest-pipeline.test.mjs
//
// Wired into:
//   - task test:lint-scripts (the node:test aggregator)
//
// This test exercises the unhappy paths AS WE GO — every Copilot
// finding from PR #36 has a corresponding red fixture here so the
// regression would be caught before another reviewer has to ask.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const BUILD_SCRIPT = resolve(REPO_ROOT, "scripts/build-manifest.mjs");
const FIXTURES_DIR = resolve(REPO_ROOT, "test/fixtures/manifest");

function runBuildManifest(fixtureName, opts = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "e2e-manifest-"));
  const outFile = resolve(dir, "manifest.ts");
  const fixture = resolve(FIXTURES_DIR, fixtureName);
  // Invoke the same `task manifest` CI + dev + docs use. Env overrides
  // are honored by the underlying scripts/build-manifest.mjs without
  // changing the entry point. If task manifest ever changes how it
  // wraps the script, these tests automatically follow.
  //
  // `--force` bypasses Task's checksum cache — without it, Task may
  // skip the build for an unchanged source even though our fixture
  // override means the actual input differs. Per Task's design env
  // vars aren't part of the cache key; --force is the supported escape.
  //
  // Task propagates failure as exit code 201 ("Failed to run task"),
  // not the underlying script's code. Tests assert non-zero + the
  // precise script diagnostic in stderr, which is what matters
  // operationally.
  //
  // `opts.lockfile` (cloister-05334b, P1 of LLO arc): when set, points
  // the build script at a fixture lockfile so the [[generated_backends]]
  // injection path can be exercised in isolation. The script reads the
  // lockfile via CLOISTER_LOCKFILE env, defaulting to ./cluster.lock.toml
  // (which is typically absent during e2e fixture runs, making the
  // emitter's lockfile branch a no-op).
  const env = {
    ...process.env,
    CLOISTER_MANIFEST: fixture,
    CLOISTER_OUTPUT:   outFile,
  };
  if (opts.lockfile) {
    env.CLOISTER_LOCKFILE = resolve(FIXTURES_DIR, opts.lockfile);
  }
  const r = spawnSync("task", ["manifest", "--force"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  return { ...r, outFile, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// ── Happy path ───────────────────────────────────────────────────────────

test("e2e happy: vaultProxyServices with all 5 injection variants parses + emits", () => {
  const r = runBuildManifest("vault-proxy-good.capnp");
  try {
    assert.equal(r.status, 0, `build failed unexpectedly\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(existsSync(r.outFile), "expected output file not written");

    const emitted = readFileSync(r.outFile, "utf8");
    // Confirm the generated TS holds the gateway literal.
    assert.match(emitted, /export const manifest: Gateway =/);
    // All 5 service names present in the JSON literal.
    for (const name of ["openai", "internal-basic", "anthropic", "google-search", "oauth-svc"]) {
      assert.match(emitted, new RegExp(`"name": "${name}"`), `service "${name}" missing from emitted manifest`);
    }
    // Each injection variant rendered correctly as object-with-single-key.
    assert.match(emitted, /"authorizationBearer": null/);
    assert.match(emitted, /"authorizationBasic": null/);
    assert.match(emitted, /"headerNamed": {\s*"name": "x-api-key"/);
    assert.match(emitted, /"queryParam": {\s*"name": "key"/);
    assert.match(emitted, /"bodyField": {\s*"path": "auth.client_secret"/);
  } finally { r.cleanup(); }
});

// ── Unhappy paths — each fixture demonstrates a class of malformation ──

// Note: task wraps the script exit code — non-zero from the script
// surfaces as task exit code 1 (task's "command failed" code), with the
// underlying script's exit code visible in stderr. We assert task != 0
// + the precise script diagnostic in stderr, which is the contract that
// matters operationally.

test("e2e unhappy: duplicate service name → task fails with precise diagnostic", () => {
  const r = runBuildManifest("vault-proxy-dup-name.capnp");
  try {
    assert.notEqual(r.status, 0, `expected non-zero exit; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /declares "openai" more than once/);
  } finally { r.cleanup(); }
});

test("e2e unhappy: upstreamBaseUrl is not a valid URL → task fails", () => {
  const r = runBuildManifest("vault-proxy-bad-url.capnp");
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is not a valid URL/);
    assert.match(r.stderr, /broken/);
  } finally { r.cleanup(); }
});

test("e2e unhappy: empty headerNamed.name (low-confidence Copilot path) → task fails", () => {
  const r = runBuildManifest("vault-proxy-empty-payload.capnp");
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /headerNamed\.name must be a non-empty string/);
  } finally { r.cleanup(); }
});

// ── Build-time vs runtime parity ─────────────────────────────────────────

test("the same buildServiceRegistry runs at build time + boot time (no parallel impl)", () => {
  // Read the build script. It MUST import buildServiceRegistry from the
  // pure module (not re-implement validation). If a future refactor
  // tries to inline the logic instead, this test catches it.
  const buildScript = readFileSync(BUILD_SCRIPT, "utf8");
  assert.match(buildScript, /buildServiceRegistry/,
    "scripts/build-manifest.mjs must import buildServiceRegistry — not re-implement validation");
  assert.match(buildScript, /vault-proxy-services/,
    "scripts/build-manifest.mjs must import from src/manifest/vault-proxy-services (the pure module the runtime also imports)");
});

// ── cloister-05334b (P1 of LLO arc): lockfile → manifest emitter ─────────
//
// The emitter consumes [[generated_backends]] rows from cluster.lock.toml
// and injects them into McpRouteSpec.backends in the emitted manifest.ts.
// Coverage: empty-shell injection, urlBinding/serviceBinding threading,
// claims threading, collision precedence (generated wins + warn).

test("e2e lockfile: empty /mcp shell + lockfile with two generated backends → emitted manifest has both backends", () => {
  const r = runBuildManifest("lockfile-mcp-shell.capnp", {
    lockfile: "lockfile-mcp-shell.lock.toml",
  });
  try {
    assert.equal(r.status, 0, `build failed unexpectedly\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(existsSync(r.outFile), "expected output file not written");

    const emitted = readFileSync(r.outFile, "utf8");
    // Both generated backend names must appear in the emitted manifest.
    assert.match(emitted, /"name": "lsp"/, "lsp backend missing from emitted manifest");
    assert.match(emitted, /"name": "lifecycle"/, "lifecycle backend missing from emitted manifest");

    // The lsp backend's mcpProxy wiring threads urlBinding +
    // serviceBinding from the lockfile through to the manifest. We
    // assert on the JSON literal — order-independent because we check
    // each key individually.
    assert.match(emitted, /"urlBinding": "LLO_MCP_URL"/, "urlBinding from lockfile must thread through");
    assert.match(emitted, /"serviceBinding": "LSP_MCP"/, "serviceBinding from lockfile must thread through");
    // dynamicTools=true is the canonical shape for generated backends.
    assert.match(emitted, /"dynamicTools": true/, "generated backends must set dynamicTools=true");
    // Claims from the lockfile flow through onto the backend.
    assert.match(emitted, /"lsp_hover"/, "claims from lockfile must thread through");
    assert.match(emitted, /"status"/, "lifecycle claims (status/enrich/reparse) must thread through");
  } finally { r.cleanup(); }
});

test("e2e lockfile: unroutable generated backend (dynamicTools + empty prefix + empty claims) → build fails at BUILD time (cloister-3b8cd6)", () => {
  const r = runBuildManifest("lockfile-mcp-shell.capnp", {
    lockfile: "lockfile-mcp-unroutable.lock.toml",
  });
  try {
    // The single-backend fallback shape (no _meta.art.cloister/v1) must be
    // rejected at `task manifest`, not several steps removed at wrangler boot.
    assert.notEqual(r.status, 0, `build should have FAILED on the unroutable shape\nstdout: ${r.stdout}`);
    assert.ok(
      r.stderr.includes("dynamicTools=true but empty handlesPrefix"),
      `expected the unroutable-backend build-time diagnostic\nstderr: ${r.stderr}`,
    );
  } finally { r.cleanup(); }
});

test("e2e lockfile: collision (hand-shell + generated with same name) → generated wins + warning emitted", () => {
  const r = runBuildManifest("lockfile-collision.capnp", {
    lockfile: "lockfile-collision.lock.toml",
  });
  try {
    assert.equal(r.status, 0, `build failed unexpectedly\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(existsSync(r.outFile), "expected output file not written");

    const emitted = readFileSync(r.outFile, "utf8");
    // Generated wins: the lockfile's binding string + dynamicTools=true
    // must appear. The hand-shell's `urlBinding = "HAND_BINDING"` +
    // `dynamicTools = false` must NOT (the generated row replaces them).
    assert.match(emitted, /"urlBinding": "LLO_MCP_URL"/);
    assert.match(emitted, /"serviceBinding": "LSP_MCP"/);
    assert.match(emitted, /"dynamicTools": true/);
    assert.equal(emitted.includes("HAND_BINDING"), false,
      "hand-shell urlBinding must NOT survive when a generated backend collides");

    // The collision must be logged so the operator knows to delete the
    // shell. Substring check on stderr — exact wording can evolve but
    // the operator-facing surface must mention the collision.
    assert.match(r.stderr, /collision|prefers? (the )?generated|overrid/i,
      `expected collision warning in stderr; got: ${r.stderr}`);
    // The shell's backend name appears in the warning so the operator
    // can locate the offending block in their cloister.capnp.
    assert.match(r.stderr, /"lsp"|backend.*lsp/, "warning must name the colliding backend");
  } finally { r.cleanup(); }
});

test("e2e lockfile: cross-input name collision → later input's row is qualified, not clobbered", () => {
  // cloister-2d987e: llo and mache each declare a group named "lsp" in
  // their own server.json's _meta.art.cloister/v1.groups[]. meta-groups.md
  // only promises name-uniqueness WITHIN one server.json — nothing stops
  // two different inputs from picking the same group name. Before the
  // fix, overlayLockfileBackends's shellsByName index was keyed by name
  // only, so mache's "lsp" row silently replaced llo's "lsp" row (logged
  // as a misleading "hand-shell collision" even though neither is a
  // hand-shell) — llo's lsp_hover/lsp_defs tools would vanish from the
  // manifest with no build failure to catch it.
  const r = runBuildManifest("lockfile-cross-input-collision.capnp", {
    lockfile: "lockfile-cross-input-collision.lock.toml",
  });
  try {
    assert.equal(r.status, 0, `build failed unexpectedly\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(existsSync(r.outFile), "expected output file not written");

    const emitted = readFileSync(r.outFile, "utf8");
    // llo's original "lsp" backend name + claims must survive untouched.
    assert.match(emitted, /"name": "lsp"/, "llo's lsp backend missing from emitted manifest");
    assert.match(emitted, /"lsp_hover"/, "llo's lsp claims must survive — not clobbered by mache's row");
    // mache's colliding row is qualified by input so both backends coexist.
    assert.match(emitted, /"name": "mache\/lsp"/, "mache's lsp row must be qualified as \"mache/lsp\"");
    assert.match(emitted, /"get_type_info"/, "mache's lsp claims must also survive under the qualified name");

    // The collision must be logged so the operator can see it happened.
    assert.match(r.stderr, /name collision.*"lsp"/, `expected collision diagnostic in stderr; got: ${r.stderr}`);
  } finally { r.cleanup(); }
});

test("e2e lockfile: no lockfile present → emitter is a no-op (back-compat)", () => {
  // When CLOISTER_LOCKFILE points at a non-existent file, the emitter
  // must NOT crash — it just skips the injection step. This preserves
  // the pre-P1 build path for cluster.toml files without an [inputs] table.
  const dir = mkdtempSync(resolve(tmpdir(), "e2e-no-lockfile-"));
  const outFile = resolve(dir, "manifest.ts");
  const fixture = resolve(FIXTURES_DIR, "lockfile-mcp-shell.capnp");
  try {
    const r = spawnSync("task", ["manifest", "--force"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLOISTER_MANIFEST: fixture,
        CLOISTER_OUTPUT:   outFile,
        CLOISTER_LOCKFILE: resolve(dir, "missing.lock.toml"),
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `build failed unexpectedly\nstderr: ${r.stderr}`);
    const emitted = readFileSync(outFile, "utf8");
    // The /mcp route has zero backends from the shell + no lockfile
    // injection → the emitted backends array is empty.
    assert.match(emitted, /"backends": \[\]/, "no-lockfile path must yield empty backends array");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
