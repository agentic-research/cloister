#!/usr/bin/env node
// scripts/lint-smell-rule-kinship.mjs
//
// Drift lint for the "mache-smell-rules-shaped" kinship claim (cloister-2fb46a).
//
// cloister says in three places that `done-rules/` mirrors mache's external
// smell-rule shape (Taskfile.yml `done:`, scripts/done-runner.mjs header,
// docs/reference/task-done.md). On the severity field the two have diverged,
// and the divergence is deliberate:
//
//   mache     off | warn | error    default warn     fail-OPEN
//             cmd/smell_rules.go — an observability tool; the gate decision
//             is deferred to `--fail-on` at CLI invocation.
//
//   cloister  block | warn          default block    fail-SECURE
//             scripts/done-runner.mjs — a pre-PR ship gate; an unannotated
//             rule must stop the ship.
//
// Both postures are right for their tool. What was wrong is that the
// divergence was unstated, so the kinship claim read as "these are
// interchangeable" when a rule file is portable in neither direction: a
// mache rule at `Severity: "error"` throws a ToolchainError here, and a
// cloister rule at `severity: "block"` is unrecognised there.
//
// This lint does not reconcile the vocabularies. It records both and fails
// when a live source stops matching what is recorded, so the divergence
// stays a documented fact instead of a drifting one.
//
// ── On the mache half being unobservable ─────────────────────────────────
//
// The cloister half is always checkable — it is in this repo. The mache half
// needs a mache checkout, and nothing guarantees one exists.
//
// When mache is absent the mache half is reported UNKNOWN, never satisfied.
// That is vigil's release-contract rule (§6.0, "unknown is never satisfied")
// and Interlace's PENDING-vs-GAP distinction: absence is evidence only where
// the observation was guaranteed to have been attempted. A check that passes
// because it had nothing to compare is precisely the failure mode this lint
// exists to catch — notme's cross-repo contract mirror verifies itself by
// byte-diff only when both repos happen to be checked out side by side, and
// says nothing at all on a single-checkout runner.
//
// Point at a checkout with MACHE_REPO=/path/to/mache to observe both halves.
//
// Exit codes:
//   0 — every observed half matches what is recorded here
//   1 — drift: a live source contradicts its recorded vocabulary
//   2 — toolchain error (a source file is unreadable or unparseable)

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// ── The record ───────────────────────────────────────────────────────────
//
// Both vocabularies as observed on the dates below. This is the declaration;
// everything under "Observe" re-derives the same facts from live source and
// asserts they still agree.

const RECORDED = {
  cloister: {
    accepted: ["block", "warn"],
    fallback: "block",
    posture: "fail-secure",
    role: "pre-PR ship gate — an unannotated rule blocks shipment",
    source: "scripts/done-runner.mjs",
    observedAt: "2026-07-28",
    commit: "4e12d5ec20fed0e15a5f800a609998aad3aaa794",
  },
  mache: {
    accepted: ["off", "warn", "error"],
    fallback: "warn",
    posture: "fail-open",
    role: "observability — the gate decision is deferred to --fail-on",
    source: "cmd/smell_rules.go",
    observedAt: "2026-07-28",
    commit: "48a1147265080feef1ff187790fec966a8c4566f",
  },
};

class ToolchainError extends Error {}

function read(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    throw new ToolchainError(`cannot read ${path}: ${e.message}`);
  }
}

// ── Observe: cloister ────────────────────────────────────────────────────
//
// done-runner.mjs states its vocabulary twice, and this reads both rather
// than trusting either alone:
//
//   if (parsed.severity !== undefined && parsed.severity !== "block" && ...)
//   severity: parsed.severity ?? "block",
//
// The accepted set comes from the reject guard; the fallback from the `??`.

