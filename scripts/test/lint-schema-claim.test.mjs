// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Companion test for lint:schema-claim (cloister-3e86e8 / ADR-0063).
//
// Three obligations, per the repo's rail discipline: the SHIPPED TREE satisfies
// the rail, the rail can actually FAIL, and it is WIRED into `task lint`.
//
// The middle one earns its keep here. This rail was wrong twice on its first
// day — it failed on its own header (a markdown backtick read as a template
// literal), then on a HELP STRING in cli/commands/runtime.mjs. Both times the
// bug was the same: it checked whether a file MENTIONED the contract instead of
// whether it RESTATED the contract's fields. So the mention-vs-enumeration line
// and the MIN_FIELDS threshold are both pinned from both sides below; a future
// simplification that collapses either one fails here rather than silently
// turning the rail back into a mention-detector.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RAIL = resolve(ROOT, "scripts/lint-schema-claim.mjs");
const PROBE = resolve(ROOT, "src/__schema_claim_probe.mjs");
const TEST_PROBE = resolve(ROOT, "scripts/test/__schema_claim_probe.test.mjs");

function runRail() {
  const r = spawnSync("node", [RAIL], { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function withFile(path, body, fn) {
  writeFileSync(path, body);
  try { return fn(); } finally { rmSync(path, { force: true }); }
}

test("the shipped tree satisfies the rail", () => {
  const { code, out } = runRail();
  assert.equal(code, 0, `rail failed on the real tree:\n${out}`);
  assert.match(out, /clean/);
});

// Asks Task to resolve the dependency graph rather than reading Taskfile.yml as
// text. `lint:structured-parse` rejected the regex version of this assertion and
// was right to: whether a task is a dependency is Task's data model.
test("the rail is wired into `task lint`, not merely described by it", () => {
  const dry = spawnSync("task", ["lint", "--dry"], { cwd: ROOT, encoding: "utf8" });
  const graph = `${dry.stdout ?? ""}${dry.stderr ?? ""}`;
  assert.notEqual(graph, "", "`task lint --dry` produced no output to assert against");
  assert.match(graph, /lint:schema-claim/, "lint:schema-claim is not in `task lint`'s graph");
});

test("hand-enumerating canonical fields in non-test code FAILS", () => {
  withFile(PROBE, "export const s = { schemaVersion: '', executable: {}, workspaceInputs: [] };\n", () => {
    const { code, out } = runRail();
    assert.equal(code, 1, "rail did not fail on a hand-written field list");
    assert.match(out, /__schema_claim_probe/);
  });
});

// The line the rail exists to draw, and the one it got wrong twice.
test("MENTIONING the contract is not RESTATING it", () => {
  withFile(
    PROBE,
    '// Provision through the LLO execution/v1 provider.\n' +
      'export const help = "Run a plan through cloister/execution/v1";\n',
    () => {
      const { code, out } = runRail();
      assert.equal(code, 0, `a prose mention was treated as an enumeration:\n${out}`);
    },
  );
});

// The threshold is a judgement call, so it is pinned from both sides. Canonical
// field names include ordinary words (`arguments`, `outputs`, `limits`); two of
// them together is coincidence, three is a field list.
test("two canonical fields is coincidence; three is enumeration", () => {
  withFile(PROBE, "export const a = { arguments: [], outputs: [] };\n", () => {
    assert.equal(runRail().code, 0, "two fields should be below the threshold");
  });
  withFile(PROBE, "export const a = { arguments: [], outputs: [], limits: {} };\n", () => {
    assert.equal(runRail().code, 1, "three fields should trip the threshold");
  });
});

// A test that pins the wire shape must state the wire shape — but only with the
// generated contract in the loop, so the fixture is checked against the artifact
// rather than being merely self-consistent (which is how #260's test passed).
test("a test may state the wire shape only via the generated contract module", () => {
  const shape = "export const s = { schemaVersion: '', executable: {}, workspaceInputs: [] };\n";
  withFile(TEST_PROBE, shape, () => {
    assert.equal(runRail().code, 1, "a test enumerating without the contract should fail");
  });
  withFile(
    TEST_PROBE,
    'import { lloExecutionRequest } from "../../cli/lib/runtime/llo-execution-contract.mjs";\n' +
      shape + "export const r = lloExecutionRequest;\n",
    () => {
      assert.equal(runRail().code, 0, "a contract-backed test fixture should pass");
    },
  );
});

// A rail whose data source vanished must fail, not pass with an empty field set.
test("the rail refuses to run vacuously without the generated artifact", () => {
  const src = resolve(ROOT, "src/generated/llo-execution-tools.json");
  const bak = `${src}.railtest.bak`;
  spawnSync("mv", [src, bak]);
  try {
    const { code, out } = runRail();
    assert.equal(code, 1, "rail passed with no artifact to check against");
    assert.match(out, /artifact missing/i);
  } finally {
    spawnSync("mv", [bak, src]);
  }
});
