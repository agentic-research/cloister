// scripts/test/cli-add.test.mjs
//
// Contract tests for scripts/cli-add.mjs (cloister-66b6a6 / ADR-0026
// Phase 2 subpiece 2).
//
// Run with:
//   pnpm exec tsx --test scripts/test/cli-add.test.mjs
//
// Tests three surfaces:
//   - parseArgs(): flag handling, name auto-derivation, error shapes
//   - addInputToClusterToml(): mutation of TOML body, duplicate detection
//   - main(): integration through cluster.toml + cluster.lock.toml
//     mutation, using a tmpdir + CLOISTER_CLUSTER_TOML override.
//
// No regex assertions per operator request — substring checks +
// structural deep-equals only.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseToml } from "@iarna/toml";

import { parseArgs, deriveName, addInputToClusterToml, main } from "../cli-add.mjs";

// ── parseArgs: well-formed ──────────────────────────────────────────────

test("parseArgs: positional ref + auto-name from github://owner/repo@ref", () => {
  const out = parseArgs(["github://anthropic/skills@main"]);
  assert.equal(out.ref, "github://anthropic/skills@main");
  assert.equal(out.name, "skills");
  assert.equal(out.version, "");
  assert.deepEqual(out.provides, []);
  assert.deepEqual(out.requires, []);
});

test("parseArgs: explicit --name overrides derivation", () => {
  const out = parseArgs(["github://anthropic/skills@main", "--name", "my-skills"]);
  assert.equal(out.name, "my-skills");
});

test("parseArgs: --provides and --requires are repeatable", () => {
  const out = parseArgs([
    "github://x/y@main",
    "--provides", "cloister/a/v1",
    "--provides", "cloister/b/v1",
    "--requires", "cloister/c/v1",
  ]);
  assert.deepEqual(out.provides, ["cloister/a/v1", "cloister/b/v1"]);
  assert.deepEqual(out.requires, ["cloister/c/v1"]);
});

test("parseArgs: --version sets version field", () => {
  const out = parseArgs(["github://x/y@main", "--version", "^1.0.0"]);
  assert.equal(out.version, "^1.0.0");
});

// ── parseArgs: errors ───────────────────────────────────────────────────

test("parseArgs: missing ref throws UsageError", () => {
  assert.throws(
    () => parseArgs([]),
    (err) => err.message.includes("missing required <ref>"),
  );
});

test("parseArgs: unknown flag throws UsageError", () => {
  assert.throws(
    () => parseArgs(["github://x/y@main", "--bogus", "z"]),
    (err) => err.message.includes("unknown flag"),
  );
});

test("parseArgs: --name without value throws UsageError", () => {
  assert.throws(
    () => parseArgs(["github://x/y@main", "--name"]),
    (err) => err.message.includes("--name requires a value"),
  );
});

test("parseArgs: two positional refs throws UsageError", () => {
  assert.throws(
    () => parseArgs(["github://x/y@main", "github://a/b@main"]),
    (err) => err.message.includes("only one <ref>"),
  );
});

test("parseArgs: --help throws special UsageError sentinel", () => {
  assert.throws(
    () => parseArgs(["--help"]),
    (err) => err.message === "__HELP__",
  );
});

// ── deriveName: schemes + edge cases ────────────────────────────────────

test("deriveName: github whole-repo → repo name", () => {
  assert.equal(deriveName("github://anthropic/skills@main"), "skills");
});

test("deriveName: github single-file path → basename without extension", () => {
  assert.equal(deriveName("github://anthropic/skills/python-bridge.md@v1"), "python-bridge");
});

test("deriveName: github multi-segment path → final segment basename", () => {
  assert.equal(deriveName("github://anthropic/skills/dir/sub/file.json@main"), "file");
});

test("deriveName: file:// path → basename without extension", () => {
  assert.equal(deriveName("file:///abs/path/to/skill.md"), "skill");
});

