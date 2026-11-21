// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The files git tracks, which is what a rail means by "the tree": an
// untracked scratch file is not something a reader of the repository can
// open, so a citation to one is as stale as a citation to nothing.

import { execFileSync } from "node:child_process";

/** Every tracked file, relative to `root`, optionally narrowed by git pathspecs. */
export function trackedFiles(root, ...pathspecs) {
  const args = ["ls-files", "-z", ...(pathspecs.length > 0 ? ["--", ...pathspecs] : [])];
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}
