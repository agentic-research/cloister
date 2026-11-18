// SPDX-License-Identifier: AGPL-3.0-or-later
//
// schema-root — where capnp's import root lives (cloister-70df69).
//
// `import "/cloister/manifest/cloister.capnp"` needs a literal
// `cloister/`-named directory AT the import root. Parent-of-parent gives that
// in the main checkout and NOT in a git worktree, whose path is
// `~/.rsry/worktrees/cloister/<bead>/` with no `cloister/` sibling.
//
// CLAUDE.md used to answer this with a workaround: export
// CLOISTER_SCHEMA_ROOT. Two problems with a workaround. Tests that spawn
// `task manifest` inherit the caller's env, so 19 script tests failed in any
// worktree and passed in the main checkout and CI — a signal indistinguishable
// from a real regression until checked, which cost two investigations in one
// session. And FIVE scripts invoke capnp with an import root, so a
// per-script fix leaves four of them broken; the first draft of this fix did
// exactly that and `lint:tenant-docs` failed next.
//
// So the derivation lives here, once, and every capnp caller imports it.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the capnp import root.
 *
 * @param {object} opts
 * @param {string} opts.schemaFile  path to manifest/<name>.capnp
 * @param {string} [opts.cwd]       repo dir for the git lookup
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {string} absolute path containing a `cloister/` directory
 */
export function schemaRoot({ schemaFile, cwd = process.cwd(), env = process.env }) {
  if (env.CLOISTER_SCHEMA_ROOT) return env.CLOISTER_SCHEMA_ROOT;

  const naive = resolve(dirname(schemaFile), "../..");
  if (existsSync(join(naive, "cloister"))) return naive;

  try {
    // In a worktree, --git-common-dir points at the MAIN checkout's .git, so
    // its grandparent is a directory that does contain `cloister/`.
    const commonDir = execFileSync(
      "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parent = dirname(dirname(commonDir));
    if (existsSync(join(parent, "cloister"))) return parent;
  } catch {
    // lint-allow-silent: git absent or not a repo is not an error here. Fall
    // back to the naive root and let capnp report the real problem — a schema
    // import diagnostic is clearer than a git one for a schema-path issue.
  }
  return naive;
}
