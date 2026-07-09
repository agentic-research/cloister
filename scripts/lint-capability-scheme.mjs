#!/usr/bin/env node
// scripts/lint-capability-scheme.mjs
//
// Capability-scheme lane lint per ADR-0028 §6 + leyline-schema-spec/_capability-mapping.md (LLO rs/ll-core/schema-spec/_capability-mapping.md) §6.
// Companion to lint-bundle-isolation.mjs (substrate-property class).
//
// What this lint enforces
// -----------------------
// ADR-0028 declares three identifier lanes:
//   Lane 1 — urn:signet:cap:<action>:<resource>  (capability grant on cert)
//   Lane 2 — wimse://<authority>/<context>/<id>  (workload identity)
//   Lane 3 — cloister/<name>/v<n>                (capability interface contract)
//
// Each lane owns one concern. The forbidden patterns are when a lane-1 or
// lane-2 value leaks into a lane-3 slot. `cluster.toml` `[inputs.*].provides`
// and `[inputs.*].requires` are the load-bearing lane-3 slots today; this
// lint reads them and fails the build on any non-lane-3 shape.
//
// Out of scope (future leaves):
//   - Lane 1 lint on cert extension values (needs cert-verifier integration
//     first; today the URN shape is enforced by signet/pkg/attest/x509).
//   - Lane 2 lint on Bundle.workloadIdentity (the field doesn't exist yet).
//
// Per project convention (cloister-6f06cc resolution): NO REGEX. All shape
// checks use substring + character-range probes.
//
// Per cloister-308ea4.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..");

// ── Lane-3 shape validators (substring-based, NO regex) ──────────────────

const LANE_3_PREFIX = "cloister/";
const VERSION_SEP = "/v";
const DIGEST_SEP = "@";

/**
 * Returns null if `value` matches the lane-3 shape
 * `cloister/<kebab-case>/v<digit>+` (optionally suffixed with
 * `@<digest>` per ADR-0027), otherwise returns a short string
 * describing why not. The caller turns the non-null return into a
 * violation message.
 */
export function validateLane3Shape(value) {
  if (typeof value !== "string") return "not a string";
  if (value.length === 0) return "empty string";

  // Lane-1 / lane-2 leakage gets a specific message so the operator
  // sees which lane they wrote in and what the right answer is.
  if (value.startsWith("urn:signet:")) {
    return (
      "lane-1 URN (signet capability grant) in a lane-3 slot — " +
      "provides/requires expect the cloister/<name>/v<n> interface " +
      "name; the URN belongs on the cert"
    );
  }
  if (value.startsWith("wimse:")) {
    return (
      "lane-2 WIMSE URI (workload identity) in a lane-3 slot — " +
      "provides/requires expect the cloister/<name>/v<n> interface " +
      "name; the WIMSE URI belongs in the cert subject"
    );
  }

  // Strip optional digest suffix (content-pinned ref per ADR-0027).
  const digestIdx = value.indexOf(DIGEST_SEP);
  const baseRef = digestIdx === -1 ? value : value.slice(0, digestIdx);
  if (digestIdx !== -1) {
    const digest = value.slice(digestIdx + 1);
    if (digest.length === 0) {
      return "trailing @ with no digest";
    }
    // Digest is opaque (sha256:hex etc.); not validated here beyond
    // non-emptiness — the matchmaker resolves and verifies it.
  }

  if (!baseRef.startsWith(LANE_3_PREFIX)) {
    return `does not start with "${LANE_3_PREFIX}"`;
  }
  const afterPrefix = baseRef.slice(LANE_3_PREFIX.length);

  const versionIdx = afterPrefix.lastIndexOf(VERSION_SEP);
  if (versionIdx <= 0) {
    return `missing "${VERSION_SEP}<n>" version suffix`;
  }
  const name = afterPrefix.slice(0, versionIdx);
  const version = afterPrefix.slice(versionIdx + VERSION_SEP.length);

  if (name.length === 0) return "empty name segment";
  if (name.includes("/")) {
    return `name segment "${name}" contains a slash — nested paths not allowed`;
  }
  const nameProblem = checkKebabCase(name);
  if (nameProblem) return `name segment "${name}": ${nameProblem}`;

  if (version.length === 0) return "empty version segment";
  for (const ch of version) {
    if (ch < "0" || ch > "9") {
      return `version segment "${version}" contains non-digit "${ch}"`;
    }
  }

  return null;
}

/**
 * Returns null if `s` is kebab-case (lowercase ASCII letters + digits
 * + hyphens, no leading/trailing hyphen, no doubled hyphens),
 * otherwise returns a short reason. Substring-only; no regex.
 */
function checkKebabCase(s) {
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

// ── Cluster loader (mirrors lint-bundle-isolation pattern) ───────────────

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
 * Walks `cluster.inputs[]` and returns all lane-3-shape violations.
 * Exported for the test suite — `runLint()` below is the CLI entry.
 */
export function collectViolations(cluster) {
  const violations = [];
  const inputs = cluster.inputs ?? [];
  for (const input of inputs) {
    const name = input.name ?? "<unnamed>";
    for (const slot of ["provides", "requires"]) {
      const values = input[slot] ?? [];
      for (const value of values) {
        const problem = validateLane3Shape(value);
        if (problem) {
          violations.push({
            input: name,
            slot,
            value,
            problem,
          });
        }
      }
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
    console.error(`lint-capability-scheme: ${e.message}`);
    process.exit(2);
  }

  const violations = collectViolations(cluster);

  if (violations.length) {
    console.error(`\n✗ lint-capability-scheme: ${violations.length} violation(s)\n`);
    for (const v of violations) {
      console.error(
        `  [inputs.${v.input}].${v.slot}: "${v.value}"\n` +
        `    → ${v.problem}`,
      );
    }
    console.error("");
    console.error("Lane discipline per ADR-0028 + leyline-schema-spec/_capability-mapping.md (LLO rs/ll-core/schema-spec/_capability-mapping.md):");
    console.error("  Lane 1 (signet URN)      → cert payload only");
    console.error("  Lane 2 (WIMSE URI)       → cert subject / workload identity only");
    console.error("  Lane 3 (cloister/<name>/v<n>) → provides/requires only");
    console.error("");
    process.exit(1);
  }

  const inputCount = (cluster.inputs ?? []).length;
  const slotCount = (cluster.inputs ?? []).reduce(
    (acc, i) => acc + (i.provides?.length ?? 0) + (i.requires?.length ?? 0),
    0,
  );
  console.log(`lint-capability-scheme: clean ✓`);
  console.log(`  ${inputCount} input(s) walked`);
  console.log(`  ${slotCount} provides/requires value(s) checked (all lane-3)`);
}

// Only run when invoked directly; test imports skip this block.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  runLint();
}
