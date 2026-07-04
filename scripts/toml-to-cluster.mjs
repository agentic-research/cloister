#!/usr/bin/env node
/**
 * scripts/toml-to-cluster.mjs — TOML → JSON → zod-validate → cluster.ts.
 *
 * Forward leg of the bidi pipeline (ADR-0025, cloister-ae06f3). The
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
 *   { metadata, bundles, wires, storage }   (TOML-flat shape)
 *       │
 *       │  un-flatten discriminated unions to the zod-expected shape
 *       ▼
 *   { …, kind: { external: {…} }, transport: { uds: null } }
 *       │
 *       │  ClusterSchema.parse  (zod gate, fail-fast)
 *       ▼
 *   validated Cluster
 *       │
 *       │  semantic check: every Wire.from/to references a declared bundle
 *       ▼
 *   render → src/generated/cluster.ts
 *
 * Exports `parseTomlToCluster` + `renderClusterTs` so the roundtrip
 * tests can drive the pipeline without spawning a subprocess. CLI
 * entry reads the TOML file, runs the pipeline, writes the TS module.
 *
 * Per docs/plans/bidi-toml-pipeline.md Phase 3.
 */

import { parse as parseToml } from "@iarna/toml";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Path constants — every reachable defaults match the existing
// build-cluster.mjs pipeline so the two stay swap-compatible.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_INPUT = resolve(REPO_ROOT, "cluster.toml");
const DEFAULT_OUTPUT = resolve(REPO_ROOT, "src/generated/cluster.ts");

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Parse + validate a TOML cluster manifest, returning a validated
 * Cluster JS object whose shape matches ClusterSchema.
 *
 * Throws on:
 *   - TOML parse errors (malformed syntax)
 *   - zod schema violations (wrong shape, missing fields)
 *   - semantic violations (wire references nonexistent bundle)
 *
 * @param {string} tomlString
 * @returns {Promise<object>} validated Cluster
 */
export async function parseTomlToCluster(tomlString) {
  // 1. Parse TOML → raw JS.
  let raw;
  try {
    raw = parseToml(tomlString);
  } catch (e) {
    throw new Error(`TOML parse error: ${e.message}`);
  }

  // 2. Un-flatten discriminated unions: TOML uses `kind = "<tag>"` +
  //    `[parent.<tag>]` sibling; zod expects `kind: { <tag>: payload }`.
  const transformed = unflattenForSchema(raw);

  // 3. Schema validate via zod (single source of truth, per ADR-0025).
  const { ClusterSchema } = await import("../src/generated/cluster.zod.ts");
  let validated;
  try {
    validated = ClusterSchema.parse(transformed);
  } catch (e) {
    throw new Error(`cluster schema validation failed:\n${formatZodError(e)}`);
  }

  // 4. Semantic checks the schema can't express:
  //    4a. Bundle names are unique. Two bundles with the same name
  //        collapse to one entry at runtime; the cluster emitters
  //        would silently pick whichever the Map iteration surfaced
  //        last. Reject at parse time.
  const bundleNames = validated.bundles.map((b) => b.name);
  const duplicateBundle = firstDuplicate(bundleNames);
  if (duplicateBundle) {
    throw new Error(
      `bundle name "${duplicateBundle}" is declared more than once ` +
        `(at indices ${findAllIndices(bundleNames, duplicateBundle).join(", ")})`,
    );
  }

  //    4b. Wire binding names are unique. The binding becomes the
  //        workerd service-binding ENV name on the `from` bundle;
  //        duplicates collide at runtime with no parse-time signal.
  const wireBindings = validated.wires.map((w) => w.binding);
  const duplicateBinding = firstDuplicate(wireBindings);
  if (duplicateBinding) {
    throw new Error(
      `wire binding "${duplicateBinding}" is declared more than once ` +
        `(at indices ${findAllIndices(wireBindings, duplicateBinding).join(", ")})`,
    );
  }

  //    4c. Every wire's from/to references a declared bundle.
  //        Schema lets any string in wire.from/to; this is the
  //        cross-field invariant the schema can't express.
  const known = new Set(bundleNames);
  validated.wires.forEach((w, i) => {
    for (const endpoint of ["from", "to"]) {
      if (!known.has(w[endpoint])) {
        throw new Error(
          `wire ${i} (binding=${w.binding}): ${endpoint} = "${w[endpoint]}" references unknown bundle ` +
            `(known: ${[...known].join(", ") || "<none>"})`,
        );
      }
    }
  });

  return validated;
}