test("deriveName: file:// tar.gz → strips both extensions", () => {
  assert.equal(deriveName("file:///abs/path/release.tar.gz"), "release");
});

test("deriveName: https URL with file extension → basename", () => {
  assert.equal(deriveName("https://example.com/foo/bar.tar.gz"), "bar");
});

test("deriveName: hidden-file basename keeps the dot", () => {
  assert.equal(deriveName("file:///abs/.gitignore"), ".gitignore");
});

test("deriveName: unknown scheme → empty (forces explicit --name)", () => {
  assert.equal(deriveName("unknown://foo/bar"), "");
});

test("deriveName: empty string → empty", () => {
  assert.equal(deriveName(""), "");
});

test("deriveName: non-string → empty", () => {
  assert.equal(deriveName(null), "");
});

// ── addInputToClusterToml: mutation ─────────────────────────────────────

const MINIMAL_CLUSTER_TOML = `[metadata]
name = "test"
version = "0.0.1"

[storage]
doStoragePath = "/tmp/do"
`;

test("addInputToClusterToml: adds [inputs.<name>] block to empty cluster", () => {
  const out = addInputToClusterToml(MINIMAL_CLUSTER_TOML, "foo", {
    ref: "github://x/y@main",
    version: "0.1.0",
    provides: ["cloister/a/v1"],
    requires: [],
  });
  const parsed = parseToml(out);
  assert.ok(parsed.inputs, "inputs table must exist");
  assert.ok(parsed.inputs.foo, "named input must exist");
  assert.equal(parsed.inputs.foo.ref, "github://x/y@main");
  assert.equal(parsed.inputs.foo.version, "0.1.0");
  assert.deepEqual(parsed.inputs.foo.provides, ["cloister/a/v1"]);
  assert.deepEqual(parsed.inputs.foo.requires, []);
  assert.equal(parsed.inputs.foo.digest, "");
  assert.equal(parsed.inputs.foo.from, "");
});

test("addInputToClusterToml: preserves existing [inputs.*] entries", () => {
  const existing = MINIMAL_CLUSTER_TOML + `
[inputs.alpha]
ref = "file:///a"
version = ""
digest = ""
from = ""
provides = [ ]
requires = [ ]
`;
  const out = addInputToClusterToml(existing, "beta", {
    ref: "file:///b", version: "", provides: [], requires: [],
  });
  const parsed = parseToml(out);
  assert.ok(parsed.inputs.alpha, "alpha must survive");
  assert.ok(parsed.inputs.beta, "beta must be added");
  assert.equal(parsed.inputs.alpha.ref, "file:///a");
  assert.equal(parsed.inputs.beta.ref, "file:///b");
});

test("addInputToClusterToml: duplicate name → AddError with helpful message", () => {
  const existing = MINIMAL_CLUSTER_TOML + `
[inputs.dup]
ref = "file:///a"
version = ""
digest = ""
from = ""
provides = [ ]
requires = [ ]
`;
  assert.throws(
    () => addInputToClusterToml(existing, "dup", { ref: "file:///b", version: "", provides: [], requires: [] }),
    (err) => err.message.includes("dup")
      && err.message.includes("already exists")
      && err.message.includes("--name"),
  );
});

test("addInputToClusterToml: malformed cluster.toml → AddError with parse failure", () => {
  assert.throws(
    () => addInputToClusterToml("not [ valid toml [", "x", { ref: "file:///a", version: "", provides: [], requires: [] }),
    (err) => err.message.includes("failed to parse"),
  );
});

// ── main: integration via CLOISTER_CLUSTER_TOML override ────────────────

