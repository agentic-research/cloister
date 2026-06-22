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

// ── Substrate-blessed labels (ADR-0030 §A4) ──────────────────────────────
//
// Closed set. Adding a label requires a PR + ADR amendment. The
// substrate guarantees canonical handling for these.

export const BLESSED_LABELS = Object.freeze([
  "art.mcp-jsonrpc",
  "art.interlace-capnp",
  "art.capnp-uds",
  "art.http",
  "art.http2",
  "art.grpc",
  "art.tcp",
  "art.tls",
]);

const BLESSED_SET = new Set(BLESSED_LABELS);

const VENDOR_PREFIX = "x-";

// ── Validator ────────────────────────────────────────────────────────────

/**
 * Returns null when `value` is a well-formed app_protocol label,
 * otherwise a short reason string. Substring + char-range probes only;
 * no regex.
 *
 *   - `art.<name>`     — accepted iff `<name>` is in BLESSED_LABELS
 *                        (the full string is, that is)
 *   - `x-<vendor>-...` — accepted iff `<vendor>` is non-empty
 *                        kebab-case + at least one segment follows
 *   - anything else    — rejected with the namespace-rules message
 */
export function validateAppProtocol(value) {
  if (typeof value !== "string") return "not a string";
  if (value.length === 0) return "empty string";

  // Substrate-blessed path: exact match against the closed set.
  if (value.startsWith("art.")) {
    if (BLESSED_SET.has(value)) return null;
    return (
      `"${value}" is not a substrate-blessed label — the \`art.*\` ` +
      "namespace is a closed set; add via PR + ADR amendment. " +
      "Current blessed set: " + BLESSED_LABELS.join(", ")
    );
  }

  // Vendor-extensible path: `x-<vendor>-<protocol>` shape.
  if (value.startsWith(VENDOR_PREFIX)) {
    const afterPrefix = value.slice(VENDOR_PREFIX.length);
    if (afterPrefix.length === 0) {
      return `"${value}": empty vendor segment after "x-"`;
    }
    // Split on first hyphen → <vendor> + <rest>
    const firstHyphenIdx = afterPrefix.indexOf("-");
    if (firstHyphenIdx === -1) {
      return (
        `"${value}": x- namespace requires the shape ` +
        `\`x-<vendor>-<protocol>\` (e.g. "x-myorg-redis")`
      );
    }
    const vendor = afterPrefix.slice(0, firstHyphenIdx);
    const rest = afterPrefix.slice(firstHyphenIdx + 1);
    if (vendor.length === 0) return `"${value}": empty vendor segment`;
    const vendorProblem = checkKebabSegment(vendor);
    if (vendorProblem) return `"${value}": vendor segment "${vendor}": ${vendorProblem}`;
    if (rest.length === 0) {
      return (
        `"${value}": missing protocol segment after vendor — ` +
        `expected \`x-${vendor}-<protocol>\``
      );
    }
    const restProblem = checkKebabPath(rest);
    if (restProblem) return `"${value}": protocol segment "${rest}": ${restProblem}`;
    return null;
  }

  // Neither namespace.
  return (
    `"${value}" does not match the substrate-blessed \`art.*\` set ` +
    'nor the operator-extensible `x-<vendor>-<protocol>` shape. ' +
    "Per ADR-0030 §A4, app_protocol labels must use one of those two " +
    "namespaces. Use `x-<vendor>-...` for experimental protocols; " +
    "promote to `art.*` via PR + ADR amendment when load-bearing."
  );
}

/**
 * Returns null if `s` is one kebab segment (lowercase ASCII + digits +
 * NO hyphen). Used for the vendor portion which is a single token.
 */
function checkKebabSegment(s) {
  for (const ch of s) {
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    if (!(isLower || isDigit)) {
      return `non-kebab character "${ch}" (allowed: a-z, 0-9)`;
    }
  }
  return null;
}

/**
 * Returns null if `s` is a kebab-shaped path (lowercase + digits +
 * hyphens; no leading/trailing/doubled hyphens). Used for the rest of
 * an `x-<vendor>-<rest>` label.
 */
function checkKebabPath(s) {
  for (const ch of s) {
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    const isHyphen = ch === "-";
    if (!(isLower || isDigit || isHyphen)) {
      return `non-kebab character "${ch}" (allowed: a-z, 0-9, hyphen)`;
    }
  }
  if (s.startsWith("-")) return "leading hyphen";
  if (s.endsWith("-")) return "trailing hyphen";
  if (s.includes("--")) return "doubled hyphen";
  return null;
}

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