/** Return the first duplicated value in `arr`, or null if all unique. */
function firstDuplicate(arr) {
  const seen = new Set();
  for (const v of arr) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

function findAllIndices(arr, target) {
  return arr.reduce((acc, v, i) => (v === target ? [...acc, i] : acc), []);
}

/**
 * Render a validated Cluster object as a TS module string. Output
 * mirrors what `scripts/build-cluster.mjs` produces so consumers
 * (deployment emitters) can swap between the two pipelines without
 * source-level edits.
 *
 * @param {object} cluster
 * @returns {string} TS module source
 */
export function renderClusterTs(cluster) {
  const body = JSON.stringify(cluster, null, 2);
  return `// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AUTO-GENERATED by scripts/toml-to-cluster.mjs. Do NOT edit by hand.
// Regenerate via \`task cluster:toml\` after editing cluster.toml.
//
// Source: cluster.toml → ClusterSchema.parse → this file.
// See ADR-0025 for the bidi pipeline (TOML overlay, capnp substrate).

// Side-effect import: keeps cluster.zod.ts in the dependency graph
// so \`task lint\`'s tsc pass type-checks the schema-bridge codegen
// alongside this emitted module. Same rationale as build-cluster.mjs;
// preserved so the two pipelines stay swap-compatible during the
// Phase 1 migration.
import type {} from "./cluster.zod.js";

import type { Cluster } from "../manifest/cluster-types.js";

export const cluster: Cluster = ${body} as const;
`;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Un-flatten the TOML-side discriminated-union shape into the
 * zod-side nested shape. Idempotent — passing through already-nested
 * input is a no-op.
 *
 * TOML side: `{ kind: "external", external: {...}, ...rest }`
 * Zod side:  `{ kind: { external: {...} }, ...rest }`
 */
function unflattenForSchema(raw) {
  const out = { ...raw };
  if (Array.isArray(raw.bundles)) {
    out.bundles = raw.bundles.map(unflattenBundleKind);
  }
  if (Array.isArray(raw.wires)) {
    out.wires = raw.wires.map(unflattenWireTransport);
  }
  // ADR-0026 / cloister-cf7a3b Phase 1a — `[inputs.<name>]` TOML blocks
  // parse into an OBJECT keyed by name; zod expects an ARRAY of
  // InputSpec where `name` is a first-class field. Convert here.
  // Back-compat: missing/empty `inputs` table → empty array.
  out.inputs = unflattenInputs(raw.inputs);
  // cloister-345ad1 / ADR-0031 Phase 2 — `[[routes]]` TOML blocks parse
  // as an array-of-tables; each row's discriminated-union (kind = "...")
  // needs un-flattening into the zod-nested shape. Back-compat: missing
  // `[[routes]]` → empty array.
  out.routes = unflattenRoutes(raw.routes);
  // cloister-c919d7 / ADR-0031 Phase 4a — `[gateway]` TOML block carries
  // operator-authored Gateway-level surface (metadata + actor + policy).
  // Missing `[gateway]` → all-empty value (the emitter falls through to
  // its ART-default template + emits a warning). Per the back-compat
  // contract: pre-Phase-4a cluster.toml files keep working.
  out.gateway = normalizeGateway(raw.gateway);
  // ADR-0030 §A2 + §A4 / cloister-0e3004 — `[[edges]]` TOML array of
  // cross-tenant edge declarations. Missing → empty array (back-compat:
  // pre-ADR-0030 cluster.toml has no edges; single-tenant deployments
  // never declare any).
  out.edges = unflattenEdges(raw.edges);
  return out;
}

/**
 * ADR-0030 §A2 + §A4 (cloister-0e3004): normalize `[[edges]]` TOML
 * array-of-tables into the zod-expected EdgeSpec[] shape. Defaults
 * every field to "" so partial declarations parse cleanly.
 */
function unflattenEdges(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => ({
    from:        typeof e.from        === "string" ? e.from        : "",
    to:          typeof e.to          === "string" ? e.to          : "",
    appProtocol: typeof e.appProtocol === "string" ? e.appProtocol : "",
    transport:   typeof e.transport   === "string" ? e.transport   : "",
  }));
}

/**
 * Phase 2 (Commit 2): un-flatten `[[routes]]` rows into the zod-nested
 * Route shape. Per cloister-345ad1 / ADR-0031.
 *
 * TOML side carries the discriminated union as `kind = "<variant>"` +
 * (for payload variants) a sibling `<variant> = {...}` table; the
 * zod ClusterSchema expects `kind: { <variant>: <payload> }` where
 * void variants set the payload to `null`. Same shape pattern the
 * Bundle.kind + Wire.transport un-flatteners already use.
 *
 * `mcp` is the deepest nesting: route.kind.mcp.backends[] each carry
 * their own union (BackendKind) which we delegate to the bundle-style
 * un-flattener (kind = "<variant>" + sibling payload table).
 */
function unflattenRoutes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(unflattenRoute);
}

