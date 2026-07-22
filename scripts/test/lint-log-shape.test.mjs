// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint-log-shape.mjs — cloister-bd7e51 rail. No regex assertions per
// operator request — substring + structural checks only.
//
// Run with: node --import tsx --test scripts/test/lint-log-shape.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findStringLogs, collectStringLogs } from "../lint-log-shape.mjs";

test("flags a console.warn with a string-literal first argument", () => {
  const text = 'console.warn("[cloister] getCABundle: unavailable");';
  const v = findStringLogs("src/storage/x.ts", text);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
});

test("flags a template-literal first argument", () => {
  const text = "console.warn(`fetch ${url} threw`);";
  assert.equal(findStringLogs("src/storage/x.ts", text).length, 1);
});

test("flags a string argument that sits on the line AFTER the sink", () => {
  // The first non-whitespace char after `(` is on a later line — still a string.
  const text = 'console.warn(\n  "[cloister] accepting UNVERIFIED bundle",\n);';
  const v = findStringLogs("src/storage/x.ts", text);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
});

test("does NOT flag a structured JSON.stringify emit", () => {
  const text = 'console.warn(JSON.stringify({ target: "vault", op: "x", outcome: "y" }));';
  assert.equal(findStringLogs("src/routes/x.ts", text).length, 0);
});

test("does NOT flag a logEvent call", () => {
  const text = 'logEvent("warn", { target: "ca_bundle", op: "get", outcome: "unavailable" });';
  assert.equal(findStringLogs("src/storage/x.ts", text).length, 0);
});

test("does NOT flag console.X passed a variable", () => {
  const text = "console.error(line);";
  assert.equal(findStringLogs("src/routes/x.ts", text).length, 0);
});

test("respects an inline lint-allow-string-log on the call line", () => {
  const text = 'console.warn("dev bootstrap banner"); // lint-allow-string-log: dev-only banner';
  assert.equal(findStringLogs("src/routes/x.ts", text).length, 0);
});

test("respects lint-allow-string-log in a comment above the call", () => {
  const text = "// lint-allow-string-log: dev-only banner\nconsole.warn(`hi ${x}`);";
  assert.equal(findStringLogs("src/routes/x.ts", text).length, 0);
});

test("the shipped trust/IO surface has no ad-hoc string logs", () => {
  // The live guard: after bd7e51, every operational log on the trust surface is
  // structured (logEvent / JSON.stringify) or carries an allow marker.
  assert.deepEqual(collectStringLogs(), []);
});