function observeCloister() {
  // DONE_RUNNER_FILE overrides the parsed source, mirroring done-runner.mjs's
  // own DONE_RULES_DIR seam. Tests point it at mutated copies to prove this
  // lint actually fails on drift rather than merely passing today.
  const path =
    process.env.DONE_RUNNER_FILE ?? resolve(REPO_ROOT, RECORDED.cloister.source);
  const text = read(path);

  const guard = text.match(
    /if\s*\(\s*parsed\.severity\s*!==\s*undefined\s*(&&[^)]*?)\)\s*\{/,
  );
  if (!guard) {
    throw new ToolchainError(
      `${RECORDED.cloister.source}: no \`parsed.severity !== undefined && ...\` reject guard found`,
    );
  }
  const accepted = [...guard[1].matchAll(/parsed\.severity\s*!==\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  if (accepted.length === 0) {
    throw new ToolchainError(
      `${RECORDED.cloister.source}: reject guard names no severity literals`,
    );
  }

  const fallback = text.match(/severity:\s*parsed\.severity\s*\?\?\s*"([^"]+)"/);
  if (!fallback) {
    throw new ToolchainError(
      `${RECORDED.cloister.source}: no \`severity: parsed.severity ?? "..."\` default found`,
    );
  }

  return { accepted, fallback: fallback[1] };
}

// ── Observe: mache ───────────────────────────────────────────────────────
//
//   const ( SeverityOff Severity = "off"; ... )
//   func (r *SmellRule) Effective() Severity { ... default: return SeverityWarn }
//
// The accepted set comes from the const block; the fallback from Effective()'s
// default arm, resolved back through the const block to its string value.

function observeMache(macheRoot) {
  const path = resolve(macheRoot, RECORDED.mache.source);
  const text = read(path);

  const consts = [...text.matchAll(/(Severity[A-Z]\w*)\s+Severity\s*=\s*"([^"]+)"/g)];
  if (consts.length === 0) {
    throw new ToolchainError(
      `${RECORDED.mache.source}: no \`Severity<Name> Severity = "..."\` constants found`,
    );
  }
  const byIdent = new Map(consts.map((m) => [m[1], m[2]]));
  const accepted = consts.map((m) => m[2]);

  const effective = text.match(
    /func\s*\(\s*r\s*\*SmellRule\s*\)\s*Effective\s*\(\s*\)\s*Severity\s*\{([\s\S]*?)\n\}/,
  );
  if (!effective) {
    throw new ToolchainError(
      `${RECORDED.mache.source}: no \`func (r *SmellRule) Effective() Severity\` found`,
    );
  }
  const fallbackArm = effective[1].match(/default:\s*\n\s*return\s+(Severity[A-Z]\w*)/);
  if (!fallbackArm) {
    throw new ToolchainError(
      `${RECORDED.mache.source}: Effective() has no \`default: return Severity<Name>\` arm`,
    );
  }
  const fallback = byIdent.get(fallbackArm[1]);
  if (fallback === undefined) {
    throw new ToolchainError(
      `${RECORDED.mache.source}: Effective() returns unknown constant ${fallbackArm[1]}`,
    );
  }

  return { accepted, fallback };
}

// ── Locate mache, or explain why not ─────────────────────────────────────

function locateMache() {
  const explicit = process.env.MACHE_REPO;
  if (explicit) {
    if (!existsSync(resolve(explicit, RECORDED.mache.source))) {
      return {
        root: null,
        why: `MACHE_REPO=${explicit} has no ${RECORDED.mache.source}`,
      };
    }
    return { root: explicit, why: null };
  }
  const sibling = resolve(REPO_ROOT, "..", "mache");
  if (existsSync(resolve(sibling, RECORDED.mache.source))) {
    return { root: sibling, why: null };
  }
  return {
    root: null,
    why: `no MACHE_REPO set and no mache checkout at ${sibling}`,
  };
}

// ── Compare ──────────────────────────────────────────────────────────────

function compare(side, recorded, observed) {
  const problems = [];
  const recAccepted = [...recorded.accepted].sort().join(", ");
  const obsAccepted = [...observed.accepted].sort().join(", ");
  if (recAccepted !== obsAccepted) {
    problems.push(
      `accepted severities: recorded [${recAccepted}], live source has [${obsAccepted}]`,
    );
  }
  if (recorded.fallback !== observed.fallback) {
    problems.push(
      `default severity: recorded "${recorded.fallback}", live source has "${observed.fallback}"`,
    );
  }
  return { side, verdict: problems.length === 0 ? "satisfied" : "violated", problems };
}

// ── Run ──────────────────────────────────────────────────────────────────

const results = [];

try {
  results.push(compare("cloister", RECORDED.cloister, observeCloister()));

  const mache = locateMache();
  if (mache.root === null) {
    results.push({ side: "mache", verdict: "unknown", why: mache.why, problems: [] });
  } else {
    results.push(compare("mache", RECORDED.mache, observeMache(mache.root)));
  }
} catch (e) {
  if (e instanceof ToolchainError) {
    console.error(`lint-smell-rule-kinship: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const violated = results.filter((r) => r.verdict === "violated");
const unknown = results.filter((r) => r.verdict === "unknown");

if (violated.length > 0) {
  console.error(`\n✗ lint-smell-rule-kinship: recorded vocabulary contradicted by live source\n`);
  for (const r of violated) {
    const rec = RECORDED[r.side];
    console.error(`  ${r.side} (${rec.source}, recorded ${rec.observedAt} at ${rec.commit.slice(0, 7)}):`);
    for (const p of r.problems) console.error(`    - ${p}`);
  }
  console.error("");
  console.error("The two severity vocabularies are deliberately different — this lint");
  console.error("does not ask them to agree. It asks that RECORDED in this file still");
  console.error("describes both. Update RECORDED (values, observedAt, commit) in the");
  console.error("same commit as the source change, and re-check whether the kinship");
  console.error("wording in Taskfile.yml `done:`, scripts/done-runner.mjs and");
  console.error("docs/reference/task-done.md is still accurate. See cloister-2fb46a.");
  process.exit(1);
}

console.log("lint-smell-rule-kinship: clean ✓");
for (const side of ["cloister", "mache"]) {
  const rec = RECORDED[side];
  const r = results.find((x) => x.side === side);
  const mark = r.verdict === "satisfied" ? "verified" : `UNKNOWN — ${r.why}`;
  console.log(
    `  ${side.padEnd(8)} ${rec.accepted.join(" | ").padEnd(18)} default "${rec.fallback}"  (${rec.posture}) — ${mark}`,
  );
}
if (unknown.length > 0) {
  console.log("");
  console.log("  Not every half was observed. An unobserved half is UNKNOWN, never");
  console.log("  satisfied — set MACHE_REPO=/path/to/mache to check both.");
}
process.exit(0);
