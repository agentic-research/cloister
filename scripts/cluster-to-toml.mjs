#!/usr/bin/env node
/**
 * scripts/cluster-to-toml.mjs — cluster.ts → canonical TOML.
 *
 * Reverse leg of the bidi pipeline (ADR-0025, cloister-ae06f3).
 * Loads the typed `cluster` const out of `src/generated/cluster.ts`,
 * canonicalizes it, and emits TOML matching the rules in ADR-0025
 * §Canonicalization.
 *
 * Pipeline:
 *
 *   src/generated/cluster.ts
 *       │
 *       │  dynamic import (tsx loader)
 *       ▼
 *   in-memory Cluster
 *       │
 *       │  canonicalize: key order, union shape, void variants
 *       ▼
 *   canonical JS object
 *       │
 *       │  @iarna/toml.stringify
 *       ▼
 *   canonical cluster.toml
 *
 * Exports `clusterToToml` so the roundtrip tests can drive the
 * conversion without spawning a subprocess. CLI entry loads the
 * default cluster.ts, converts, writes to stdout (or to the target
 * file when `--write` is passed).
 *
 * Phase 2 = stub that throws `not implemented`. Phase 4 makes it
 * green. Per docs/plans/bidi-toml-pipeline.md.
 */

/**
 * Convert a validated Cluster JS object into canonical TOML.
 *
 * Canonicalization rules (per ADR-0025 §Canonicalization):
 *   - top-level keys: metadata, bundles, wires, storage (declaration order)
 *   - inside a single table: alphabetical by key
 *   - arrays-of-tables ([[bundles]], [[wires]]): preserve declaration order
 *   - discriminated unions: kind = "<variant>" + [parent.<variant>] subtable;
 *     void variants emit just the kind tag (no subtable)
 *
 * Given the same input, produces byte-identical output. This is what
 * makes `task cluster:toml:roundtrip` a meaningful drift gate.
 *
 * @param {object} cluster
 * @returns {string} canonical TOML
 */
export function clusterToToml(_cluster) {
  throw new Error("not implemented (Phase 2 stub — see ADR-0025)");
}

// CLI entry — only runs when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  throw new Error("not implemented (Phase 2 stub — see ADR-0025)");
}
