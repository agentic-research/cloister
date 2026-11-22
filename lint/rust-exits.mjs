#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:rust-exits — cloister keeps no Rust (ADR-0084). Each Rust tree it still
// has is migration state that names its exit, and the Rust only shrinks:
//
//   - every tracked Rust or Cargo file lies in a tree RUST_EXITS lists;
//   - every tracked Cargo.toml is a listed tree's own, so a new crate inside
//     the workspace is refused as well;
//   - each entry names its exit: a bead, an issue in a named repository, or an
//     ADR (the rule Inv 13 applies to a process bundle);
//   - an entry whose tree is gone is refused, so the list only shrinks;
//   - the tracked .rs lines stay under `rust-budget` in ADR-0084's frontmatter.
//
// Exit 0 clean, 1 on violations.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { namedExits } from "./lib/citations.mjs";
import { trackedFiles } from "./lib/tracked-files.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BUDGET_ADR = "docs/adr/0084-cloister-keeps-no-rust.md";

/**
 * Each Rust tree cloister still has, and the work that ends it (ADR-0084 §2).
 * A file belongs to the longest entry its path starts with.
 */
export const RUST_EXITS = Object.freeze({
  "rs/": "The workspace, its lock and its audit configuration. It goes with the last crate in it (ADR-0084).",
  "rs/crates/cas/":
    "LLO publishes leyline-cas-ffi built for wasm32 (ley-line-open#605), and cloister pins that artifact by " +
    "digest (ADR-0084).",
  "rs/crates/host-runtime/":
    "Runs go through LLO's execution daemon (ADR-0079; ley-line-open#602, ley-line-open#603), and LLO gives " +
    "a caller that is not Rust a way to build a run's spec, grant and evidence (ley-line-open#606).",
  "tools/harness-sandbox/":
    "LLO ports its kernel-level confinement assertions (ley-line-open-704853). Until then, deleting it trades " +
    "proof for convention (ADR-0049).",
  "tools/edge-probe/":
    "The witness becomes a script run in a pinned image, once a microVM boots in CI to prove the swap (ADR-0084).",
});

/** Whether `path` is Rust's: source, a Cargo manifest or lock, or toolchain and Cargo configuration. */
export function isRustFile(path) {
  const name = path.split("/").pop();
  return name.endsWith(".rs") ||
    ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "deny.toml", "clippy.toml", "rustfmt.toml"].includes(name) ||
    path.split("/").includes(".cargo");
}

/** The entry `path` belongs to: the longest one it starts with, or null. */
export function treeOf(path, exits = RUST_EXITS) {
  let best = null;
  for (const tree of Object.keys(exits)) {
    if (path.startsWith(tree) && (best === null || tree.length > best.length)) best = tree;
  }
  return best;
}

/** Cloister's Rust ceiling in lines: `rust-budget` in ADR-0084's frontmatter. */
export function rustBudget(root = ROOT) {
  const text = readFileSync(resolve(root, BUDGET_ADR), "utf8");
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  const budget = block === undefined ? undefined : parseYaml(block)?.["rust-budget"];
  if (!Number.isInteger(budget)) throw new Error(`${BUDGET_ADR} states no integer rust-budget in its frontmatter`);
  return budget;
}

/**
 * Every way the tree breaks ADR-0084, as one sentence each.
 *
 * @returns {{problems: string[], lines: number, trees: Map<string, number>}}
 */
export function rustProblems(root = ROOT, { exits = RUST_EXITS, budget = rustBudget(root) } = {}) {
  const problems = [];
  const rust = trackedFiles(root).filter(isRustFile);
  const trees = new Map(Object.keys(exits).map((tree) => [tree, 0]));
  let lines = 0;

  for (const path of rust) {
    const tree = treeOf(path, exits);
    if (tree === null) {
      problems.push(`${path} is Rust in no tree RUST_EXITS lists. Cloister keeps no new Rust (ADR-0084)`);
      continue;
    }
    trees.set(tree, trees.get(tree) + 1);
    if (path.endsWith("/Cargo.toml") || path === "Cargo.toml") {
      const own = path.slice(0, -"Cargo.toml".length);
      if (own !== tree) {
        problems.push(`${path} is a crate RUST_EXITS does not list. A new Rust crate is an amendment to ADR-0084, not an entry`);
      }
    }
    if (path.endsWith(".rs")) lines += readFileSync(resolve(root, path), "utf8").split("\n").length - 1;
  }

  for (const [tree, exit] of Object.entries(exits)) {
    if (trees.get(tree) === 0) {
      problems.push(`RUST_EXITS lists ${tree}, which holds no tracked Rust; remove it (the list only shrinks)`);
    }
    if (namedExits(exit).length === 0) {
      problems.push(`RUST_EXITS's entry for ${tree} names no exit: a bead, an issue in a named repository (repo#N) or an ADR`);
    }
  }

  if (lines > budget) {
    problems.push(
      `cloister has ${lines} lines of Rust, over ADR-0084's ceiling of ${budget}. Shrink it, or raise rust-budget ` +
      `in ${BUDGET_ADR} and say why`,
    );
  }
  return { problems, lines, trees };
}

function main() {
  const budget = rustBudget();
  const { problems, lines, trees } = rustProblems(ROOT, { budget });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`lint-rust-exits: ${problem}`);
    process.exit(1);
  }
  const crates = [...trees.keys()].filter((tree) => tree !== "rs/").length;
  console.log(
    `lint-rust-exits: OK — ${lines} lines of Rust in ${crates} trees, each naming its exit, under ADR-0084's ` +
    `ceiling of ${budget}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
