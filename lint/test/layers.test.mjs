// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/layers.mjs holds ADR-0081's map from every source file to its layer.
// These hold the shipped tree to the map, and show on a fixture tree that the
// rail catches what it exists to catch, so it cannot pass by checking nothing.
//
// Run with:
//   node --test lint/test/layers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAYERS, LAYER_SHAPE, RUNTIME, groupLines, inventory, layerOf } from "../layers.mjs";

test("every tracked source file here has a layer, and every map entry names a tracked file", () => {
  const { unclassified, unused } = inventory();
  assert.deepEqual(unclassified, [], "add each to LAYERS in lint/layers.mjs");
  assert.deepEqual(unused, [], "a map entry that matches nothing is stale");
});

test("every layer in the map is one ADR-0081 defines", () => {
  for (const [entry, layer] of Object.entries(LAYERS)) assert.match(layer, LAYER_SHAPE, entry);
});

test("core's areas are the ones ADR-0081 names; a new one is an amendment, not an entry", () => {
  const areas = new Set(Object.values(LAYERS).filter((layer) => layer.startsWith("core/")));
  assert.deepEqual([...areas].sort(), [
    "core/audit",
    "core/authority",
    "core/confinement",
    "core/content-addressing",
    "core/credentials",
    "core/declaration",
  ]);
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
  const dir = mkdtempSync(join(tmpdir(), "cloister-layers-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "kept.mjs"), "export const a = 1;\n");
    writeFileSync(join(dir, "new.mjs"), "export const b = 2;\n");
    writeFileSync(join(dir, "new.test.mjs"), "// a test needs no layer\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const { byLayer, unclassified, unused } = inventory(dir, { "kept.mjs": "core/declaration", "gone.mjs": "root" });
    assert.deepEqual(unclassified, ["new.mjs"]);
    assert.deepEqual(unused, ["gone.mjs"]);
    assert.equal(byLayer.get("core/declaration").lines, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inventory adds up: every runtime line is counted once, in its group", () => {
  const { byLayer } = inventory();
  let runtime = 0;
  for (const [layer, row] of byLayer) if (RUNTIME.includes(layer.split("/")[0])) runtime += row.lines;
  assert.equal(RUNTIME.reduce((sum, group) => sum + groupLines(byLayer, group), 0), runtime);
  for (const group of ["core", "driver", "feature"]) assert.ok(groupLines(byLayer, group) > 0, group);
});
