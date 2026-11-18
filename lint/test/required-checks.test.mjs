// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every REQUIRED status check on main is produced by a job that still exists.
//
// A required context is a string match. GitHub does not know or care which job
// produces it — if no job posts that exact name, the check never arrives and
// the PR sits on "Expected — waiting for status" indefinitely. It does not fail;
// it never resolves. Nothing in the repo can tell you this has happened, because
// from the repo's side everything passed.
//
// This exists because I did it. Extending generated-drift.yml to gate pkg/*.go,
// I renamed its job to say so — and that job's name is a required context. The
// workflow's own header ALREADY said, in prose:
//
//     This is a required status check (branch protection on main), and a
//     path-filtered required check that doesn't trigger blocks the PR forever
//     on "Expected — waiting for status".
//
// The warning was correct, sitting directly above the line I changed, and it
// did not stop me. That is the whole argument of this repo's rails discipline
// restated at my own expense: an invariant with no rail is a comment, and a
// comment is advisory even when it is right.
//
// LIMITS, stated plainly. This test cannot read branch protection — that needs
// an authenticated API call, and the gate runs offline. So REQUIRED_CONTEXTS
// below is a hand-recorded copy, which makes it exactly the kind of duplicated
// declaration this codebase keeps deleting. It earns its place on one argument:
// the alternative is no check at all, and the failure it prevents is silent and
// unbounded rather than loud and immediate. The copy is a floor, not a mirror —
// it catches a job rename (the actual incident) and cannot catch protection
// being edited server-side. Refresh it with:
//
//     gh api repos/agentic-research/cloister/branches/main/protection \
//       --jq '.required_status_checks.contexts[]'

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

/**
 * Required status checks on `main`, as recorded 2026-07-30.
 * Verbatim strings — GitHub matches these exactly, including spacing.
 */
const REQUIRED_CONTEXTS = [
  "regen + diff (manifest, tool-schemas, cluster)",
  "lint (tsc + worker tests + script/rail tests)",
];

/** Every `name:` declared on a job across all workflows. */
function declaredJobNames() {
  if (!existsSync(WORKFLOWS)) return new Set();
  const names = new Set();
  for (const f of readdirSync(WORKFLOWS)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const src = readFileSync(resolve(WORKFLOWS, f), "utf8");
    // lint-allow-rawparse: matches the job-level `name:` by indentation. A YAML
    // parse would be cleaner, but the assertion is about the literal string
    // GitHub compares against, so reading the literal text is the closer model —
    // and it keeps working if a job moves between workflow files.
    for (const m of src.matchAll(/^ {4}name:\s*(.+?)\s*$/gm)) {
      names.add(m[1].replace(/^["']|["']$/g, ""));
    }
  }
  return names;
}

test("every required status check is produced by a job that exists", () => {
  const names = declaredJobNames();
  assert.ok(names.size > 0, "sanity: no job names found — the matcher is broken, not the workflows");

  const missing = REQUIRED_CONTEXTS.filter((c) => !names.has(c));
  assert.deepEqual(
    missing,
    [],
    `these required contexts have no job producing them, so a PR would wait on them ` +
    `forever rather than fail:\n${missing.map((m) => `  "${m}"`).join("\n")}\n\n` +
    `If a job was renamed deliberately, update branch protection FIRST (an admin ` +
    `action), then update REQUIRED_CONTEXTS here. Renaming the job alone silently ` +
    `blocks every PR.`,
  );
});

test("the recorded contexts are a plausible copy, not an empty list", () => {
  // Guards the degenerate way this test could stop meaning anything: if
  // REQUIRED_CONTEXTS were emptied, the property above passes over nothing.
  assert.ok(
    REQUIRED_CONTEXTS.length >= 2,
    "REQUIRED_CONTEXTS looks truncated — refresh it from branch protection rather than shrinking it",
  );
  for (const c of REQUIRED_CONTEXTS) {
    assert.ok(c.trim().length > 5, `"${c}" is too short to be a real check context`);
  }
});
