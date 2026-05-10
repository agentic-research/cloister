#!/usr/bin/env node
// scripts/lint-timing-invariants.mjs
//
// Drift lint for security-affecting timing constants (cloister-7ea4c4 / P1).
// Different from the path lint (cloister-7c12cc) — these constants enforce
// security invariants. Drift here is silently insecure: replays slip
// through, stale bundles get trusted, nonces get evicted before their
// certs expire. No log signal on violation.
//
// What this checks:
//
//   1. cloister.MAX_CLOCK_SKEW_MS << notme.cert_ttl_ms (with ≥4× safety margin)
//   2. cloister.BUNDLE_REFRESH_MS < notme.BUNDLE_MAX_AGE_MS
//   3. cloister.seen_nonces eviction window ≥ notme.cert_ttl_ms (when impl)
//   4. cloister.RETRY_BACKOFF_MS[0] ≤ pending-attestation alarm cadence (when impl)
//
// The cross-repo invariants need notme's source. By default the lint
// reads expected-values from a const table here AND assumes notme
// matches; if NOTME_REPO env points at a real notme checkout, it
// validates the expectations against actual source.
//
// Usage:
//   node scripts/lint-timing-invariants.mjs
//   NOTME_REPO=~/remotes/art/notme node scripts/lint-timing-invariants.mjs
//
// Exit codes:
//   0 — all invariants hold
//   1 — invariant violated; details on stderr
//   2 — couldn't read source files (toolchain failure)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ── Expected notme values ────────────────────────────────────────────────
//
// Pinned here so cloister can reason about coupled invariants without
// requiring a notme checkout. If NOTME_REPO is set, we ALSO read these
// from notme's source and assert they match — drift between this table
// and the upstream is the same class of bug we're trying to prevent.

const EXPECTED_NOTME = {
  // notme/worker/src/revocation.ts:296
  BUNDLE_MAX_AGE_MS: 5 * 60 * 1000,
  // notme/worker/src/cert-authority.ts:158 (ttlMs default in mintGHABridgeCert)
  CERT_TTL_MS:       5 * 60 * 1000,
};

// ── Read cloister's local constants ──────────────────────────────────────

const REPO = process.cwd();

