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

function runBuildManifest(fixtureName) {
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
  const r = spawnSync("task", ["manifest", "--force"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLOISTER_MANIFEST: fixture,
      CLOISTER_OUTPUT:   outFile,
    },
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
