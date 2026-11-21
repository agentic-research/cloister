// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/lib/citations.mjs reads file citations out of prose (Inv 15).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { staleCitations } from "../lib/citations.mjs";

const TRACKED = ["cluster.toml", "lint/bundle-isolation.mjs", "rs/crates/host-runtime/src/execution.rs"];
const lines = (file) => ({ "cluster.toml": 300, "lint/bundle-isolation.mjs": 1400, "rs/crates/host-runtime/src/execution.rs": 600 })[file];
const stale = (text) => staleCitations(text, TRACKED, lines);

test("a citation resolves by path, or by name when it has no path", () => {
  assert.deepEqual(stale("rs/crates/host-runtime/src/execution.rs and execution.rs both resolve."), []);
  assert.match(stale("krunvm.rs:769 blocks it")[0], /"krunvm\.rs:769", and no tracked file has that name/);
  assert.match(stale("rs/crates/host-runtime/src/krunvm.rs blocks it")[0], /no tracked file is at that path/);
});

test("a cited line must be one the file has", () => {
  assert.deepEqual(stale("cluster.toml:300"), []);
  assert.match(stale("cluster.toml:301")[0], /cluster\.toml has fewer than 301 lines/);
});

test("another repository's file, written repo:path, is not this tree's to check", () => {
  assert.deepEqual(stale("rosary:src/cloister_provider.rs and ley-line-open:rs/ll-open/runtime/src/service.rs"), []);
});

test("sentence punctuation ends a citation, and a URL's path is not one", () => {
  assert.deepEqual(stale("It is in cluster.toml. Also lint/bundle-isolation.mjs, here."), []);
  assert.match(stale("Gone: missing.md.")[0], /"missing\.md"/);
  assert.deepEqual(stale("https://example.com/docs/missing.md"), []);
});
