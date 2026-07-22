// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:lease-gate-source — the ADR-0053 / cloister-220c9d single-source guard,
// and the first repeatable rail of the cloister-bd7210 fallback/empty-value
// audit.
//
// The lease-gate trust anchor `env.INTERLACE_ROOT_PUBKEY` decides whether auth
// is enforced. 220c9d consolidated that decision into ONE place: routes ask
// `resolveLeaseGate` / `leaseEnforced` / `gateAndVerify`, never the raw env var
// (five sites used to re-derive it inconsistently — the fragmentation the
// 5-whys traced). This lint makes that structural: it fails if any src/ file
// OUTSIDE the two legitimate homes reads `env.INTERLACE_ROOT_PUBKEY`, catching a
// re-scattered gate check before it lands.
//
// Audit heuristic (cloister-bd7210): a security-relevant condition should have
// exactly one owner. This rail enforces that for the lease gate; extend the
// (var → allowlist) table as the audit centralizes more decisions.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC = resolve(REPO_ROOT, "src");

// (env var that decides the gate) → (files allowed to read it directly).
// Every other src/ file must go through resolveLeaseGate / leaseEnforced /
// gateAndVerify (the gate) or resolveCABundle (the bundle).
export const OWNED = [
  {
    pattern: "env.INTERLACE_ROOT_PUBKEY",
    allow: [
      "src/routes/lease-gate.ts",        // resolveLeaseGate — the gate decision
      "src/storage/ca-bundle-source.ts", // resolveCABundle — the fail-closed bundle source
    ],
    fix:
      "resolve the gate via resolveLeaseGate/leaseEnforced (src/routes/lease-gate.ts) " +
      "or the bundle via resolveCABundle — never read the raw env var (ADR-0053).",
  },
];

function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...listTsFiles(abs));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts")
    ) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Find single-source violations in one file's text. Pure — exported for tests.
 * `rel` is the repo-relative POSIX path (used to check the allowlist).
 */
export function findViolations(rel, text) {
  const violations = [];
  const lines = text.split("\n");
  for (const { pattern, allow, fix } of OWNED) {
    if (allow.includes(rel)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pattern)) {
        violations.push({ rel, line: i + 1, pattern, fix });
      }
    }
  }
  return violations;
}

/** Walk src/ and collect violations across every .ts file. */
export function collectViolations() {
  const violations = [];
  for (const abs of listTsFiles(SRC)) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    violations.push(...findViolations(rel, readFileSync(abs, "utf8")));
  }
  return violations;
}

// ── CLI ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = collectViolations();
  if (violations.length > 0) {
    console.error("lint-lease-gate-source: FAIL — the lease-gate decision must have ONE home (ADR-0053):");
    for (const v of violations) {
      console.error(`  ✘ ${v.rel}:${v.line}: reads ${v.pattern} directly`);
      console.error(`      → ${v.fix}`);
    }
    process.exit(1);
  }
  console.log("lint-lease-gate-source: OK — the lease gate has a single source of truth.");
}
