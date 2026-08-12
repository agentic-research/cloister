#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:sibling-bead-refs — a sibling repo's ADR must not decide our OPEN work
// without us noticing.
//
// ── The incident this exists for (2026-08-03) ────────────────────────────────
//
// cloister-043eb8 was filed here to decide whether LLO grants N writable roots
// or cloister folds multi-repo into one rootfs. ley-line-open's ADR-0035 had
// ALREADY resolved it — its Related block literally reads
// "cloister-043eb8 (multi-root — resolved by §4 below)" — with a third option
// neither of ours covered. A cloister ADR was drafted arguing the wrong answer
// and deleted before commit.
//
// The sibling repo pointed AT OUR BEAD BY ID and nothing surfaced it. That is
// the gap: not "we should have looked", which is a resolution, but "nothing
// looked", which is a rail.
//
// It is also the second instance of the same class. The first was designing
// ADR-0045 work that had shipped in LLO a month earlier. A rule that has been
// stated twice and violated twice is not a rule anyone is enforcing.
//
// ── What it checks ───────────────────────────────────────────────────────────
//
// Scans the sibling checkout's ADRs (main tree + any `.worktrees/*`, because a
// decision reaches us before it reaches their default branch — ADR-0035 lives
// on a worktree today) for `cloister-<6 hex>` references, then asks OUR bead
// store about each one:
//
//   OPEN      -> FAIL. A sibling wrote a decision naming work we still hold
//                open. Either their decision resolves it (close it, citing
//                them) or it does not (say why on the bead). Both are one
//                command, and both leave a record the next session can read.
//   CLOSED    -> silent. The normal end state.
//   NOT FOUND -> report, do not fail. A dangling cross-repo reference is real
//                rot, but it is the SIBLING's rot; cloister cannot fix an ID
//                that never existed here, and failing our gate on their typo
//                trains people to bypass the gate.
//
// ── Why it does not scan our ADRs for their beads ────────────────────────────
//
// The reverse direction is already covered by habit and by lint:spec-citation:
// cloister ADRs cite `ley-line-open-*` beads constantly and a wrong one is
// visible to the author. The direction that failed is the one where the other
// repo moves and we do not look. Rails go where the failure was.
//
// Skips cleanly with exit 0 when no sibling checkout exists, matching
// lint:spec-citation — CI has no LLO checkout and this must not fail there.
//
// Exit 0 clean, 1 when a sibling ADR names an open cloister bead.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where ley-line-open is checked out, if it is. Mirrors lint-spec-citation. */
export function lloRoot(env = process.env) {
  return env.CLOISTER_LLO_ROOT || join(homedir(), "remotes/art/ley-line-open");
}

const BEAD_RE = /cloister-[0-9a-f]{6}/g;

/** ADR directories to scan: the main tree plus every worktree's. */
export function adrDirs(root) {
  const dirs = [join(root, "docs/adr")];
  const wt = join(root, ".worktrees");
  if (existsSync(wt)) {
    for (const entry of readdirSync(wt)) {
      dirs.push(join(wt, entry, "docs/adr"));
    }
  }
  return dirs.filter((d) => existsSync(d) && statSync(d).isDirectory());
}

/** Every cloister bead id referenced by a sibling ADR, with where it was seen. */
export function collectRefs(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const full = join(dir, entry);
      const text = readFileSync(full, "utf8");
      for (const id of text.match(BEAD_RE) ?? []) {
        if (!seen.has(id)) seen.set(id, new Set());
        // Report the ADR by name, not by worktree path — the same decision
        // appears in every worktree and the path is noise.
        seen.get(id).add(entry);
      }
    }
  }
  return seen;
}

/** "open" | "closed" | "missing" — asked of the real store, never guessed. */
export function beadStatus(id, run = defaultRun) {
  let out;
  try {
    out = run(id);
  } catch {
    return "missing";
  }
  if (/not found/i.test(out)) return "missing";
  // `rsry bead review` prints the status token next to the id on line 1.
  const line = out.split("\n").find((l) => l.includes(id)) ?? "";
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (/\bclosed\b/.test(plain)) return "closed";
  if (/\bopen\b/.test(plain)) return "open";
  return "missing";
}