/** Void route variants (no payload table) — must un-flatten to `{ <variant>: null }`. */
const VOID_ROUTE_KINDS = new Set([
  "health",
  "wellKnownInterlace",
  "disclosure",
  "wellKnownIdentityBridge",
  "ociRegistry",
  "wellKnownMcpRegistry",
  "caBundle",
]);

function unflattenRoute(r) {
  // Already-nested form (e.g. constructed in JS, not from TOML).
  if (r && typeof r === "object" && r.kind && typeof r.kind === "object" && !Array.isArray(r.kind)) {
    return r;
  }
  if (!r || typeof r.kind !== "string") {
    // Let zod surface the precise error.
    return r;
  }
  const tag = r.kind;
  const { kind: _kind, [tag]: payload, ...rest } = r;
  if (VOID_ROUTE_KINDS.has(tag)) {
    // Void variant — zod expects `null` payload.
    return { ...rest, kind: { [tag]: null } };
  }
  // Payload variant — recurse for `mcp` (backends carry their own union).
  if (tag === "mcp") {
    return { ...rest, kind: { mcp: unflattenMcpRouteSpec(payload) } };
  }
  return { ...rest, kind: { [tag]: payload } };
}

function unflattenMcpRouteSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const backends = Array.isArray(spec.backends) ? spec.backends.map(unflattenBackend) : [];
  return { ...spec, backends };
}

function unflattenBackend(b) {
  if (b && typeof b === "object" && b.kind && typeof b.kind === "object" && !Array.isArray(b.kind)) {
    return b;
  }
  if (!b || typeof b.kind !== "string") {
    return b;
  }
  const tag = b.kind;
  const { kind: _kind, [tag]: payload, ...rest } = b;
  return { ...rest, kind: { [tag]: payload } };
}

function unflattenInputs(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    // Already-array shape (e.g. operator wrote `[[inputs]]` with explicit
    // `name = ...` instead of the `[inputs.<name>]` table-key sugar).
    return raw.map(normalizeInputDefaults);
  }
  if (typeof raw !== "object") return [];
  // TOML `[inputs.<name>]` → { <name>: { ref, version, ... } }
  return Object.entries(raw).map(([name, spec]) => normalizeInputDefaults({
    name,
    ...(spec && typeof spec === "object" ? spec : {}),
  }));
}

/**
 * Phase 4a (cloister-c919d7 / ADR-0031): normalize the `[gateway]` TOML
 * block into the zod-expected Gateway shape. Missing block → all-empty
 * value (zod still validates; the emitter's fall-through rule treats it
 * as "use ART-default template").
 *
 * Every field defaults to the canonical "unspecified" shape per the
 * schema's `$comment`:
 *   - Text → "" (empty string)
 *   - Bool → false
 *   - UInt32 → 0
 *
 * Operators only need to supply the fields they want to override; the
 * absent ones get the empty default. The emitter then chooses between
 * (a) using TOML values when present, or (b) falling through to the
 * ART-default template when the gateway is all-empty.
 */
