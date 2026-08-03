// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Companion test for lint:schema-claim (cloister-3e86e8 / ADR-0063).
//
// Three obligations, per the repo's rail discipline:
//   1. the SHIPPED TREE satisfies the rail (not just fixtures)
//   2. the rail can actually FAIL — it is not vacuous
//   3. the rail is WIRED into `task lint`, not merely described by it
//
// Obligation 2 is the one that matters here. The first cut of this rail failed
// on its own header, because it treated a markdown backtick in JSDoc as a
// template-literal delimiter. The fix — strip comments first — is exactly the
// kind of change that can quietly turn a rail into a no-op, so the discussion
// -vs-claim distinction is pinned from both sides below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RAIL = resolve(ROOT, "scripts/lint-schema-claim.mjs");

function runRail() {
  try {
    return { code: 0, out: execFileSync("node", [RAIL], { encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("the shipped tree satisfies the rail", () => {
  const { code, out } = runRail();
  assert.equal(code, 0, `rail failed on the real tree:\n${out}`);
  assert.match(out, /clean/);
});

// Asks Task to resolve the dependency graph rather than reading Taskfile.yml as
// text. `lint:structured-parse` rejected the regex version of this assertion and
// was right to: whether a task is a dependency is Task's data model, not a
// string in a file. `--dry` answers from the resolved graph, so a rename or a
// restructured deps list cannot leave this passing on a stale literal.
test("the rail is wired into `task lint`, not merely described by it", () => {
  // Task reports the resolved graph on stderr, so both streams are read.
  const dry = spawnSync("task", ["lint", "--dry"], { cwd: ROOT, encoding: "utf8" });
  const graph = `${dry.stdout ?? ""}${dry.stderr ?? ""}`;
  assert.notEqual(graph, "", "`task lint --dry` produced no output to assert against");
  assert.match(graph, /lint:schema-claim/, "lint:schema-claim is not in `task lint`'s graph");
});

test("a string-literal claim without generated types FAILS", () => {
  const probe = resolve(ROOT, "src/__schema_claim_probe.mjs");
  writeFileSync(probe, 'export const s = { schema: "execution/v1" };\n');
  try {
    const { code, out } = runRail();
    assert.equal(code, 1, "rail did not fail on an ungenerated claim");
    assert.match(out, /__schema_claim_probe/);
  } finally {
    rmSync(probe, { force: true });
  }
});

// The distinction the rail exists to make, pinned from the permissive side.
test("discussing a contract in a comment is NOT a claim", () => {
  const probe = resolve(ROOT, "src/__schema_claim_probe.mjs");
  writeFileSync(
    probe,
    "// We will speak `execution/v1` here once LLO publishes it.\n" +
      "/* execution/v1 is owned by ley-line-open. */\n" +
      "export const ready = false;\n",
  );
  try {
    const { code, out } = runRail();
    assert.equal(code, 0, `comment-only mention was treated as a claim:\n${out}`);
  } finally {
    rmSync(probe, { force: true });
  }
});

test("a claim IS allowed once the file imports generated types", () => {
  const probe = resolve(ROOT, "src/__schema_claim_probe.mjs");
  writeFileSync(
    probe,
    'import { z } from "./generated/cluster.zod.ts";\n' +
      'export const s = { schema: "execution/v1", z };\n',
  );
  try {
    const { code, out } = runRail();
    assert.equal(code, 0, `a generated-backed claim was rejected:\n${out}`);
  } finally {
    rmSync(probe, { force: true });
  }
});
