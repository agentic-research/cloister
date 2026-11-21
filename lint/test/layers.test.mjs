// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/layers.mjs holds ADR-0081's map from every code file to its layer, the
// rule that imports point inward, and core's budget. These hold the shipped
// tree to all three, and show on a fixture tree that the rail catches what it
// exists to catch, so it cannot pass by checking nothing.
//
// Run with:
//   node --test lint/test/layers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CORE_AREAS,
  LAYERS,
  LAYER_SHAPE,
  OUTWARD,
  RUNTIME,
  allowedImport,
  budgetProblem,
  coreBudget,
  directionProblems,
  groupLines,
  inventory,
  layerOf,
} from "../layers.mjs";

/** A git repository holding `files` (path → text), all tracked; removed afterwards. */
function fixture(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-layers-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    execFileSync("git", ["add", "."], { cwd: dir });
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every tracked code file here has a layer, and every map entry names a tracked file", () => {
  const { unclassified, unused } = inventory();
  assert.deepEqual(unclassified, [], "add each to LAYERS in lint/layers.mjs");
  assert.deepEqual(unused, [], "a map entry that matches nothing is stale");
});

test("every layer in the map is one ADR-0081 defines, and core's areas are exactly its seven", () => {
  for (const [entry, layer] of Object.entries(LAYERS)) assert.match(layer, LAYER_SHAPE, entry);
  const used = new Set(Object.values(LAYERS).filter((l) => l.startsWith("core/")).map((l) => l.slice("core/".length)));
  assert.deepEqual([...used].sort(), [...CORE_AREAS].sort());
  assert.equal(CORE_AREAS.length, 7, "an eighth area is an amendment to ADR-0081, not an entry");
});

test("the longest matching prefix wins, and a prefix without a slash names one file", () => {
  const map = { "a/": "feature/x", "a/b/": "driver/y", "a/b/c.mjs": "core/z", "a/b.mjs": "root" };
  assert.equal(layerOf("a/b/c.mjs", map), "core/z");
  assert.equal(layerOf("a/b/d.mjs", map), "driver/y");
  assert.equal(layerOf("a/b.mjs", map), "root");
  assert.equal(layerOf("a/bc.mjs", map), "feature/x", "a file prefix is not a path prefix");
  assert.equal(layerOf("z.mjs", map), null);
});

test("on a fixture tree, an unclassified file and a stale entry are each reported", () => {
  fixture({ "kept.mjs": "export const a = 1;\n", "new.mjs": "export const b = 2;\n", "new.test.mjs": "// a test needs no layer\n" }, (dir) => {
    const { byLayer, unclassified, unused } = inventory(dir, { "kept.mjs": "core/declaration", "gone.mjs": "root" });
    assert.deepEqual(unclassified, ["new.mjs"]);
    assert.deepEqual(unused, ["gone.mjs"]);
    assert.equal(byLayer.get("core/declaration").lines, 1);
  });
});

test("the inventory adds up: every runtime line is counted once, in its group", () => {
  const { byLayer } = inventory();
  let runtime = 0;
  for (const [layer, row] of byLayer) if (RUNTIME.includes(layer.split("/")[0])) runtime += row.lines;
  assert.equal(RUNTIME.reduce((sum, group) => sum + groupLines(byLayer, group), 0), runtime);
  for (const group of ["core", "driver", "feature"]) assert.ok(groupLines(byLayer, group) > 0, group);
});

test("which way an import may point (ADR-0081 §3)", () => {
  const cases = [
    ["core/audit", "core/authority", true],
    ["core/audit", "driver/workerd", false],
    ["core/audit", "feature/cli", false],
    ["driver/microvm", "core/declaration", true],
    ["driver/microvm", "driver/microvm", true],
    ["driver/microvm", "driver/compose", false, "drivers are independent"],
    ["driver/microvm", "feature/cli", false],
    ["feature/cli", "driver/microvm", true],
    ["feature/cli", "feature/harness", true, "features may build on features"],
    ["feature/cli", "root", false],
    ["root", "feature/cli", true],
    ["core/audit", "vendored", true],
    ["feature/cli", "tooling", false, "runtime code imports no tooling"],
    ["feature/cli", "config", false],
    ["tooling", "tooling", true, "tooling is not held to the rule"],
    ["tooling", "core/audit", true],
  ];
  for (const [from, to, allowed, why] of cases) assert.equal(allowedImport(from, to), allowed, `${from} -> ${to}${why ? ` (${why})` : ""}`);
});

