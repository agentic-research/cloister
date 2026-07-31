// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Nothing .gitignore names may also be TRACKED.
//
// ── Why this rail exists ───────────────────────────────────────────────────
//
// `.harness-skills.json` is a per-run receipt. It is named in .gitignore — and
// it was committed anyway, in #247, into a PUBLIC repository. .gitignore has no
// effect on files git is already tracking, so the ignore was added after the
// commit and silently did nothing.
//
// What it carried was not neutral:
//
//     "skillsDir": "/Users/jamesgardner/.claude/skills",
//     "undeclared": ["agents-sdk", "art-lifecycle", "beads", "break-glass",
//                    "clerk-backend-api", ... 56 entries ]
//
// — an absolute home path plus the maintainer's private skill inventory.
//
// This is the repo's signature defect in its most literal form: the invariant
// was STATED (a .gitignore line) and nothing INVOKED it. An invariant with no
// rail is a comment. The ignore list is now checked against the index, so the
// next generated artifact that gets `git add -A`'d fails here instead of
// shipping.
//
// Deliberately a git query rather than a hardcoded filename list: a list would
// be the same manumation, one rename from useless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("no tracked file is also gitignored", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);

  // `check-ignore` exits non-zero when NOTHING matches, which is the success
  // case here — so a failure to run is the pass, and output is the defect.
  let offenders = "";
  try {
    offenders = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: ROOT, encoding: "utf8", input: tracked.join("\n"),
    });
  } catch (err) {
    // exit 1 = no tracked path is ignored. Any other status is a real error.
    if (err.status !== 1) throw err;
  }

  const bad = offenders.split("\n").filter(Boolean);
  assert.deepEqual(
    bad, [],
    `these files are gitignored AND tracked, so the ignore does nothing:\n` +
    bad.map((f) => `  ${f}`).join("\n") +
    `\nUntrack with: git rm --cached <file>`,
  );
});
