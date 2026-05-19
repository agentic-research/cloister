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
 *   in-memory Cluster (zod-nested shape: kind = { external: {…} })
 *       │
 *       │  flatten discriminators + sort keys alphabetically
 *       ▼
 *   canonical JS object (TOML-flat: kind = "external", external: {…})
 *       │
 *       │  @iarna/toml.stringify
 *       ▼
 *   canonical cluster.toml
 *
 * Exports `clusterToToml` so the roundtrip tests can drive the
 * conversion without spawning a subprocess. CLI entry loads the
 * default cluster.ts, converts, writes to stdout (or to the target
 * file when `--write <path>` is passed).
 *
 * Per docs/plans/bidi-toml-pipeline.md Phase 4.
 */

import { stringify as stringifyToml } from "@iarna/toml";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_CLUSTER_TS = resolve(REPO_ROOT, "src/generated/cluster.ts");

// ── Public API ────────────────────────────────────────────────────────────

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
export function clusterToToml(cluster) {
  if (!cluster || typeof cluster !== "object") {
    throw new TypeError(`clusterToToml: expected an object, got ${typeof cluster}`);
  }
  const canonical = canonicalizeCluster(cluster);
  return stringifyToml(canonical);
}

// ── Canonicalization ──────────────────────────────────────────────────────

/**
 * Build the canonical-form JS object. Top-level keys land in
 * declaration order (metadata → bundles → wires → storage). Every
 * table-shaped value has its keys sorted alphabetically before
 * stringification.
 */
function canonicalizeCluster(c) {
  const out = {};
  // Declaration order at the top level — operators expect cluster
  // identity first, composition second, durable-state last.
  if (c.metadata) out.metadata = sortKeys(c.metadata);
  out.bundles = (c.bundles ?? []).map(canonicalizeBundle);
  out.wires = (c.wires ?? []).map(canonicalizeWire);
  // ADR-0026 / cloister-cf7a3b Phase 1a — inputs land BEFORE storage in
  // the declaration order: identity → composition (bundles + wires) →
  // external inputs (tools / skills / agent defs) → durable state.
  // Emitted as a TOML table keyed by `name` (`[inputs.<name>]` blocks)
  // which is the operator-friendly form. Omitted entirely if empty so
  // pre-Phase-1 cluster.toml files don't gain a stray `[inputs]` line.
  const inputsTable = canonicalizeInputs(c.inputs ?? []);
  if (Object.keys(inputsTable).length > 0) out.inputs = inputsTable;
  if (c.storage) out.storage = sortKeys(c.storage);
  return out;
}

/**
 * Convert the zod-array shape `[{name, ref, ...}, ...]` into the TOML-
 * table shape `{ <name>: { ref, ... } }` for emission as `[inputs.<name>]`
 * blocks. Within each entry, scalars first then lists, all sorted.
 * Drops empty strings + empty arrays from the emitted form so operators
 * see only fields they actually populated.
 */
function canonicalizeInputs(arr) {
  const out = {};
  for (const inp of arr) {
    if (!inp || typeof inp !== "object" || typeof inp.name !== "string" || inp.name === "") continue;
    const body = {};
    if (typeof inp.ref     === "string" && inp.ref     !== "") body.ref     = inp.ref;
    if (typeof inp.version === "string" && inp.version !== "") body.version = inp.version;
    if (typeof inp.digest  === "string" && inp.digest  !== "") body.digest  = inp.digest;
    if (typeof inp.from    === "string" && inp.from    !== "") body.from    = inp.from;
    if (Array.isArray(inp.provides) && inp.provides.length > 0) body.provides = [...inp.provides];
    if (Array.isArray(inp.requires) && inp.requires.length > 0) body.requires = [...inp.requires];
    out[inp.name] = body;
  }
  return out;
}

/**
 * Flatten the zod-nested `kind: { external: {…} }` into TOML-flat
 * `kind = "external" + external: {…}`. Sorts all keys alphabetically.
 * Recurses into `env: [...]` arrays (EnvVar entries).
 */