function normalizeGateway(raw) {
  const g = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const metadata = (g.metadata && typeof g.metadata === "object") ? g.metadata : {};
  const actor    = (g.actor    && typeof g.actor    === "object") ? g.actor    : {};
  const policy   = (g.policy   && typeof g.policy   === "object") ? g.policy   : {};
  return {
    metadata: {
      name:    typeof metadata.name    === "string" ? metadata.name    : "",
      version: typeof metadata.version === "string" ? metadata.version : "",
    },
    actor: {
      fingerprint:     typeof actor.fingerprint     === "string" ? actor.fingerprint     : "",
      algorithm:       typeof actor.algorithm       === "string" ? actor.algorithm       : "",
      pubkeyBinding:   typeof actor.pubkeyBinding   === "string" ? actor.pubkeyBinding   : "",
      attestationRepo: typeof actor.attestationRepo === "string" ? actor.attestationRepo : "",
      tunnelEndpoint:  typeof actor.tunnelEndpoint  === "string" ? actor.tunnelEndpoint  : "",
    },
    policy: {
      maxCertLifetimeSeconds:
        typeof policy.maxCertLifetimeSeconds === "number" ? policy.maxCertLifetimeSeconds : 0,
      requireInterlock:
        typeof policy.requireInterlock === "boolean" ? policy.requireInterlock : false,
      minAlgorithm:
        typeof policy.minAlgorithm === "string" ? policy.minAlgorithm : "",
    },
  };
}

function normalizeInputDefaults(spec) {
  // Zod's strict shape requires every Text field + List field to be
  // present. Empty-string / empty-array defaults are the canonical
  // "unspecified" shape per the schema's $comment.
  // `urlBinding` / `serviceBinding` (cloister-05334b, P1 of LLO arc)
  // thread through to the [[generated_backends]] rows the resolver
  // writes — see scripts/resolve-inputs.mjs.
  // `tenancy` (ADR-0030 §A5, cloister-0e3004) defaults to all-empty
  // when absent → resolver inherits the input's server.json
  // `_meta.art.cloister/v1.tenancy` defaults (or "co-located" if the
  // server.json declares no tenancy either).
  const rawTenancy = (spec.tenancy && typeof spec.tenancy === "object" && !Array.isArray(spec.tenancy))
    ? spec.tenancy
    : {};
  return {
    name:           typeof spec.name === "string" ? spec.name : "",
    ref:            typeof spec.ref === "string" ? spec.ref : "",
    version:        typeof spec.version === "string" ? spec.version : "",
    digest:         typeof spec.digest === "string" ? spec.digest : "",
    from:           typeof spec.from === "string" ? spec.from : "",
    provides:       Array.isArray(spec.provides) ? spec.provides : [],
    requires:       Array.isArray(spec.requires) ? spec.requires : [],
    urlBinding:     typeof spec.urlBinding === "string" ? spec.urlBinding : "",
    serviceBinding: typeof spec.serviceBinding === "string" ? spec.serviceBinding : "",
    tenancy: {
      mode:              typeof rawTenancy.mode      === "string" ? rawTenancy.mode      : "",
      workerdId:         typeof rawTenancy.workerdId === "string" ? rawTenancy.workerdId : "",
      trustedTier:       typeof rawTenancy.trustedTier === "boolean" ? rawTenancy.trustedTier : false,
      sharesWorkerdWith: Array.isArray(rawTenancy.sharesWorkerdWith) ? rawTenancy.sharesWorkerdWith : [],
    },
  };
}

