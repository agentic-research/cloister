#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:conflict-markers — no merge-conflict markers in tracked text files
// (cloister-991e65).
//
// Two `||||||| parent of …` diff3 base markers reached CHANGELOG.md: one from a
// rebase, one already sitting on main. Nothing failed, because markdown has no
// parser to choke on them and every gate read past them. A marker that ships
// means a merge was resolved by hand and not finished, and the text around it
// may be from either side.
//
// Flagged, at the start of a line in any tracked non-binary file:
//   "<<<<<<< "   "||||||| "   ">>>>>>> "   and a line that is exactly "=======".
// The separator must be alone on the line, so a setext heading underline of a
// different length, or "=======" inside prose, is not a hit.
//
// No exemptions: no tracked file needs one today. If a doc ever has to show a
// marker, indent it (an indented line does not start with the marker).
//
// Exit 0 clean, 1 on violations.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PREFIXES = ["<<<<<<< ", "||||||| ", ">>>>>>> "];
const SEPARATOR = "=======";

/** Line numbers (1-based) and text of every marker line in `text`. */
export function findMarkers(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    if (line === SEPARATOR || PREFIXES.some((p) => line.startsWith(p))) {
      hits.push({ line: i + 1, text: line });
    }
  }
  return hits;
}

/** A NUL in the first 8 KiB means binary — the same heuristic git uses. */
export function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

/** Every tracked file, via git, relative to `root`. */
export function trackedFiles(root = ROOT) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** Violations across the tracked tree: [{file, line, text}]. */
export function scanTree(root = ROOT) {
  const out = [];
  for (const file of trackedFiles(root)) {
    let buf;
    try {
      buf = readFileSync(resolve(root, file));
    } catch (error) {
      // A tracked path deleted in the working tree is not a marker; anything
      // else (permissions, a directory submodule) is reported, not swallowed.
      if (error.code === "ENOENT" || error.code === "EISDIR") continue;
      throw error;
    }
    if (isBinary(buf)) continue;
    for (const hit of findMarkers(buf.toString("utf8"))) out.push({ file, ...hit });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = scanTree();
  if (violations.length > 0) {
    console.error(`lint-conflict-markers: ${violations.length} merge-conflict marker(s) in tracked files:`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}: ${v.text}`);
    console.error("Finish the merge by hand: keep the right side, delete every marker line.");
    process.exit(1);
  }
  console.log("lint-conflict-markers: clean ✓");
}
