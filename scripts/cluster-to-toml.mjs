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
  // Phase 2 (Commit 2): canonicalize `[[routes]]` rows. Flatten the
  // zod-nested discriminated union (`kind: { health: null }` →
  // `kind = "health"`; payload variants get a sibling table). Empty
  // list = no [[routes]] emitted (back-compat with pre-Phase-2
  // cluster.toml). Per cloister-345ad1 / ADR-0031.
  if (Array.isArray(c.routes) && c.routes.length > 0) {
    out.routes = c.routes.map(canonicalizeRoute);
  }
  // Phase 4a (cloister-c919d7 / ADR-0031): emit `[gateway]` block when
  // at least one field is populated. Skip the section entirely on the
  // all-empty back-compat default so pre-Phase-4a cluster.toml files
  // don't gain a stray `[gateway]` header on roundtrip — matches the
  // shape of the `[inputs]` + `[[routes]]` emit rules.
  const gatewayTable = canonicalizeGateway(c.gateway);
  if (gatewayTable !== null) out.gateway = gatewayTable;
  // ADR-0030 §A2 + §A4 (cloister-0e3004): emit `[[edges]]` array-of-
  // tables when populated. Skip on empty so single-tenant deployments
  // don't gain stray edge rows on roundtrip.
  if (Array.isArray(c.edges) && c.edges.length > 0) {
    out.edges = c.edges.map(canonicalizeEdge);
  }
  if (c.storage) out.storage = sortKeys(c.storage);
  return out;
}

/**
 * Canonicalize an EdgeSpec to TOML-row shape. Drops empty fields so
 * partial edges don't emit stray empty-string keys (consistent with
 * the inputs + routes emit rules).
 */
function canonicalizeEdge(e) {
  const body = {};
  if (typeof e.from        === "string" && e.from        !== "") body.from        = e.from;
  if (typeof e.to          === "string" && e.to          !== "") body.to          = e.to;
  if (typeof e.appProtocol === "string" && e.appProtocol !== "") body.appProtocol = e.appProtocol;
  if (typeof e.transport   === "string" && e.transport   !== "") body.transport   = e.transport;
  return body;
}

/**
 * Phase 4a canonicalizer for the `[gateway]` block. Returns `null`
 * when every field is empty (the back-compat default — caller omits
 * the section); otherwise returns the canonical sub-table object.
 *
 * Emission rules per field:
 *   - String fields: emit only when non-empty.
 *   - UInt32 (`maxCertLifetimeSeconds`): emit only when > 0.
 *   - Boolean (`requireInterlock`): emit whenever ANY other gateway
 *     field is populated (so the operator's explicit `false` lands in
 *     TOML for oss-launch-minimal, but truly-empty gateways stay
 *     section-free).
 *
 * Keys inside each subtable are alphabetized to match the rest of
 * the canonicalization rules (sortKeys + @iarna/toml's stable-emit
 * shape).
 */
function canonicalizeGateway(g) {
  if (!g || typeof g !== "object") return null;
  const meta   = g.metadata && typeof g.metadata === "object" ? g.metadata : {};
  const actor  = g.actor    && typeof g.actor    === "object" ? g.actor    : {};
  const policy = g.policy   && typeof g.policy   === "object" ? g.policy   : {};
  const vaultProxyServices = Array.isArray(g.vaultProxyServices)
    ? g.vaultProxyServices.map(canonicalizeVaultProxyService)
    : [];

  const metaBody = {};
  if (typeof meta.name    === "string" && meta.name    !== "") metaBody.name    = meta.name;
  if (typeof meta.version === "string" && meta.version !== "") metaBody.version = meta.version;

  const actorBody = {};
  if (typeof actor.fingerprint     === "string" && actor.fingerprint     !== "") actorBody.fingerprint     = actor.fingerprint;
  if (typeof actor.algorithm       === "string" && actor.algorithm       !== "") actorBody.algorithm       = actor.algorithm;
  if (typeof actor.pubkeyBinding   === "string" && actor.pubkeyBinding   !== "") actorBody.pubkeyBinding   = actor.pubkeyBinding;
  if (typeof actor.attestationRepo === "string" && actor.attestationRepo !== "") actorBody.attestationRepo = actor.attestationRepo;
  if (typeof actor.tunnelEndpoint  === "string" && actor.tunnelEndpoint  !== "") actorBody.tunnelEndpoint  = actor.tunnelEndpoint;

  const policyBody = {};
  if (typeof policy.maxCertLifetimeSeconds === "number" && policy.maxCertLifetimeSeconds > 0) {
    policyBody.maxCertLifetimeSeconds = policy.maxCertLifetimeSeconds;
  }
  if (typeof policy.minAlgorithm === "string" && policy.minAlgorithm !== "") {
    policyBody.minAlgorithm = policy.minAlgorithm;
  }

  // Boolean `requireInterlock` lands in TOML when at least one other
  // policy field is already populated — preserves the operator's
  // explicit `false` (oss-launch-minimal sets `requireInterlock = false`
  // alongside `minAlgorithm = "ed25519"`) without sprinkling stray
  // bools on partially-populated gateways where the operator hasn't
  // touched the policy block. `maxCertLifetimeSeconds` follows the
  // same "emit only when > 0" rule above (0 is the canonical unset
  // sentinel for UInt32).
  const policyHasContent = Object.keys(policyBody).length > 0;
  if (policyHasContent && typeof policy.requireInterlock === "boolean") {
    policyBody.requireInterlock = policy.requireInterlock;
  }

  if (
    Object.keys(metaBody).length === 0 &&
    Object.keys(actorBody).length === 0 &&
    Object.keys(policyBody).length === 0 &&
    vaultProxyServices.length === 0
  ) {
    return null;
  }
  const out = {};
  if (Object.keys(metaBody).length   > 0) out.metadata = sortKeys(metaBody);
  if (Object.keys(actorBody).length  > 0) out.actor    = sortKeys(actorBody);
  if (Object.keys(policyBody).length > 0) out.policy   = sortKeys(policyBody);
  if (vaultProxyServices.length > 0) out.vaultProxyServices = vaultProxyServices;
  return sortKeys(out);
}

