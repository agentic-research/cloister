#!/usr/bin/env node
// scripts/lint-app-protocol.mjs
//
// `app_protocol` namespace lint per ADR-0030 §A4 + cloister-0fa3d7.
// Companion to lint-capability-scheme.mjs (same shape, different concern).
//
// What this lint enforces
// -----------------------
// ADR-0030 §A4 declares a hybrid namespace for cross-tenant edge labels:
//
//   - `art.*`   — substrate-blessed canonical handling. Closed set
//                 maintained by ART. Adding a name requires a PR + ADR
//                 amendment. Initial set ratified 2026-06-21.
//   - `x-<v>-*` — operator-extensible opaque pass-through. Substrate
//                 makes no semantic claims; routes as-is.
//   - other     — REJECTED. Operators get a clear error pointing at
//                 the namespace rules.
//
// This lint walks `cluster.toml [[edges]].appProtocol` values (via
// cluster.ts, per the bidi pipeline) and fails the build on any
// non-conforming label.
//
// Per project convention (cloister-6f06cc resolution): NO REGEX. All
// shape checks use substring + character-range probes.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..");

// ── Validator (shared with the build path) ───────────────────────────────
//
// The blessed set and the validator live in cli/lib/app-protocol.mjs so
// toml-to-cluster can apply the same rule to ports and connections
// (cloister-991e65). Re-exported here for existing importers.

import { validateAppProtocol } from "../cli/lib/app-protocol.mjs";
export { BLESSED_LABELS, validateAppProtocol } from "../cli/lib/app-protocol.mjs";

// ── Cluster loader (mirrors lint-capability-scheme pattern) ───────────────

async function loadCluster() {
  const clusterTsPath = process.env.CLUSTER_TS ?? resolve(REPO, "src/generated/cluster.ts");
  if (!existsSync(clusterTsPath)) {
    throw new Error(
      `cluster source not found at ${clusterTsPath} — run \`task cluster:toml\` ` +
        `(or set CLUSTER_TS to point at a generated cluster.ts)`,
    );
  }
  const mod = await import(pathToFileURL(clusterTsPath).href);
  if (!mod.cluster) {
    throw new Error(`${clusterTsPath} does not export 'cluster'`);
  }
  return mod.cluster;
}

// ── Walker ────────────────────────────────────────────────────────────────

/**
 * Walks `cluster.edges[]` and returns all app_protocol violations.
 * Exported for the test suite.
 */
export function collectViolations(cluster) {
  const violations = [];
  const edges = cluster.edges ?? [];
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const value = edge?.appProtocol;
    const problem = validateAppProtocol(value);
    if (problem) {
      violations.push({
        idx: i,
        from: edge?.from ?? "<unspecified>",
        to: edge?.to ?? "<unspecified>",
        value: typeof value === "string" ? value : String(value),
        problem,
      });
    }
  }
  return violations;
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function runLint() {
  let cluster;
  try {
    cluster = await loadCluster();
  } catch (e) {
    console.error(`lint-app-protocol: ${e.message}`);
    process.exit(2);
  }

  const violations = collectViolations(cluster);

  if (violations.length) {
    console.error(`\n✗ lint-app-protocol: ${violations.length} violation(s)\n`);
    for (const v of violations) {
      console.error(`  [[edges]][${v.idx}] (from=${v.from} → to=${v.to})`);
      console.error(`    → ${v.problem}`);
    }
    console.error("");
    console.error("Namespace rules per ADR-0030 §A4:");
    console.error("  art.<name>           — substrate-blessed (closed set)");
    console.error("  x-<vendor>-<proto>   — operator-extensible (opaque)");
    console.error("");
    process.exit(1);
  }

  const edgeCount = (cluster.edges ?? []).length;
  console.log(`lint-app-protocol: clean ✓`);
  console.log(`  ${edgeCount} edge(s) walked (all conformant)`);
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  runLint();
}
