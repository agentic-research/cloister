// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:rust-exits (ADR-0084): cloister keeps no Rust, each tree it still has
// names its exit, and the Rust only shrinks.
//
// Run with: node --test lint/test/rust-exits.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BUDGET_ADR, RUST_EXITS, isRustFile, rustBudget, rustProblems, treeOf } from "../rust-exits.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-rust-exits-"));
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

const EXITS = { "rs/": "The workspace (ADR-0084).", "rs/crates/a/": "LLO ships it (ley-line-open#1)." };
const TREE = {
  "rs/Cargo.toml": "[workspace]\n",
  "rs/crates/a/Cargo.toml": "[package]\n",
  "rs/crates/a/src/lib.rs": "pub fn a() {}\n",
};

test("the shipped tree keeps no Rust beyond the listed trees, each naming its exit, under the ceiling", () => {
  const { problems, lines, trees } = rustProblems(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(lines > 0 && lines <= rustBudget(ROOT), `${lines} lines`);
  for (const [tree, count] of trees) assert.ok(count > 0, `${tree} holds Rust`);
  assert.ok(Object.keys(RUST_EXITS).length > 0);
});

test("Rust files are source, Cargo manifests and locks, and toolchain configuration", () => {
  for (const path of ["a/src/lib.rs", "rs/Cargo.toml", "rs/Cargo.lock", "rs/rust-toolchain.toml", "rs/deny.toml", "rs/.cargo/audit.toml"]) {
    assert.equal(isRustFile(path), true, path);
  }
  for (const path of ["cli/lib/oci-artifact.mjs", "docs/rust.md", "Taskfile.yml"]) assert.equal(isRustFile(path), false, path);
  assert.equal(treeOf("rs/crates/a/src/lib.rs", EXITS), "rs/crates/a/");
  assert.equal(treeOf("rs/Cargo.lock", EXITS), "rs/");
  assert.equal(treeOf("tools/x/src/main.rs", EXITS), null);
});

test("a fixture that keeps to its list passes", () => {
  fixture(TREE, (dir) => assert.deepEqual(rustProblems(dir, { exits: EXITS, budget: 10 }).problems, []));
});

test("Rust outside every listed tree is refused", () => {
  fixture({ ...TREE, "tools/new/src/main.rs": "fn main() {}\n" }, (dir) => {
    const { problems } = rustProblems(dir, { exits: EXITS, budget: 10 });
    assert.deepEqual(problems, ["tools/new/src/main.rs is Rust in no tree RUST_EXITS lists. Cloister keeps no new Rust (ADR-0084)"]);
  });
});

test("a new crate inside a listed workspace is refused, though the workspace is listed", () => {
  fixture({ ...TREE, "rs/crates/b/Cargo.toml": "[package]\n", "rs/crates/b/src/lib.rs": "pub fn b() {}\n" }, (dir) => {
    const { problems } = rustProblems(dir, { exits: EXITS, budget: 10 });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^rs\/crates\/b\/Cargo\.toml is a crate RUST_EXITS does not list\. A new Rust crate is an amendment to ADR-0084/);
  });
});

test("an entry whose tree is gone is refused, so the list only shrinks", () => {
  fixture(TREE, (dir) => {
    const { problems } = rustProblems(dir, { exits: { ...EXITS, "tools/gone/": "LLO has it (ADR-0084)." }, budget: 10 });
    assert.deepEqual(problems, ["RUST_EXITS lists tools/gone/, which holds no tracked Rust; remove it (the list only shrinks)"]);
  });
});

test("an entry that names no exit is refused", () => {
  fixture(TREE, (dir) => {
    const { problems } = rustProblems(dir, { exits: { ...EXITS, "rs/crates/a/": "We will move it someday." }, budget: 10 });
    assert.deepEqual(problems, ["RUST_EXITS's entry for rs/crates/a/ names no exit: a bead, an issue in a named repository (repo#N) or an ADR"]);
  });
});

test("Rust over the ceiling is refused", () => {
  fixture({ ...TREE, "rs/crates/a/src/more.rs": "fn b() {}\nfn c() {}\n" }, (dir) => {
    const { problems } = rustProblems(dir, { exits: EXITS, budget: 2 });
    assert.deepEqual(problems, [`cloister has 3 lines of Rust, over ADR-0084's ceiling of 2. Shrink it, or raise rust-budget in ${BUDGET_ADR} and say why`]);
  });
});