async function withClusterTomlFixture(initialBody, fn) {
  const dir = mkdtempSync(resolve(tmpdir(), "cli-add-"));
  const clusterPath = resolve(dir, "cluster.toml");
  const lockPath = resolve(dir, "cluster.lock.toml");
  writeFileSync(clusterPath, initialBody);
  const savedCluster = process.env.CLOISTER_CLUSTER_TOML;
  const savedLock = process.env.CLOISTER_LOCKFILE;
  process.env.CLOISTER_CLUSTER_TOML = clusterPath;
  process.env.CLOISTER_LOCKFILE = lockPath;
  try {
    return await fn({ dir, clusterPath, lockPath });
  } finally {
    if (savedCluster !== undefined) process.env.CLOISTER_CLUSTER_TOML = savedCluster;
    else delete process.env.CLOISTER_CLUSTER_TOML;
    if (savedLock !== undefined) process.env.CLOISTER_LOCKFILE = savedLock;
    else delete process.env.CLOISTER_LOCKFILE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("main: happy path with file:// — mutates cluster.toml + writes lockfile", async () => {
  // Use a real file:// resolve so we don't need to mock fetch.
  await withClusterTomlFixture(MINIMAL_CLUSTER_TOML, async ({ dir, clusterPath, lockPath }) => {
    const payloadPath = resolve(dir, "skill.md");
    writeFileSync(payloadPath, "skill content");

    const code = await main([`file://${payloadPath}`, "--name", "test-skill"]);
    assert.equal(code, 0);

    const mutated = parseToml(readFileSync(clusterPath, "utf8"));
    assert.ok(mutated.inputs["test-skill"], "input was added");
    assert.equal(mutated.inputs["test-skill"].ref, `file://${payloadPath}`);

    const lockfile = parseToml(readFileSync(lockPath, "utf8"));
    assert.ok(lockfile.inputs["test-skill"], "lockfile row added");
    assert.ok(lockfile.inputs["test-skill"].sha256.startsWith("sha256:"));
    assert.equal(lockfile.inputs["test-skill"].bytes, Buffer.from("skill content").length);
  });
});

test("main: duplicate input name → exit 1, cluster.toml unchanged", async () => {
  const initial = MINIMAL_CLUSTER_TOML + `
[inputs.exists]
ref = "file:///a"
version = ""
digest = ""
from = ""
provides = [ ]
requires = [ ]
`;
  await withClusterTomlFixture(initial, async ({ clusterPath }) => {
    const before = readFileSync(clusterPath, "utf8");
    const code = await main(["file:///b", "--name", "exists"]);
    assert.equal(code, 1, "duplicate must exit 1");
    const after = readFileSync(clusterPath, "utf8");
    assert.equal(before, after, "cluster.toml must NOT be mutated on failure");
  });
});

test("main: missing ref → exit 2 with usage error", async () => {
  await withClusterTomlFixture(MINIMAL_CLUSTER_TOML, async () => {
    const code = await main([]);
    assert.equal(code, 2);
  });
});

test("main: missing cluster.toml → exit 2", async () => {
  const savedCluster = process.env.CLOISTER_CLUSTER_TOML;
  process.env.CLOISTER_CLUSTER_TOML = "/does/not/exist/cluster.toml";
  try {
    const code = await main(["file:///a"]);
    assert.equal(code, 2);
  } finally {
    if (savedCluster !== undefined) process.env.CLOISTER_CLUSTER_TOML = savedCluster;
    else delete process.env.CLOISTER_CLUSTER_TOML;
  }
});

test("main: --help → exit 0", async () => {
  await withClusterTomlFixture(MINIMAL_CLUSTER_TOML, async () => {
    const code = await main(["--help"]);
    assert.equal(code, 0);
  });
});

test("main: resolve failure leaves cluster.toml mutated + exits 1", async () => {
  await withClusterTomlFixture(MINIMAL_CLUSTER_TOML, async ({ clusterPath }) => {
    const code = await main(["file:///does/not/exist/skill.md", "--name", "ghost"]);
    assert.equal(code, 1, "resolve failure must exit 1");
    // Mutation was performed before resolve — operator can git-checkout to roll back.
    const mutated = parseToml(readFileSync(clusterPath, "utf8"));
    assert.ok(mutated.inputs.ghost, "cluster.toml mutation persists per documented behavior");
  });
});
