// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The [[generated_backends]] row shape is enforced (cloister-71a9f4).
//
// build-manifest.mjs exports nothing — it is a script. So these tests are
// BEHAVIORAL: each one writes a lockfile, runs the real script against it via
// CLOISTER_LOCKFILE, and asserts the process exit code. That is stronger than
// exporting the function for a unit test, because it exercises the path that
// actually ships.
//
// What this guards. Every field used to be read as
// `typeof x === "string" ? x : ""`, which collapses three distinct states into
// one. It cannot be otherwise: `stripPrefix = ""` is a real value in all 15
// shipped rows, so empty-string cannot also mean "absent or wrong type". The
// measured consequence was that `handlesPrefixx` (one typo) and
// `handlesPrefix = 42` both produced output byte-identical to a legitimate
// empty prefix — a clean build, and a backend matching nothing.
//
// The file was already internally inconsistent about this: fail() exits 2, and
// a duplicate backend NAME was fatal, while a malformed ROW was a console
// warning and a skip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Run the real build-manifest against a crafted lockfile. */
function buildWith(tomlBody, t) {
  const dir = mkdtempSync(join(tmpdir(), "row-shape-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockfile = join(dir, "cluster.lock.toml");
  writeFileSync(lockfile, tomlBody);
  // Driven through `task manifest`, not bare `node scripts/build-manifest.mjs`
  // — the same convention as e2e-manifest-pipeline.test.mjs, and for the same
  // reason: the task owns the real invocation (`node --import tsx ...`), so the
  // test follows it automatically if it changes.
  //
  // Bare `node` was the first attempt. It passed locally on Node 25, which
  // strips TS types natively, and failed all ten tests on CI's Node 20 with
  // `Unknown file extension ".ts"` — build-manifest loads the generated
  // tool-schemas.ts and needs the loader. A green local run proved nothing
  // about the interpreter CI actually uses.
  const r = spawnSync("task", ["manifest", "--force"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CLOISTER_LOCKFILE: lockfile,
      CLOISTER_OUTPUT: join(dir, "manifest.ts"),
      // CLOISTER_TOOL_SCHEMAS is deliberately NOT overridden: it is an INPUT
      // to this script (build-tool-schemas.mjs writes it). Pointing it at an
      // empty temp dir makes every build fail on a missing input schema — a
      // harness that can only ever produce failures, which would make the
      // negative assertions below pass for the wrong reason.
    },
  });
  return { status: r.status, stderr: `${r.stderr ?? ""}${r.stdout ?? ""}` };
}

const VALID_ROW = `
[[generated_backends]]
input = "llo"
name = "probe"
handlesPrefix = "probe_"
stripPrefix = ""
urlBinding = "LLO_MCP_URL"
serviceBinding = ""
dynamicTools = true
requiresSession = false
claims = ["a_tool"]
`;

// ── The harness can produce a PASS ────────────────────────────────────────
// Without this, every "exit != 0" assertion below could be passing because the
// script fails for an unrelated reason — the vacuous-pass failure mode.

test("a well-formed row builds cleanly", (t) => {
  const { status, stderr } = buildWith(VALID_ROW, t);
  assert.equal(status, 0, `expected clean build, got ${status}:\n${stderr}`);
});

test("absent optional fields still take defaults (lockfile back-compat)", (t) => {
  // Older lockfiles predate newer fields. ABSENT must stay legal — only a
  // field that IS present and wrong may fail the build. Rewriting old
  // lockfiles is not a precondition for building.
  // handlesPrefix is present because a row with neither handlesPrefix nor
  // claims is unroutable and validate() rejects it on separate, pre-existing
  // grounds — nothing to do with field defaulting. Everything else is omitted.
  const { status, stderr } = buildWith(
    `\n[[generated_backends]]\ninput = "llo"\nname = "probe"\nhandlesPrefix = "probe_"\n`,
    t,
  );
  assert.equal(status, 0, `absent fields must default, got ${status}:\n${stderr}`);
});

// ── Unknown keys ──────────────────────────────────────────────────────────

test("a typo'd field name fails the build", (t) => {
  // The measured defect: this produced handlesPrefix "" — a backend matching
  // nothing — and exited 0.
  const { status, stderr } = buildWith(
    VALID_ROW.replace("handlesPrefix =", "handlesPrefixx ="),
    t,
  );
  assert.notEqual(status, 0, "a typo'd key must not build");
  assert.match(stderr, /unknown field "handlesPrefixx"/);
});

test("`claim` singular is rejected rather than yielding zero claims", (t) => {
  const { status, stderr } = buildWith(VALID_ROW.replace("claims =", "claim ="), t);
  assert.notEqual(status, 0, "`claim` must not build");
  assert.match(stderr, /unknown field "claim"/);
});

// ── Wrong types ───────────────────────────────────────────────────────────

test("a non-string handlesPrefix fails rather than coercing to empty", (t) => {
  const { status, stderr } = buildWith(
    VALID_ROW.replace('handlesPrefix = "probe_"', "handlesPrefix = 42"),
    t,
  );
  assert.notEqual(status, 0, "wrong-typed handlesPrefix must not build");
  assert.match(stderr, /must be string, got number/);
});

test("a non-array claims fails rather than coercing to []", (t) => {
  const { status, stderr } = buildWith(
    VALID_ROW.replace('claims = ["a_tool"]', 'claims = "a_tool"'),
    t,
  );
  assert.notEqual(status, 0, "wrong-typed claims must not build");
  assert.match(stderr, /"claims" must be string\[\]/);
});

test("a claims array containing a non-string fails the build", (t) => {
  // Caught by TOML itself ("inline lists must be a single type"), not by the
  // element check — so through the lockfile surface this state is
  // unreachable. Asserted at the level that is actually true: the build
  // fails. The element check in GENERATED_BACKEND_FIELDS still covers a doc
  // that reaches the function from any non-TOML source.
  const { status, stderr } = buildWith(
    VALID_ROW.replace('claims = ["a_tool"]', 'claims = ["a_tool", 7]'),
    t,
  );
  assert.notEqual(status, 0, "claims must be uniformly string");
  assert.match(stderr, /single type|must be string\[\]/);
});

test("a string dynamicTools fails rather than being truthy", (t) => {
  // `dynamicTools = "false"` is a truthy string; the old `!== false` test
  // read it as true — the operator's intent inverted, silently.
  const { status, stderr } = buildWith(
    VALID_ROW.replace("dynamicTools = true", 'dynamicTools = "false"'),
    t,
  );
  assert.notEqual(status, 0, "wrong-typed dynamicTools must not build");
  assert.match(stderr, /"dynamicTools" must be boolean, got string/);
});

// ── Missing name ──────────────────────────────────────────────────────────

test("a row with no name fails rather than being skipped", (t) => {
  const { status, stderr } = buildWith(
    `\n[[generated_backends]]\ninput = "llo"\nhandlesPrefix = "probe_"\n`,
    t,
  );
  assert.notEqual(status, 0, "a nameless row must not be silently skipped");
  assert.match(stderr, /has no name/);
});

// ── The shipped lockfile satisfies the rail ───────────────────────────────

test("the shipped cluster.lock.toml passes the tightened check", () => {
  // The rail must hold against the real tree, not only fixtures — otherwise
  // it could be enforcing a shape nothing actually conforms to.
  const r = spawnSync("task", ["manifest", "--force"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CLOISTER_OUTPUT: join(mkdtempSync(join(tmpdir(), "row-shape-real-")), "manifest.ts"),
    },
  });
  assert.equal(r.status, 0, `shipped lockfile must build:\n${r.stderr}`);
});