test("imports in this tree point inward, except the listed ones, and each listed one still exists", () => {
  const { found, unlisted, stale, unresolved } = directionProblems();
  assert.deepEqual(unlisted, [], "an outward import ADR-0081 does not list");
  assert.deepEqual(stale, [], "a listed import that no longer exists: remove it from OUTWARD");
  assert.deepEqual(unresolved, []);
  assert.equal(found.size, OUTWARD.length);
  for (const { from } of found.values()) assert.ok(from.startsWith("core/"), "every outward import today starts in core");
});

test("on a fixture tree, an outward import is caught in a script, in Rust and in Cap'n Proto; a listed one is not, and a stale one is", () => {
  const files = {
    "core.mjs": "import { d } from './driver.mjs';\nimport data from './data.json' with { type: 'json' };\nexport const c = d;\n",
    "driver.mjs": "import { c } from './core.mjs';\nexport const d = 1;\n",
    "feature.mjs": "import { d } from './driver.mjs';\nimport { o } from './other.mjs';\nimport { m } from './missing.mjs';\n",
    "other.mjs": "export const o = 1;\n",
    "data.json": "{}\n",
    "crate/Cargo.toml": "[package]\nname = \"fixture-crate\"\nversion = \"0.0.0\"\n",
    "crate/src/lib.rs": "pub mod core;\npub mod driver;\n",
    "crate/src/core.rs": "// crate::driver in a comment is not an import\nconst S: &str = \"crate::driver\";\nuse crate::driver::Thing;\n",
    "crate/src/driver.rs": "pub struct Thing;\n",
    "schema/core.capnp": "@0xd1;\n# using X = import \"other.capnp\";\nusing D = import \"driver.capnp\";\n",
    "schema/driver.capnp": "@0xd2;\n",
  };
  const map = {
    "core.mjs": "core/declaration",
    "driver.mjs": "driver/microvm",
    "feature.mjs": "feature/cli",
    "other.mjs": "feature/harness",
    "crate/src/lib.rs": "driver/microvm",
    "crate/src/core.rs": "core/confinement",
    "crate/src/driver.rs": "driver/microvm",
    "schema/core.capnp": "core/declaration",
    "schema/driver.capnp": "driver/workerd",
  };
  fixture(files, (dir) => {
    const listed = ["core.mjs -> driver.mjs", "gone.mjs -> core.mjs"];
    const { found, unlisted, stale, unresolved } = directionProblems(dir, map, listed);
    assert.deepEqual([...found.keys()].sort(), [
      "core.mjs -> driver.mjs",
      "crate/src/core.rs -> crate/src/driver.rs",
      "schema/core.capnp -> schema/driver.capnp",
    ]);
    assert.deepEqual(unlisted, [
      "crate/src/core.rs -> crate/src/driver.rs (core/confinement -> driver/microvm)",
      "schema/core.capnp -> schema/driver.capnp (core/declaration -> driver/workerd)",
    ]);
    assert.deepEqual(stale, ["gone.mjs -> core.mjs"]);
    assert.deepEqual(unresolved, ["feature.mjs imports missing.mjs, which is no tracked file"], "data (JSON) has no direction; a missing script does");
  });
});

test("core fits ADR-0081's budget, which its frontmatter states", () => {
  const budget = coreBudget();
  assert.ok(Number.isInteger(budget) && budget > 0);
  const { byLayer } = inventory();
  assert.equal(budgetProblem(groupLines(byLayer, "core"), budget), null);
  assert.equal(budgetProblem(budget, budget), null, "at the budget is within it");
  assert.match(budgetProblem(budget + 1, budget), new RegExp(`core is ${budget + 1} lines, over ADR-0081's budget of ${budget}. Shrink it, or raise core-budget`));
});
