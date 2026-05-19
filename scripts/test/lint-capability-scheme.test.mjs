// scripts/test/lint-capability-scheme.test.mjs
//
// Run with:  pnpm exec tsx --test scripts/test/lint-capability-scheme.test.mjs
//
// Direct unit tests for `validateLane3Shape` (no I/O) + integration
// tests that synthesize a `cluster.ts` and invoke the lint as a
// subprocess. Mirrors the test shape of lint-bundle-isolation.test.mjs.
//
// Per cloister-308ea4 (ADR-0028 §6).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateLane3Shape, collectViolations } from "../lint-capability-scheme.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-capability-scheme.mjs");

// ── Unit: validateLane3Shape — well-formed values ────────────────────────

test("validateLane3Shape: accepts canonical cloister/<name>/v<n>", () => {
  assert.equal(validateLane3Shape("cloister/credential-isolation/v1"), null);
  assert.equal(validateLane3Shape("cloister/bead-store/v2"), null);
  assert.equal(validateLane3Shape("cloister/interlace-discovery/v1"), null);
});

test("validateLane3Shape: accepts multi-digit version", () => {
  assert.equal(validateLane3Shape("cloister/x/v10"), null);
  assert.equal(validateLane3Shape("cloister/x/v100"), null);
});

test("validateLane3Shape: accepts digest-pinned ref (ADR-0027)", () => {
  assert.equal(
    validateLane3Shape("cloister/bead-store/v1@sha256:abcd1234"),
    null,
  );
  assert.equal(
    validateLane3Shape("cloister/x/v1@digest-with-any-opaque-bytes"),
    null,
  );
});

test("validateLane3Shape: accepts digits in name segment", () => {
  assert.equal(validateLane3Shape("cloister/oauth2-bridge/v1"), null);
});

// ── Unit: validateLane3Shape — lane-1 + lane-2 leakage ───────────────────

test("validateLane3Shape: rejects lane-1 URN with named explanation", () => {
  const result = validateLane3Shape("urn:signet:cap:sign:artifact");
  assert.ok(result, "expected non-null violation");
  assert.ok(result.includes("lane-1 URN"));
  assert.ok(result.includes("cert"));
});

test("validateLane3Shape: rejects lane-2 WIMSE URI with named explanation", () => {
  const result = validateLane3Shape("wimse://cluster.example/bundles/router");
  assert.ok(result, "expected non-null violation");
  assert.ok(result.includes("lane-2 WIMSE"));
  assert.ok(result.includes("workload identity"));
});

// ── Unit: validateLane3Shape — malformed values ──────────────────────────

test("validateLane3Shape: rejects empty string", () => {
  assert.ok(validateLane3Shape("")?.includes("empty"));
});

test("validateLane3Shape: rejects missing cloister/ prefix", () => {
  const result = validateLane3Shape("bead-store/v1");
  assert.ok(result?.includes("does not start with"));
});

test("validateLane3Shape: rejects missing /v<n> suffix", () => {
  const result = validateLane3Shape("cloister/bead-store");
  assert.ok(result?.includes("/v"));
});

test("validateLane3Shape: rejects empty version", () => {
  const result = validateLane3Shape("cloister/bead-store/v");
  assert.ok(result?.includes("empty version"));
});

test("validateLane3Shape: rejects non-digit version", () => {
  const result = validateLane3Shape("cloister/bead-store/vAlpha");
  assert.ok(result?.includes("non-digit"));
});

test("validateLane3Shape: rejects nested-path name", () => {
  const result = validateLane3Shape("cloister/nested/path/v1");
  assert.ok(result?.includes("slash"));
});

test("validateLane3Shape: rejects upper-case in name", () => {
  const result = validateLane3Shape("cloister/BeadStore/v1");
  assert.ok(result?.includes("non-kebab"));
});

test("validateLane3Shape: rejects underscore in name", () => {
  const result = validateLane3Shape("cloister/bead_store/v1");
  assert.ok(result?.includes("non-kebab"));
});

test("validateLane3Shape: rejects leading hyphen", () => {
  const result = validateLane3Shape("cloister/-x/v1");
  assert.ok(result?.includes("leading hyphen"));
});

