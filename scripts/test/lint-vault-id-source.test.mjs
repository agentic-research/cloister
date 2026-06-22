// scripts/test/lint-vault-id-source.test.mjs
//
// Run with:  node --test scripts/test/lint-vault-id-source.test.mjs
//
// Contract tests for scripts/lint-vault-id-source.mjs — the forward-guard
// lint that protects ADR-0021's `idFromName(bundleIdName)` invariant by
// rejecting any `.newUniqueId(` call inside vault-touching source files.
//
// Per cloister-93b0c2 (C6 of adversarial cycle 2026-06-22). The lint is
// defensive: today no code violates the invariant, but the bead exists
// precisely to keep that property load-bearing under future drift.
//
// Tests synthesize tmp .ts files, point VAULT_ID_SOURCE_FILES at them,
// and spawn the script.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-vault-id-source.mjs");

function makeFixture(files) {
  const dir = mkdtempSync(resolve(tmpdir(), "vault-id-lint-"));
  const paths = [];
  for (const [name, body] of Object.entries(files)) {
    const p = resolve(dir, name);
    writeFileSync(p, body);
    paths.push(p);
  }
  return { dir, paths, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function runLint(filesEnv) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, VAULT_ID_SOURCE_FILES: filesEnv },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test("clean file using idFromName → exit 0", () => {
  const fixture = makeFixture({
    "vault-store.ts": `
      const stub = ns.get(ns.idFromName(this.bundleIdName));
    `,
  });
  try {
    const r = runLint(fixture.paths.join(":"));
    assert.equal(r.status, 0, `expected pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /clean/);
  } finally {
    fixture.cleanup();
  }
});

test("file with `.newUniqueId(` → exit 1 with file + line in stderr", () => {
  const fixture = makeFixture({
    "drift.ts": `// pretend this is a refactored vault file
const stub = ns.get(ns.newUniqueId());  // drift: violates ADR-0021
`,
  });
  try {
    const r = runLint(fixture.paths.join(":"));
    assert.equal(r.status, 1, `expected fail; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /1 violation/);
    assert.match(r.stderr, /drift\.ts:2/);
    assert.match(r.stderr, /idFromName/);
    assert.match(r.stderr, /ADR-0021/);
    assert.match(r.stderr, /cloister-93b0c2/);
  } finally {
    fixture.cleanup();
  }
});

test("`.newUniqueId(` with whitespace before paren is still caught (`.newUniqueId  (`)", () => {
  const fixture = makeFixture({
    "spaced.ts": `const x = ns.newUniqueId  (); // still drift
`,
  });
  try {
    const r = runLint(fixture.paths.join(":"));
    assert.equal(r.status, 1, "whitespace tolerance broken");
    assert.match(r.stderr, /spaced\.ts:1/);
  } finally {
    fixture.cleanup();
  }
});

test("`.newUniqueId(` inside a `//` line comment is ignored (documentation may discuss it)", () => {
  const fixture = makeFixture({
    "doc.ts": `// We deliberately DO NOT use ns.newUniqueId() — see ADR-0021.
const stub = ns.get(ns.idFromName(this.bundleIdName));
`,
  });
  try {
    const r = runLint(fixture.paths.join(":"));
    assert.equal(r.status, 0, `expected pass; stderr:\n${r.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test("missing monitored file → exit 2 (toolchain failure, not silent pass)", () => {
  // Point at a nonexistent path.
  const fixture = makeFixture({});
  try {
    const fakePath = resolve(fixture.dir, "nope.ts");
    const r = runLint(fakePath);
    assert.equal(r.status, 2, `expected toolchain failure; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /not found/);
  } finally {
    fixture.cleanup();
  }
});

test("multiple violations across multiple files reported with line numbers", () => {
  const fixture = makeFixture({
    "a.ts": `const x = ns.newUniqueId();
const y = ns.idFromName("ok");
const z = ns.newUniqueId();
`,
    "b.ts": `const w = ns.newUniqueId();
`,
  });
  try {
    const r = runLint(fixture.paths.join(":"));
    assert.equal(r.status, 1, "expected fail");
    // Three hits: a.ts:1, a.ts:3, b.ts:1
    assert.match(r.stderr, /3 violation/);
    assert.match(r.stderr, /a\.ts:1/);
    assert.match(r.stderr, /a\.ts:3/);
    assert.match(r.stderr, /b\.ts:1/);
  } finally {
    fixture.cleanup();
  }
});

test("default-target invocation (no env override) scans the real repo MONITORED list and passes today", () => {
  // No fixture — runs against the live repo source. The lint MUST pass
  // on a clean checkout; if it fails, either a real violation has been
  // committed OR the MONITORED list references a missing file.
  const r = spawnSync("node", [LINT_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0,
    `expected clean repo; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});