function defaultRun(id) {
  return execFileSync("rsry", ["bead", "review", id], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function defaultRunComments(id) {
  return execFileSync("rsry", ["bead", "comment", "list", id], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Has this bead been ACKNOWLEDGED against the sibling ADR citing it?
 *
 * The second clearance path, and until now it existed only in the error
 * message: the rail told you to "comment on the bead saying why it does not
 * [resolve the question]" and then ignored comments entirely, so the only way
 * to go green was to CLOSE the bead. That is the worst possible incentive — it
 * pushes you to close work that is not done in order to clear a lint, which is
 * exactly the record-destroying move the rail exists to prevent.
 *
 * Found when ley-line-open ADR-0037 cited `cloister-d303b2` in passing (an
 * accurate aside about our mirror lag) without deciding it. Correct outcome:
 * stay open, say why. The rail refused that outcome.
 *
 * An acknowledgement is a comment naming the ADR — by filename stem or by
 * `ADR-NNNN`. Deliberately not a bare marker word: the point is that somebody
 * READ the sibling's decision, and naming which one is the cheapest evidence
 * that they did.
 */
export function acknowledges(id, files, runComments = defaultRunComments) {
  let out;
  try {
    out = runComments(id);
  } catch {
    return false;
  }
  return [...files].every((file) => {
    const stem = file.replace(/\.md$/, "");
    if (out.includes(stem)) return true;
    const num = /^(\d{4})/.exec(file)?.[1];
    return num ? new RegExp(`ADR[-\\s]?${num}`, "i").test(out) : false;
  });
}

export function main({
  env = process.env,
  log = console.log,
  err = console.error,
  run = defaultRun,
  runComments = defaultRunComments,
} = {}) {
  const root = lloRoot(env);
  if (!existsSync(root)) {
    log(`lint-sibling-bead-refs: SKIPPED — no sibling checkout at ${root}`);
    log("  (set CLOISTER_LLO_ROOT to enable it)");
    return 0;
  }

  const dirs = adrDirs(root);
  if (dirs.length === 0) {
    log(`lint-sibling-bead-refs: SKIPPED — no docs/adr under ${root}`);
    return 0;
  }

  const refs = collectRefs(dirs);
  const open = [];
  const missing = [];
  for (const [id, files] of [...refs].sort()) {
    const where = [...files].sort().join(", ");
    const status = beadStatus(id, run);
    if (status === "open") {
      // Closed OR acknowledged clears. See `acknowledges` for why the second
      // path has to exist.
      if (!acknowledges(id, files, runComments)) open.push([id, where]);
      else log(`lint-sibling-bead-refs: OK — ${id} stays open, acknowledged against ${where}`);
    }
    else if (status === "missing") missing.push([id, where]);
  }

  for (const [id, where] of missing) {
    log(`lint-sibling-bead-refs: NOTE — ${id} is cited by ${where} but does not`);
    log(`  exist in this store. Dangling cross-repo reference; the sibling owns it.`);
  }

  if (open.length > 0) {
    err("lint-sibling-bead-refs: FAIL — a sibling ADR decides work we hold OPEN\n");
    for (const [id, where] of open) {
      err(`  ${id}  <-  ${where}`);
    }
    err("");
    err("  A sibling repo wrote a decision naming this bead. Read their ADR before");
    err("  designing anything against it — cloister-043eb8 was resolved in");
    err("  ley-line-open ADR-0035 §4 by an option neither side had proposed, and a");
    err("  cloister ADR arguing the wrong answer was written before anyone checked.");
    err("");
    err("  To clear: close the bead citing their ADR if it resolves the question, or");
    err("  comment on the bead saying why it does not. Either way, leave the record.");
    return 1;
  }

  const n = refs.size;
  log(`lint-sibling-bead-refs: clean ✓ (${n} cross-repo reference(s) from ` +
      `${dirs.length} sibling ADR dir(s); none name an open bead)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