test("validateLane3Shape: rejects trailing hyphen", () => {
  const result = validateLane3Shape("cloister/x-/v1");
  assert.ok(result?.includes("trailing hyphen"));
});

test("validateLane3Shape: rejects doubled hyphen", () => {
  const result = validateLane3Shape("cloister/x--y/v1");
  assert.ok(result?.includes("doubled hyphen"));
});

test("validateLane3Shape: rejects trailing @ with empty digest", () => {
  const result = validateLane3Shape("cloister/x/v1@");
  assert.ok(result?.includes("trailing @"));
});

test("validateLane3Shape: rejects non-string input", () => {
  assert.ok(validateLane3Shape(null)?.includes("not a string"));
  assert.ok(validateLane3Shape(42)?.includes("not a string"));
  assert.ok(validateLane3Shape(undefined)?.includes("not a string"));
});

// ── Unit: collectViolations — cluster walking ────────────────────────────

test("collectViolations: clean cluster yields empty array", () => {
  const cluster = {
    inputs: [
      {
        name: "bead-store",
        provides: ["cloister/bead-store/v1"],
        requires: [],
      },
      {
        name: "vault-proxy",
        provides: ["cloister/credential-isolation/v1"],
        requires: ["cloister/sign-helper/v1"],
      },
    ],
  };
  assert.deepEqual(collectViolations(cluster), []);
});

test("collectViolations: missing inputs[] field yields empty array", () => {
  assert.deepEqual(collectViolations({}), []);
  assert.deepEqual(collectViolations({ inputs: [] }), []);
});

test("collectViolations: reports the input + slot + value + problem", () => {
  const cluster = {
    inputs: [
      {
        name: "bad-tool",
        provides: ["urn:signet:cap:sign:artifact"],
        requires: [],
      },
    ],
  };
  const violations = collectViolations(cluster);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].input, "bad-tool");
  assert.equal(violations[0].slot, "provides");
  assert.equal(violations[0].value, "urn:signet:cap:sign:artifact");
  assert.ok(violations[0].problem.includes("lane-1"));
});

test("collectViolations: walks both provides AND requires", () => {
  const cluster = {
    inputs: [
      {
        name: "tool",
        provides: ["wimse://x/y/z"],
        requires: ["bead-store/v1"],
      },
    ],
  };
  const violations = collectViolations(cluster);
  assert.equal(violations.length, 2);
  const slots = violations.map((v) => v.slot).sort();
  assert.deepEqual(slots, ["provides", "requires"]);
});

test("collectViolations: missing input name renders as <unnamed>", () => {
  const cluster = {
    inputs: [{ provides: ["bad-shape"], requires: [] }],
  };
  const violations = collectViolations(cluster);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].input, "<unnamed>");
});

// ── Integration: subprocess invocation ───────────────────────────────────

function writeClusterTs(dir, cluster) {
  const path = resolve(dir, "cluster.ts");
  writeFileSync(path, `export const cluster = ${JSON.stringify(cluster, null, 2)};\n`);
  return path;
}

function runLintSubprocess(clusterTsPath) {
  return spawnSync(
    "pnpm",
    ["exec", "tsx", LINT_SCRIPT],
    {
      env: { ...process.env, CLUSTER_TS: clusterTsPath },
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
}

test("integration: clean cluster exits 0 with clean message", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "lint-cap-scheme-"));
  try {
    const tsPath = writeClusterTs(dir, {
      inputs: [
        { name: "tool", provides: ["cloister/x/v1"], requires: [] },
      ],
    });
    const result = runLintSubprocess(tsPath);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("clean"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: violation exits 1 with lane explanation in stderr", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "lint-cap-scheme-"));
  try {
    const tsPath = writeClusterTs(dir, {
      inputs: [
        {
          name: "bad",
          provides: ["urn:signet:cap:sign:x", "wimse://a/b/c"],
          requires: [],
        },
      ],
    });
    const result = runLintSubprocess(tsPath);
    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.ok(result.stderr.includes("lane-1"));
    assert.ok(result.stderr.includes("lane-2"));
    assert.ok(result.stderr.includes("Lane discipline"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: missing cluster.ts exits 2", () => {
  const result = runLintSubprocess("/does/not/exist/cluster.ts");
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("not found"));
});