function readNumberConstant(filePath, regex, label) {
  const text = readFileSync(resolve(REPO, filePath), "utf-8");
  const m = text.match(regex);
  if (!m) {
    throw new Error(`lint-timing: couldn't find ${label} in ${filePath}`);
  }
  // Evaluate the expression — these are simple `N * M * K` arithmetic
  // forms in the source; eval is safe here (we control the inputs).
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${m[1]})`)();
}

const cloister = {
  BUNDLE_REFRESH_MS: readNumberConstant(
    "src/storage/ca-bundle-cache.ts",
    /export const BUNDLE_REFRESH_MS\s*=\s*([^;]+);/,
    "BUNDLE_REFRESH_MS",
  ),
  MAX_CLOCK_SKEW_MS: readNumberConstant(
    "src/routes/lease-middleware.ts",
    /export const MAX_CLOCK_SKEW_MS\s*=\s*([^;]+);/,
    "MAX_CLOCK_SKEW_MS",
  ),
  RETRY_BACKOFF_MS_min: (() => {
    const text = readFileSync(resolve(REPO, "src/storage/pending-attestations.ts"), "utf-8");
    const m = text.match(/RETRY_BACKOFF_MS[^=]*=\s*\[([\s\S]+?)\]/);
    if (!m) throw new Error("lint-timing: couldn't find RETRY_BACKOFF_MS");
    // Strip line comments + collapse whitespace so each comma-separated
    // element is a clean numeric expression.
    const cleaned = m[1].replace(/\/\/.*$/gm, "").replace(/\s+/g, " ");
    const nums = cleaned
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => Function(`"use strict"; return (${s})`)());
    return Math.min(...nums);
  })(),
};

// ── Optionally validate notme expectations against a real checkout ───────

const notmeRepo = process.env.NOTME_REPO || resolve(homedir(), "remotes/art/notme");
let notmeValidated = false;
let notme = EXPECTED_NOTME;

if (existsSync(resolve(notmeRepo, "worker/src/revocation.ts"))) {
  try {
    const actualMaxAge = readNumberConstant(
      resolve(notmeRepo, "worker/src/revocation.ts"),
      /export const BUNDLE_MAX_AGE_MS\s*=\s*([^;]+);/,
      "notme BUNDLE_MAX_AGE_MS",
    );
    const certText = readFileSync(resolve(notmeRepo, "worker/src/cert-authority.ts"), "utf-8");
    const certMatch = certText.match(/ttlMs\s*=\s*([0-9_*\s]+),\s*\/\/[^\n]*minutes/);
    if (!certMatch) throw new Error("couldn't find ttlMs default in cert-authority.ts");
    const actualCertTtl = Function(`"use strict"; return (${certMatch[1].trim()})`)();

    const drift = [];
    if (actualMaxAge !== EXPECTED_NOTME.BUNDLE_MAX_AGE_MS) {
      drift.push(`notme.BUNDLE_MAX_AGE_MS: expected ${EXPECTED_NOTME.BUNDLE_MAX_AGE_MS}, found ${actualMaxAge}`);
    }
    if (actualCertTtl !== EXPECTED_NOTME.CERT_TTL_MS) {
      drift.push(`notme cert TTL default: expected ${EXPECTED_NOTME.CERT_TTL_MS}, found ${actualCertTtl}`);
    }
    if (drift.length) {
      console.error(`lint-timing: notme upstream drift detected:`);
      for (const d of drift) console.error(`  ${d}`);
      console.error(`Update EXPECTED_NOTME in scripts/lint-timing-invariants.mjs to match the new upstream value.`);
      process.exit(1);
    }
    notme = { BUNDLE_MAX_AGE_MS: actualMaxAge, CERT_TTL_MS: actualCertTtl };
    notmeValidated = true;
  } catch (e) {
    console.warn(`lint-timing: NOTME_REPO present but read failed; using EXPECTED_NOTME table`);
    console.warn(`  reason: ${e.message}`);
  }
}

// ── Invariants ───────────────────────────────────────────────────────────

const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(`  ✗ ${label}\n      ${detail}`);
}

// 1. Clock-skew bound is well under cert TTL (≥ 4× safety margin)
const skewSafetyRatio = notme.CERT_TTL_MS / cloister.MAX_CLOCK_SKEW_MS;
check(
  "clock-skew bound has ≥4× safety vs cert TTL",
  skewSafetyRatio >= 4,
  `cloister.MAX_CLOCK_SKEW_MS=${cloister.MAX_CLOCK_SKEW_MS}ms, notme.CERT_TTL_MS=${notme.CERT_TTL_MS}ms — ratio ${skewSafetyRatio.toFixed(2)}× (need ≥ 4×; otherwise time-shifted replay window approaches cert lifetime)`,
);

// 2. Bundle refresh strictly less than notme's max-age (with ≥30s margin)
const bundleMargin = notme.BUNDLE_MAX_AGE_MS - cloister.BUNDLE_REFRESH_MS;
check(
  "bundle refresh leaves ≥30s margin before notme considers stale",
  bundleMargin >= 30_000,
  `cloister.BUNDLE_REFRESH_MS=${cloister.BUNDLE_REFRESH_MS}ms, notme.BUNDLE_MAX_AGE_MS=${notme.BUNDLE_MAX_AGE_MS}ms — margin ${bundleMargin}ms (need ≥ 30000; else cloister fetches a bundle notme already considers revoked)`,
);

// 3. Retry backoff floor is at least 30s (sane minimum)
check(
  "retry backoff minimum is ≥ 30s (sane DO alarm cadence)",
  cloister.RETRY_BACKOFF_MS_min >= 30_000,
  `RETRY_BACKOFF_MS[0]=${cloister.RETRY_BACKOFF_MS_min}ms — must be ≥ 30s; tighter cadence pressures TrustStore`,
);

// ── Report ───────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n✗ lint-timing-invariants: ${failures.length} invariant(s) violated\n`);
  for (const f of failures) console.error(f);
  console.error("");
  console.error("These are SECURITY invariants. Do NOT relax them without an");
  console.error("ADR amendment + threat-model update.");
  console.error("");
  console.error(`See cloister-7ea4c4 + threat-model.md §6.2.7, §5.2 for context.`);
  process.exit(1);
}

console.log("lint-timing-invariants: clean ✓");
console.log(`  cloister.MAX_CLOCK_SKEW_MS = ${cloister.MAX_CLOCK_SKEW_MS}ms`);
console.log(`  cloister.BUNDLE_REFRESH_MS = ${cloister.BUNDLE_REFRESH_MS}ms`);
console.log(`  cloister.RETRY_BACKOFF_MS[0] = ${cloister.RETRY_BACKOFF_MS_min}ms`);
console.log(`  notme.BUNDLE_MAX_AGE_MS = ${notme.BUNDLE_MAX_AGE_MS}ms${notmeValidated ? " (validated against real checkout)" : " (from EXPECTED_NOTME table)"}`);
console.log(`  notme.CERT_TTL_MS = ${notme.CERT_TTL_MS}ms${notmeValidated ? " (validated)" : ""}`);
