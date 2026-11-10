// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:conflict-markers (cloister-991e65). Unit cases for the matcher, plus the
// rail run against the REAL tree, so it cannot pass vacuously.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { findMarkers, isBinary, scanTree, trackedFiles } from "../lint-conflict-markers.mjs";

test("findMarkers flags each of the four marker shapes at line start", () => {
  const text = [
    "ok",
    "<<<<<<< HEAD",
    "ours",
    "||||||| parent of 1234abc (msg)",
    "base",
    "=======",
    "theirs",
    ">>>>>>> 5678def (msg)",
  ].join("\n");
  assert.deepEqual(findMarkers(text).map((h) => h.line), [2, 4, 6, 8]);
});

test("findMarkers ignores look-alikes: setext underlines, indented markers, mid-line text", () => {
  const text = [
    "Title",
    "=====",
    "Other",
    "========",
    "    <<<<<<< indented, shown in a doc",
    "prose with ======= in it",
    "<<<<<<<no-space",
  ].join("\n");
  assert.deepEqual(findMarkers(text), []);
});

test("findMarkers handles CRLF line endings", () => {
  assert.equal(findMarkers("a\r\n=======\r\nb").length, 1);
});

test("isBinary uses the NUL heuristic", () => {
  assert.equal(isBinary(Buffer.from("text\n")), false);
  assert.equal(isBinary(Buffer.from([0x50, 0x00, 0x4b])), true);
});

test("the shipped tree has no conflict markers", () => {
  const files = trackedFiles();
  assert.ok(files.length > 100, `expected the real tracked tree, got ${files.length} files`);
  assert.ok(files.includes("CHANGELOG.md"), "CHANGELOG.md — where the markers shipped — is scanned");
  assert.deepEqual(scanTree(), []);
});
