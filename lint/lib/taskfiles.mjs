// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The root Taskfile and every Taskfile it includes flat, as one text.
//
// lint/, gen/ and dev/ own their tasks and are included with `flatten: true`,
// so a task keeps its name wherever it is defined. A rail that asks "which
// tasks exist" or "which command runs this file" has to read all of them: one
// that read only the root would pass on the tasks that moved out, having
// stopped looking at them.
//
// The list is read from the root's `includes:`, not restated here, so a new
// flat include is covered the day it is added.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

/** Paths, relative to `root`, of the root Taskfile and its flat includes. */
export function flatTaskfiles(root) {
  const includes = parse(readFileSync(resolve(root, "Taskfile.yml"), "utf8")).includes ?? {};
  const flat = Object.values(includes)
    .filter((entry) => entry && typeof entry === "object" && entry.flatten === true)
    .map((entry) => entry.taskfile.replace(/^\.\//, ""));
  return ["Taskfile.yml", ...flat];
}

/** Their contents, joined. Task blocks keep their two-space indent. */
export function readFlatTaskfiles(root) {
  return flatTaskfiles(root).map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
}
