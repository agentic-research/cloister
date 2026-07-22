// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint-dev-escape.mjs — the ADR-0026 committed-`from` rail. No regex
// assertions per operator standing rule.
//
// Run with: node --import tsx --test scripts/test/lint-dev-escape.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findDevEscapes, collectDevEscapes } from "../lint-dev-escape.mjs";

test("flags a non-empty from inside an [inputs.*] section", () => {
  const toml = [
    "[inputs.llo]",
    'ref = "io.github.org/agentic-research/ley-line-open@main"',
    'from = "file:///Users/someone/remotes/art/ley-line-open/server.json"',
  ].join("\n");
  const v = findDevEscapes("recipes/x/cluster.toml", toml);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
  assert.ok(v[0].value.startsWith("file:///"));
});

test("does NOT flag [[wires]] from — that is a bundle name, not a dev escape", () => {
  // The overload that makes a naive rail wrong: 12 legitimate in-tree wires.
  const toml = ['[[wires]]', 'from = "cloister-router"', 'to = "rosary"'].join("\n");
  assert.equal(findDevEscapes("cluster.toml", toml).length, 0);
});

test("does not flag other sections that happen to have a from key", () => {
  const toml = ['[gateway]', 'from = "somewhere"'].join("\n");
  assert.equal(findDevEscapes("cluster.toml", toml).length, 0);
});

test("an empty from is allowed (schema default, means use ref)", () => {
  const toml = ['[inputs.llo]', 'from = ""'].join("\n");
  assert.equal(findDevEscapes("cluster.toml", toml).length, 0);
});

test("section scoping resets — a wires from AFTER an inputs section is not flagged", () => {
  const toml = [
    "[inputs.llo]",
    'ref = "x"',
    "",
    "[[wires]]",
    'from = "cloister-router"',
  ].join("\n");
  assert.equal(findDevEscapes("cluster.toml", toml).length, 0);
});

test("ignores comments and strips a trailing inline comment", () => {
  const toml = ["[inputs.llo]", '# from = "file:///nope"', 'from = ""  # cleared'].join("\n");
  assert.equal(findDevEscapes("cluster.toml", toml).length, 0);
});

test("the shipped cluster.toml surface has no committed dev-escape", () => {
  // The live guard: recipes/rosary-dev/cluster.toml carried an absolute
  // file:/// override for one machine until this rail landed.
  assert.deepEqual(collectDevEscapes(), []);
});