function canonicalizeVaultProxyService(svc) {
  const body = {};
  if (typeof svc.name === "string" && svc.name !== "") body.name = svc.name;
  if (typeof svc.upstreamBaseUrl === "string" && svc.upstreamBaseUrl !== "") {
    body.upstreamBaseUrl = svc.upstreamBaseUrl;
  }
  if (Array.isArray(svc.defaultAllowedSubs)) {
    body.defaultAllowedSubs = [...svc.defaultAllowedSubs];
  }
  if (typeof svc.rateLimitPerMinute === "number") {
    body.rateLimitPerMinute = svc.rateLimitPerMinute;
  }

  const injection = svc.injection && typeof svc.injection === "object" && !Array.isArray(svc.injection)
    ? svc.injection
    : {};
  const tag = pickUnionTag(injection, `gateway.vaultProxyServices[${svc.name ?? "?"}].injection`);
  body.injection = tag;
  const payload = injection[tag];
  if (payload !== null) body[tag] = canonicalizeKindPayload(payload);
  return sortKeys(body);
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
    if (typeof inp.ref            === "string" && inp.ref            !== "") body.ref            = inp.ref;
    if (typeof inp.version        === "string" && inp.version        !== "") body.version        = inp.version;
    if (typeof inp.digest         === "string" && inp.digest         !== "") body.digest         = inp.digest;
    if (typeof inp.from           === "string" && inp.from           !== "") body.from           = inp.from;
    // cloister-05334b (P1 of LLO arc): transport binding hints —
    // pass through to [[generated_backends]] rows in cluster.lock.toml.
    if (typeof inp.urlBinding     === "string" && inp.urlBinding     !== "") body.urlBinding     = inp.urlBinding;
    if (typeof inp.serviceBinding === "string" && inp.serviceBinding !== "") body.serviceBinding = inp.serviceBinding;
    if (Array.isArray(inp.provides) && inp.provides.length > 0) body.provides = [...inp.provides];
    if (Array.isArray(inp.requires) && inp.requires.length > 0) body.requires = [...inp.requires];
    // ADR-0030 §A5 (cloister-0e3004): emit a `[inputs.<name>.tenancy]`
    // sub-table when any tenancy field is populated. Drop all-empty
    // tenancy values so the emitted TOML stays minimal — operators
    // only see fields they actually declared.
    if (inp.tenancy && typeof inp.tenancy === "object" && !Array.isArray(inp.tenancy)) {
      const tBody = {};
      if (typeof inp.tenancy.mode      === "string" && inp.tenancy.mode      !== "") tBody.mode      = inp.tenancy.mode;
      if (typeof inp.tenancy.workerdId === "string" && inp.tenancy.workerdId !== "") tBody.workerdId = inp.tenancy.workerdId;
      if (inp.tenancy.trustedTier === true) tBody.trustedTier = true;
      if (Array.isArray(inp.tenancy.sharesWorkerdWith) && inp.tenancy.sharesWorkerdWith.length > 0) {
        tBody.sharesWorkerdWith = [...inp.tenancy.sharesWorkerdWith];
      }
      if (Object.keys(tBody).length > 0) body.tenancy = tBody;
    }
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
  const flat = pruneBundleScalarDefaults(scalars);

  if (kind && typeof kind === "object" && !Array.isArray(kind)) {
    const tag = pickUnionTag(kind, "Bundle.kind");
    const payload = kind[tag];
    flat.kind = tag;
    // Payload may itself contain arrays-of-tables (env: [EnvVar]).
    flat[tag] = canonicalizeBundleKindPayload(tag, payload);
  } else if (typeof kind === "string") {
    // Already TOML-flat — pass through, but locate the sibling
    // payload so canonicalization applies uniformly.
    flat.kind = kind;
    if (scalars[kind] !== undefined) {
      flat[kind] = canonicalizeBundleKindPayload(kind, scalars[kind]);
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
 * Omit schema-zero bundle scalars from canonical TOML. The reader
 * restores these defaults before zod validation, so the operator surface
 * can stay terse without changing the typed Cluster shape.
 */
function pruneBundleScalarDefaults(scalars) {
  const flat = { ...scalars };
  if (flat.description === "") delete flat.description;
  if (Array.isArray(flat.holdsCredential) && flat.holdsCredential.length === 0) delete flat.holdsCredential;
  if (flat.workerdServiceName === "") delete flat.workerdServiceName;
  if (flat.hypervisorRationale === "") delete flat.hypervisorRationale;
  if (flat.perTenant === false) delete flat.perTenant;
  return flat;
}

function canonicalizeBundleKindPayload(tag, payload) {
  const sorted = canonicalizeKindPayload(payload);
  if (tag !== "external" || !sorted || typeof sorted !== "object" || Array.isArray(sorted)) {
    return sorted;
  }

  const pruned = { ...sorted };
  if (pruned.ipcSocket === "") delete pruned.ipcSocket;
  if (pruned.httpPort === 0) delete pruned.httpPort;
  if (Array.isArray(pruned.args) && pruned.args.length === 0) delete pruned.args;
  if (Array.isArray(pruned.env) && pruned.env.length === 0) delete pruned.env;
  return pruned;
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
 * Flatten one Route's discriminated union into the TOML-flat shape.
 * Per cloister-345ad1 / ADR-0031 Phase 2.
 *
 * Zod-nested: `{ path, kind: { health: null } }`
 * TOML-flat:  `{ path, kind: "health" }` (void variants)
 *
 * Zod-nested: `{ path, kind: { serviceBindingProxy: {...} } }`
 * TOML-flat:  `{ path, kind: "serviceBindingProxy", serviceBindingProxy: {...} }`
 *
 * For `mcp`, recurses into backends — each backend has its own
 * Backend.kind union that also gets flattened.
 *
 * Void variants emit just the discriminator string with NO sibling
 * payload table (mirrors the Wire.transport pattern). Payload
 * variants emit `kind = "<variant>"` + a sibling table; the table's
 * keys are sorted alphabetically.
 */
function canonicalizeRoute(r) {
  const { kind, ...scalars } = r;
  const flat = { ...scalars };

  if (kind && typeof kind === "object" && !Array.isArray(kind)) {
    const tag = pickUnionTag(kind, "Route.kind");
    flat.kind = tag;
    const payload = kind[tag];
    if (payload !== null) {
      // Payload variant — emit a sibling subtable.
      if (tag === "mcp") {
        flat[tag] = canonicalizeMcpRouteSpec(payload);
      } else {
        flat[tag] = canonicalizeKindPayload(payload);
      }
    }
    // Void variant (payload === null): emit just the discriminator.
  } else if (typeof kind === "string") {
    // Already TOML-flat (rare in practice; defense).
    flat.kind = kind;
    if (scalars[kind] !== undefined && scalars[kind] !== null) {
      const tag = kind;
      flat[tag] = tag === "mcp"
        ? canonicalizeMcpRouteSpec(scalars[tag])
        : canonicalizeKindPayload(scalars[tag]);
    }
  } else {
    throw new Error(
      `Route (path=${JSON.stringify(r.path)}): kind union is malformed ` +
        `(expected { <variant>: payload | null } or "<variant>", got ${JSON.stringify(kind)})`,
    );
  }
  return sortKeys(flat);
}

/**
 * Canonicalize an McpRouteSpec payload. Sorts keys + flattens the
 * Backend.kind discriminated union on each entry.
 */
function canonicalizeMcpRouteSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const backends = Array.isArray(spec.backends) ? spec.backends.map(canonicalizeBackend) : [];
  return sortKeys({ ...spec, backends });
}

/**
 * Flatten one Backend's discriminated union (durableObject / mcpProxy /
 * serviceBinding / udsForward / leylineNet) into the TOML-flat shape.
 * Same pattern as canonicalizeBundle.
 */
function canonicalizeBackend(b) {
  const { kind, ...scalars } = b;
  const flat = { ...scalars };
  if (kind && typeof kind === "object" && !Array.isArray(kind)) {
    const tag = pickUnionTag(kind, "Backend.kind");
    const payload = kind[tag];
    flat.kind = tag;
    flat[tag] = canonicalizeKindPayload(payload);
  } else if (typeof kind === "string") {
    flat.kind = kind;
    if (scalars[kind] !== undefined) {
      flat[kind] = canonicalizeKindPayload(scalars[kind]);
    }
  } else {
    throw new Error(
      `Backend ${JSON.stringify(b.name)}: kind union is malformed ` +
        `(expected { <variant>: payload } or "<variant>", got ${JSON.stringify(kind)})`,
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
