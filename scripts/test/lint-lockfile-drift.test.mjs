// scripts/test/lint-lockfile-drift.test.mjs
//
// Run with:  pnpm exec tsx --test scripts/test/lint-lockfile-drift.test.mjs
//
// Contract tests for scripts/lint-lockfile-drift.mjs — the drift gate
// motivated by the 2026-06-24 LLO-contract incident (cluster.lock.toml
// pinned to bytes=1_213/3-groups while LLO had advanced to bytes=2603/
// 7-groups; `query`/`wire`/`validate`/`hdc` claim sets dropped silently
// from src/generated/manifest.ts until an operator noticed by hand).
//
// Tests synthesize a cluster.toml + cluster.lock.toml + source file in
// a tmpdir, point LINT_LOCKFILE_CLUSTER_TOML + LINT_LOCKFILE_LOCKFILE_TOML
// at them, and spawn the script.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-lockfile-drift.mjs");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeFixture({ clusterToml, lockToml, sourceBody }) {
  const dir = mkdtempSync(resolve(tmpdir(), "lockfile-drift-lint-"));
  const sourcePath = resolve(dir, "source.json");
  if (sourceBody !== undefined) writeFileSync(sourcePath, sourceBody);
  const clusterPath = resolve(dir, "cluster.toml");
  const lockPath = resolve(dir, "cluster.lock.toml");
  writeFileSync(clusterPath, clusterToml.replaceAll("{SOURCE}", sourcePath));
  writeFileSync(lockPath, lockToml.replaceAll("{SOURCE}", sourcePath));
  return {
    dir,
    sourcePath,
    clusterPath,
    lockPath,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function runLint({ clusterPath, lockPath }) {
  return spawnSync(TSX_BIN, [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LINT_LOCKFILE_CLUSTER_TOML: clusterPath,
      LINT_LOCKFILE_LOCKFILE_TOML: lockPath,
    },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test("matching sha256 → exit 0", () => {
  const body = `{"hello":"world"}`;
  const fixture = makeFixture({
    sourceBody: body,
    clusterToml: `[inputs.llo]\nref = "x"\nfrom = "file://{SOURCE}"\n`,
    lockToml:    `[inputs.llo]\nsha256 = "${sha256(body)}"\n`,
  });
  try {
    const r = runLint(fixture);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /1 file:\/\/ input\(s\) verified/);
  } finally {
    fixture.cleanup();
  }
});

test("source bytes changed but lockfile stale → exit 1 with fix hint", () => {
  const oldBody = `{"v":1}`;
  const newBody = `{"v":2,"more":"data"}`;
  const fixture = makeFixture({
    sourceBody: newBody,
    clusterToml: `[inputs.llo]\nref = "x"\nfrom = "file://{SOURCE}"\n`,
    lockToml:    `[inputs.llo]\nsha256 = "${sha256(oldBody)}"\n`,
  });
  try {
    const r = runLint(fixture);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /1 drift\(s\) detected/);
    assert.match(r.stderr, /lockfile sha256 .* ≠ source sha256/);
    assert.match(r.stderr, /task cluster:resolve/);
  } finally {
    fixture.cleanup();
  }
});

test("input in cluster.toml but missing from lockfile → exit 1", () => {
  const body = `{"hello":"world"}`;
  const fixture = makeFixture({
    sourceBody: body,
    clusterToml: `[inputs.llo]\nref = "x"\nfrom = "file://{SOURCE}"\n`,
    lockToml:    `# empty\n`,
  });
  try {
    const r = runLint(fixture);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing from cluster\.lock\.toml/);
  } finally {
    fixture.cleanup();
  }
});

test("non-existent source path → exit 0 with skip-warn (CI / cross-checkout safety)", () => {
  // file:// inputs often point at developer-local checkouts not
  // present on CI. The lint warns and skips rather than failing —
  // see the script header for the rationale.
  const fixture = makeFixture({
    sourceBody: undefined,
    clusterToml: `[inputs.llo]\nref = "x"\nfrom = "file://{SOURCE}"\n`,
    lockToml:    `[inputs.llo]\nsha256 = "sha256:0000"\n`,
  });
  try {
    const r = runLint(fixture);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /not present in this checkout — skipping/);
    assert.match(r.stdout, /0 file:\/\/ input\(s\) verified/);
  } finally {
    fixture.cleanup();
  }
});

test("https:// input ignored (network-fetched) → exit 0", () => {
  const fixture = makeFixture({
    sourceBody: "",
    clusterToml: `[inputs.upstream]\nref = "x"\nfrom = "https://example.com/server.json"\n`,
    lockToml:    `[inputs.upstream]\nsha256 = "sha256:deadbeef"\n`,
  });
  try {
    const r = runLint(fixture);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /0 file:\/\/ input\(s\) verified/);
  } finally {
    fixture.cleanup();
  }
});

test("multiple file:// inputs, one drifted → exit 1 only on the drifted one", () => {
  const goodBody = `{"v":"good"}`;
  const driftedActual = `{"v":"changed"}`;
  const driftedOld = `{"v":"old"}`;

  const dir = mkdtempSync(resolve(tmpdir(), "lockfile-drift-lint-multi-"));
  try {
    const goodPath = resolve(dir, "good.json");
    const driftedPath = resolve(dir, "drifted.json");
    writeFileSync(goodPath, goodBody);
    writeFileSync(driftedPath, driftedActual);
    const clusterPath = resolve(dir, "cluster.toml");
    const lockPath = resolve(dir, "cluster.lock.toml");
    writeFileSync(
      clusterPath,
      `[inputs.good]\nref = "a"\nfrom = "file://${goodPath}"\n[inputs.drifted]\nref = "b"\nfrom = "file://${driftedPath}"\n`,
    );
    writeFileSync(
      lockPath,
      `[inputs.good]\nsha256 = "${sha256(goodBody)}"\n[inputs.drifted]\nsha256 = "${sha256(driftedOld)}"\n`,
    );

    const r = runLint({ clusterPath, lockPath });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1 drift\(s\) detected/);
    assert.match(r.stderr, /✘ drifted:/);
    assert.doesNotMatch(r.stderr, /✘ good:/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
