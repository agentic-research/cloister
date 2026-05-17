#!/usr/bin/env node
/**
 * scripts/toml-to-cluster.mjs — TOML → JSON → zod-validate → cluster.ts.
 *
 * Phase 1 of the bidi pipeline (ADR-0025, cloister-ae06f3). The
 * canonical operator surface is `cluster.toml` at the repo root; this
 * script lowers it to the typed `src/generated/cluster.ts` that the
 * deployment emitters consume.
 *
 * Pipeline:
 *
 *   cluster.toml
 *       │
 *       │  @iarna/toml.parse  (TOML → JS object)
 *       ▼
 *   { metadata, bundles, wires, storage }
 *       │
 *       │  ClusterSchema.parse  (zod gate — fail-fast)
 *       ▼
 *   validated Cluster
 *       │
 *       │  semantic check: every Wire.from/to references a declared bundle
 *       ▼
 *   render → src/generated/cluster.ts
 *
 * Exports `parseTomlToCluster` + `renderClusterTs` so the
 * roundtrip tests can drive the pipeline without spawning a
 * subprocess. CLI entry (`if direct-invoked`) reads the TOML file,
 * runs the pipeline, writes the TS module.
 *
 * Phase 2 = stubs that throw `not implemented`. Phase 3 makes them
 * green. Per docs/plans/bidi-toml-pipeline.md.
 */

/**
 * Parse + validate a TOML cluster manifest, returning a validated
 * Cluster JS object.
 *
 * Throws on:
 *   - TOML parse errors (malformed syntax)
 *   - zod schema violations (wrong shape, missing fields)
 *   - semantic violations (wire references nonexistent bundle)
 *
 * @param {string} tomlString
 * @returns {Promise<object>} validated Cluster
 */
export async function parseTomlToCluster(_tomlString) {
  throw new Error("not implemented (Phase 2 stub — see ADR-0025)");
}

/**
 * Render a validated Cluster object as a TS module string. Output
 * shape matches what `scripts/build-cluster.mjs` produces today:
 * `export const cluster: Cluster = {...} as const;` with the same
 * header + import. The two scripts produce byte-equal output given
 * the same cluster object.
 *
 * @param {object} cluster
 * @returns {string} TS module source
 */
export function renderClusterTs(_cluster) {
  throw new Error("not implemented (Phase 2 stub — see ADR-0025)");
}

// CLI entry — only runs when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  throw new Error("not implemented (Phase 2 stub — see ADR-0025)");
}