function unflattenBundleKind(b) {
  // Pass-through if already in zod-nested form. Still applies the
  // `perTenant` default below for forward-compat with pre-cedcf3 fixtures.
  let result;
  if (b && typeof b === "object" && b.kind && typeof b.kind === "object" && !Array.isArray(b.kind)) {
    result = b;
  } else if (!b || typeof b.kind !== "string") {
    // Leave malformed input alone; zod will reject it with a clear error.
    return b;
  } else {
    const tag = b.kind;
    const payload = b[tag];
    const remaining = { ...b };
    delete remaining[tag];
    delete remaining.kind;
    result = { ...remaining, kind: { [tag]: payload } };
  }
  // cloister-cedcf3 Phase 1: `perTenant` defaults to false for back-compat
  // with pre-ADR-0034 cluster.toml. Operators opt in by declaring it
  // explicitly. Zod requires the field per the regen'd schema; this
  // default makes the requirement transparent to existing configs.
  if (typeof result.perTenant !== "boolean") {
    result = { ...result, perTenant: false };
  }
  return normalizeBundleDefaults(result);
}

function normalizeBundleDefaults(bundle) {
  if (!bundle || typeof bundle !== "object") return bundle;

  let result = {
    ...bundle,
    description:         typeof bundle.description === "string" ? bundle.description : "",
    holdsCredential:     Array.isArray(bundle.holdsCredential) ? bundle.holdsCredential : [],
    workerdServiceName:  typeof bundle.workerdServiceName === "string" ? bundle.workerdServiceName : "",
    hypervisorRationale: typeof bundle.hypervisorRationale === "string" ? bundle.hypervisorRationale : "",
    perTenant:           typeof bundle.perTenant === "boolean" ? bundle.perTenant : false,
  };

  if (result.kind && typeof result.kind === "object" && !Array.isArray(result.kind) && result.kind.external) {
    const external = result.kind.external && typeof result.kind.external === "object"
      ? result.kind.external
      : {};
    result = {
      ...result,
      kind: {
        ...result.kind,
        external: {
          image:     typeof external.image     === "string" ? external.image     : "",
          ipcSocket: typeof external.ipcSocket === "string" ? external.ipcSocket : "",
          httpPort:  typeof external.httpPort  === "number" ? external.httpPort  : 0,
          args:      Array.isArray(external.args) ? external.args : [],
          env:       Array.isArray(external.env)  ? external.env  : [],
        },
      },
    };
  }

  return result;
}

function unflattenWireTransport(w) {
  if (w && typeof w === "object" && w.transport && typeof w.transport === "object") {
    return w;
  }
  if (!w || typeof w.transport !== "string") {
    return w;
  }
  const { transport, ...rest } = w;
  // Void variants always carry `null` as the payload — matches the
  // zod schema (`z.object({ uds: z.null() }).strict()`).
  return { ...rest, transport: { [transport]: null } };
}

/**
 * Format a ZodError into a multi-line message that names every
 * field path that failed. Mirrors the shape operators see from
 * the rest of the cloister manifest-validation surface.
 */
function formatZodError(err) {
  if (!Array.isArray(err?.issues)) return String(err);
  return err.issues
    .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
}

// ── CLI entry ─────────────────────────────────────────────────────────────

const isDirectInvocation = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isDirectInvocation) {
  await runCli();
}

async function runCli() {
  const inputPath = process.env.CLUSTER_TOML ?? DEFAULT_INPUT;
  const outputPath = process.env.CLUSTER_OUTPUT ?? DEFAULT_OUTPUT;

  let tomlString;
  try {
    tomlString = readFileSync(inputPath, "utf8");
  } catch (e) {
    console.error(`toml-to-cluster: cannot read ${inputPath}: ${e.message}`);
    process.exit(1);
  }

  let cluster;
  try {
    cluster = await parseTomlToCluster(tomlString);
  } catch (e) {
    console.error(`toml-to-cluster: ${e.message}`);
    process.exit(1);
  }

  const ts = renderClusterTs(cluster);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, ts);

  const rel = outputPath.replace(REPO_ROOT + "/", "");
  console.log(`toml-to-cluster: wrote ${rel}`);
  console.log(
    `toml-to-cluster:   ${cluster.metadata?.name ?? "?"} v${cluster.metadata?.version ?? "?"}`,
  );
  console.log(
    `toml-to-cluster:   ${cluster.bundles?.length ?? 0} bundle(s), ${cluster.wires?.length ?? 0} wire(s)`,
  );
}
