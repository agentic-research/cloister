// scripts/test/done-runner.test.mjs
//
// Run with:  node --test scripts/test/done-runner.test.mjs
//
// Contract tests for the `task done` gate runner (cloister-0d5e0f).
// The runner loads drop-in JSON rules from a directory, executes
// each as a shell command, and reports pass/warn/block with
// exit-code propagation. Pattern mirrors mache's external smell
// rules (~/remotes/art/mache/examples/smell-rules/README.md).
//
// Tests synthesize rules in a tmpdir + a tmp DONE_RULES_DIR, then
// spawn the runner with that env-var override. No mocks; the
// runner is a real shell-spawning script and the tests exercise it
// end-to-end.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RUNNER = resolve(REPO_ROOT, "scripts/done-runner.mjs");

// ── Harness ──────────────────────────────────────────────────────────────

function makeRulesDir(rules) {
  const dir = mkdtempSync(resolve(tmpdir(), "done-rules-"));
  for (const r of rules) {
    const name = `${r.id}.json`;
    writeFileSync(resolve(dir, name), JSON.stringify(r, null, 2));
  }
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function runRunner(rulesDir, extraEnv = {}) {
  return spawnSync("node", [RUNNER], {
    cwd: REPO_ROOT,
    env: { ...process.env, DONE_RULES_DIR: rulesDir, ...extraEnv },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

test("all rules pass → runner exits 0 + reports pass count", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "ok-1", description: "trivially passes", severity: "block", run: "true" },
    { id: "ok-2", description: "also passes",      severity: "warn",  run: "true" },
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /2 pass/);
    assert.match(r.stdout, /0 warn/);
    assert.match(r.stdout, /0 block/);
  } finally {
    cleanup();
  }
});

test("a block-severity failure → runner exits 1 + names the failing rule", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "ok-rule",   description: "passes", severity: "block", run: "true" },
    { id: "fail-rule", description: "blocks", severity: "block", run: "false" },
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 1, `expected exit 1; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /fail-rule/);
    assert.match(r.stdout, /1 pass/);
    assert.match(r.stdout, /1 block/);
    // The failing rule's id surfaces in the blocking summary on stderr.
    assert.match(r.stderr, /fail-rule/);
  } finally {
    cleanup();
  }
});

test("a warn-severity failure → runner exits 0 (warns don't block) + reports the warn", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "ok-rule",   description: "passes",  severity: "block", run: "true"  },
    { id: "warn-rule", description: "noisy",   severity: "warn",  run: "false" },
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 0, `warn-only failures must NOT block exit; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /1 pass/);
    assert.match(r.stdout, /1 warn/);
    assert.match(r.stdout, /0 block/);
    assert.match(r.stdout, /warn-rule/);
  } finally {
    cleanup();
  }
});

test("mixed pass / warn / block → block wins, exit 1, summary shows all three", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "p", severity: "block", run: "true"  },
    { id: "w", severity: "warn",  run: "false" },
    { id: "b", severity: "block", run: "false" },
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /1 pass/);
    assert.match(r.stdout, /1 warn/);
    assert.match(r.stdout, /1 block/);
  } finally {
    cleanup();
  }
});

test("severity defaults to 'block' when omitted (fail-secure)", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "no-severity", run: "false" }, // no severity field → must default to block
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 1, "missing severity must default to block (fail-secure)");
    assert.match(r.stdout, /1 block/);
  } finally {
    cleanup();
  }
});

test("malformed rule (missing id) → runner exits 2 (toolchain error) + clear message", () => {
  const { dir, cleanup } = makeRulesDir([
    { description: "no id", run: "true" }, // missing required field
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 2, "malformed rule must be a toolchain error (exit 2), not a silent pass");
    assert.match(r.stderr, /id|missing/i);
  } finally {
    cleanup();
  }
});

test("malformed rule (missing run) → runner exits 2", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "no-run", description: "no run command" },
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /run|missing/i);
  } finally {
    cleanup();
  }
});

test("invalid JSON in a rule file → runner exits 2 + cites the file", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "done-rules-"));
  try {
    writeFileSync(resolve(dir, "bad.json"), "{ not valid json");
    const r = runRunner(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /bad\.json|JSON|parse/i);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("empty rules dir → runner exits 0 + reports zero rules", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "done-rules-"));
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /0 rule\(s\) loaded/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("missing rules dir → runner exits 0 + reports zero rules (degrades gracefully)", () => {
  const r = runRunner(resolve(tmpdir(), "definitely-does-not-exist-" + Date.now()));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /0 rule\(s\) loaded/);
});

test("rules execute in sorted-id order (deterministic for review)", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "z-last",  run: "echo Z" },
    { id: "a-first", run: "echo A" },
    { id: "m-mid",   run: "echo M" },
  ]);
  try {
    const r = runRunner(dir);
    assert.equal(r.status, 0);
    // Each rule's id appears in the per-rule output; check ordering.
    const idxA = r.stdout.indexOf("a-first");
    const idxM = r.stdout.indexOf("m-mid");
    const idxZ = r.stdout.indexOf("z-last");
    assert.ok(idxA > 0 && idxM > 0 && idxZ > 0, "all three ids should appear");
    assert.ok(idxA < idxM && idxM < idxZ, "rules must execute / report in sorted-id order");
  } finally {
    cleanup();
  }
});

test("non-json files in rules dir are ignored", () => {
  const { dir, cleanup } = makeRulesDir([
    { id: "real-rule", run: "true" },
  ]);
  try {
    writeFileSync(resolve(dir, "README.md"), "# not a rule\n");
    writeFileSync(resolve(dir, "ignore.txt"), "still not a rule");
    const r = runRunner(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 rule\(s\) loaded/, "only the .json file should be loaded");
  } finally {
    cleanup();
  }
});
