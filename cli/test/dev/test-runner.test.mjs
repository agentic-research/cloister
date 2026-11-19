// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Node test runner says, last, which tests failed. Its output is several
// thousand lines and other suites print after it, so without that a failure
// is one line far above the exit status, and a log viewer that keeps only the
// tail does not show it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failedTests, runNodeTests } from "../../lib/dev/test-runner.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TAP = [
  "TAP version 13",
  "# Subtest: fine",
  "ok 1 - fine",
  "  ---",
  "  duration_ms: 1",
  "  ...",
  "# Subtest: skipped on purpose",
  "ok 2 - skipped on purpose # SKIP no cluster here",
  "# Subtest: parent",
  "    # Subtest: the child that is wrong",
  "    not ok 1 - the child that is wrong",
  "      ---",
  "      error: 'expected 1, got 2'",
  "      code: 'ERR_ASSERTION'",
  "      ...",
  "    1..1",
  "not ok 3 - parent",
  "  ---",
  "  error: '1 subtest failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "# Subtest: wrong at the top",
  "not ok 4 - wrong at the top",
  "  ---",
  "  error: 'boom'",
  "  ...",
  "1..4",
].join("\n");

test("the failing tests are found, with what each one said", () => {
  const failures = failedTests(TAP);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /not ok 1 - the child that is wrong[\s\S]*expected 1, got 2/);
  assert.match(failures[1], /^not ok 4 - wrong at the top[\s\S]*boom/);
});

test("a parent that failed only because a child did is not reported twice", () => {
  assert.ok(!failedTests(TAP).some((f) => f.includes("not ok 3 - parent")));
});

test("a skipped test and a passing one are not failures", () => {
  assert.deepEqual(failedTests("ok 1 - a\nok 2 - b # SKIP why\n1..2\n"), []);
});

// A fake node: it writes the TAP file the runner asked for, and exits as told.
const fakeNode = (tap, status) => (_exe, args) => {
  const dest = args.filter((a) => a.startsWith("--test-reporter-destination=")).map((a) => a.split("=")[1]).find((d) => d !== "stdout");
  writeFileSync(dest, tap);
  return { status, signal: null };
};

test("a failing run ends by naming the failing tests", () => {
  const said = [];
  const status = runNodeTests({ root: ROOT, spawn: fakeNode(TAP, 1), log: (line) => said.push(line) });
  assert.equal(status, 1);
  const text = said.join("\n");
  assert.match(text, /2 failing test\(s\):/);
  assert.match(text, /the child that is wrong/);
  assert.match(text, /wrong at the top/);
});

test("a passing run says nothing more", () => {
  const said = [];
  assert.equal(runNodeTests({ root: ROOT, spawn: fakeNode("ok 1 - a\n1..1\n", 0), log: (line) => said.push(line) }), 0);
  assert.deepEqual(said, []);
});

test("the terminal still gets the full results, as before", () => {
  let seen;
  runNodeTests({ root: ROOT, spawn: (_exe, args) => { seen = args; return fakeNode("1..0\n", 0)(_exe, args); }, log: () => {} });
  assert.ok(seen.includes("--test-reporter-destination=stdout"));
  assert.equal(seen.filter((a) => a === "--test-reporter=tap").length, 2);
});