function canonicalizeBundle(b) {
  const { kind, ...scalars } = b;
  const flat = { ...scalars };

  if (kind && typeof kind === "object" && !Array.isArray(kind)) {
    const tag = pickUnionTag(kind, "Bundle.kind");
    const payload = kind[tag];
    flat.kind = tag;
    // Payload may itself contain arrays-of-tables (env: [EnvVar]).
    flat[tag] = canonicalizeKindPayload(payload);
  } else if (typeof kind === "string") {
    // Already TOML-flat — pass through, but locate the sibling
    // payload so canonicalization applies uniformly.
    flat.kind = kind;
    if (scalars[kind] !== undefined) {
      flat[kind] = canonicalizeKindPayload(scalars[kind]);
    }
  } else {
    // Malformed — let the writer fail loudly rather than silently
    // produce a bundle without a kind.
    throw new Error(
      `Bundle ${JSON.stringify(b.name)}: kind union is malformed (expected ` +
        `{ <variant>: payload } or "<variant>", got ${JSON.stringify(kind)})`,
    );
  }
  return sortKeys(flat);
}

/**
 * Canonicalize the per-variant payload (e.g. ExternalBundle,
 * WorkerdBundle). Sorts keys + canonicalizes nested arrays of tables
 * (EnvVar entries inside env).
 */
function canonicalizeKindPayload(p) {
  if (!p || typeof p !== "object") return p;
  const sorted = {};
  for (const k of Object.keys(p).sort()) {
    sorted[k] = Array.isArray(p[k])
      ? p[k].map((entry) => (entry && typeof entry === "object" ? sortKeys(entry) : entry))
      : p[k];
  }
  return sorted;
}

/**
 * Flatten the zod-nested `transport: { uds: null }` into the TOML
 * void-variant shape `transport = "uds"`. Sorts all keys.
 */
function canonicalizeWire(w) {
  const { transport, ...scalars } = w;
  const flat = { ...scalars };

  if (transport && typeof transport === "object" && !Array.isArray(transport)) {
    const tag = pickUnionTag(transport, "Wire.transport");
    flat.transport = tag;
    // All transport variants today are Void — no payload. Future
    // non-void variants would mirror the kind-payload pattern above.
  } else if (typeof transport === "string") {
    flat.transport = transport;
  } else {
    throw new Error(
      `Wire (binding=${JSON.stringify(w.binding)}): transport union is malformed ` +
        `(expected { <variant>: null } or "<variant>", got ${JSON.stringify(transport)})`,
    );
  }
  return sortKeys(flat);
}

/**
 * For a single-key union object like `{ external: {…} }`, return the
 * tag. Throws if the shape is not single-key (zod would normally
 * catch this upstream, but we double-check at the writer boundary).
 */
function pickUnionTag(union, label) {
  const keys = Object.keys(union);
  if (keys.length !== 1) {
    throw new Error(
      `${label}: discriminated-union object must have exactly one key, got ${keys.length} (${keys.join(", ")})`,
    );
  }
  return keys[0];
}

/**
 * Return a copy of `obj` with keys inserted in alphabetical order.
 * JS preserves insertion order; @iarna/toml emits scalars in object-
 * key order; combining the two gives us deterministic alphabetical
 * output within each table.
 *
 * Recurses one level for nested plain objects (e.g. EnvVar entries)
 * but does NOT recurse into arrays — array element order is
 * load-bearing (changes cluster semantics) and must be preserved.
 */
function sortKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const sorted = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    sorted[k] = v && typeof v === "object" && !Array.isArray(v) ? sortKeys(v) : v;
  }
  return sorted;
}

// ── CLI entry ─────────────────────────────────────────────────────────────

const isDirectInvocation = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isDirectInvocation) {
  await runCli();
}

async function runCli() {
  // Args: optional --write <path>. With --write, the canonical TOML
  // is written to <path>; without, it goes to stdout. Mirrors the
  // shape `task cluster:zod:check-drift` uses for tmpdir handoff.
  const args = process.argv.slice(2);
  const writeIdx = args.indexOf("--write");
  const writePath = writeIdx >= 0 ? args[writeIdx + 1] : null;
  if (writeIdx >= 0 && !writePath) {
    console.error("cluster-to-toml: --write requires a path argument");
    process.exit(1);
  }

  const sourcePath = process.env.CLUSTER_TS ?? DEFAULT_CLUSTER_TS;
  const sourceModule = await import(sourcePath);
  const cluster = sourceModule.cluster;
  if (!cluster) {
    console.error(`cluster-to-toml: ${sourcePath} does not export 'cluster'`);
    process.exit(1);
  }

  const toml = clusterToToml(cluster);

  if (writePath) {
    writeFileSync(writePath, toml);
    const rel = writePath.replace(REPO_ROOT + "/", "");
    console.error(`cluster-to-toml: wrote ${rel}`);
  } else {
    process.stdout.write(toml);
  }
}
