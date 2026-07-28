#!/usr/bin/env node
/**
 * scripts/emit-cloister-capnp.mjs — generate cloister.capnp from
 * cluster.toml (routes + gateway).
 *
 * Phase 2 (Commit 3, cloister-345ad1) seeded this with the routes
 * surface; Phase 4a (cloister-c919d7) extends it to consume the
 * `[gateway]` block (metadata + actor + policy) so per-recipe
 * `cloister.capnp` files can finally retire to a byte-identical
 * drift gate (Hybrid Model A → Pure Model A).
 *
 * Pipeline:
 *
 *   cluster.toml → routes + gateway (cluster-toml-only; no lockfile overlay)
 *                       │
 *                       ▼
 *   render canonical cloister.capnp (deterministic text)
 *
 * Layering note (load-bearing):
 *
 *   The lockfile → `[[generated_backends]]` overlay lives in
 *   `scripts/build-manifest.mjs:overlayLockfileBackends`. THAT path
 *   is where lockfile rows merge into the /mcp route's backends list,
 *   producing `src/generated/manifest.ts`. Phase 2 does NOT move the
 *   overlay into `cloister.capnp`; if it did, build-manifest's
 *   pre-existing overlay would collide with itself on every run.
 *
 *   So this emitter writes ONLY the cluster.toml-declared routes +
 *   gateway into cloister.capnp. The lockfile injection still happens
 *   downstream at `task manifest` time, exactly as in Phase 1.
 *
 * Output is byte-stable: two consecutive runs on the same inputs
 * produce identical bytes. Makes the drift gate meaningful.
 *
 * Gateway fall-through (Phase 4a back-compat):
 *
 *   When the parsed `cluster.gateway` is all-empty (the canonical
 *   default for pre-Phase-4a cluster.toml files that didn't declare
 *   `[gateway]`), the emitter falls through to the ART-default
 *   template — same shape as Phase 2's hardcoded values. This
 *   preserves cluster.toml files that pre-date Phase 4a. A warning
 *   gets written to stderr so operators see the fall-through path
 *   when they regenerate.
 *
 * Usage:
 *   node scripts/emit-cloister-capnp.mjs                   # stdout
 *   node scripts/emit-cloister-capnp.mjs --write FILE      # write to file
 *
 * Env vars:
 *   CLUSTER_TOML       path to cluster.toml      (default: ./cluster.toml)
 *   CLOISTER_OUTPUT    path to write (default: stdout unless --write)
 *   EMIT_CLOISTER_QUIET=1  silence the Phase 4a fall-through warning
 *                          (used by drift gate / tests where stderr is
 *                          checked separately).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTomlToCluster } from "./toml-to-cluster.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_TOML = resolve(REPO_ROOT, "cluster.toml");
const DEFAULT_OUTPUT = null; // stdout

// ── ART-default Gateway template (back-compat fall-through) ───────────────
//
// Phase 2 (cloister-345ad1) pinned these values as the only source for
// gateway.metadata + actor + policy. Phase 4a (cloister-c919d7) makes
// the values OPERATOR-AUTHORED via cluster.toml's `[gateway]` table —
// the template below now serves a narrower purpose: a back-compat
// fall-through when the parsed cluster's gateway is all-empty (the
// pre-Phase-4a default for cluster.toml files that don't declare
// `[gateway]`).
//
// The strings here remain EXACTLY the ones in the root cloister.capnp
// at HEAD — matching them is what makes the back-compat path
// byte-identical with the Phase 2 emitter output.
const DEFAULT_GATEWAY = {
  metadata: { name: "cloister-art", version: "0.1.0" },
  actor: {
    // Empty = the documented Interlace opt-out (src/routes/well-known.ts: an
    // empty fingerprint makes /.well-known/interlace/index.json 404). This used
    // to default to "sha256:placeholder-pinned-at-deploy-time", which is TRUTHY
    // — it sailed past that opt-out guard and PUBLISHED a fabricated actor
    // identity to any peer that discovered us. Empty fails closed; a placeholder
    // fails open. Operators pin a real `sha256:<64 hex>` at deploy time.
    fingerprint:     "",
    algorithm:       "ed25519",
    pubkeyBinding:   "INTERLACE_MASTER_PUBKEY",
    attestationRepo: "",
    tunnelEndpoint:  "",
  },
  policy: {
    maxCertLifetimeSeconds: 300,
    requireInterlock:       true,
    minAlgorithm:           "ed25519",
  },
};

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Emit a canonical cloister.capnp text from the parsed cluster.
 *
 * The lockfile overlay (`[[generated_backends]]`) is NOT applied here —
 * see `scripts/build-manifest.mjs:overlayLockfileBackends` for the
 * downstream injection at `task manifest` time. Keeping the layers
 * separate avoids "this row exists in both files" collisions when
 * cloister.capnp is regenerated.
 *
 * Phase 4a (cloister-c919d7 / ADR-0031): consumes `cluster.gateway` from
 * cluster.toml. Fall-through to ART-default template when the parsed
 * gateway is the all-empty back-compat default (`isEmptyGateway`).
 *
 * @param {object} cluster        validated Cluster object (from parseTomlToCluster)
 * @param {object} [options]
 * @param {boolean} [options.quiet=false]  silence the fall-through warning
 * @returns {string} cloister.capnp source text
 */
export function emitCloisterCapnp(cluster, options = {}) {
  if (!cluster || typeof cluster !== "object") {
    throw new TypeError("emitCloisterCapnp: expected a Cluster object");
  }
  const { gateway, usedFallthrough } = resolveGateway(cluster.gateway);
  if (usedFallthrough && !options.quiet && process.env.EMIT_CLOISTER_QUIET !== "1") {
    // Document the fall-through path so operators see when they
    // regenerate from a cluster.toml that doesn't declare `[gateway]`.
    // Stderr only — the canonical capnp output is the load-bearing
    // value on stdout, the warning is signal-only.
    process.stderr.write(
      "emit-cloister-capnp: [gateway] not declared in cluster.toml — falling " +
      "through to the ART-default template (cloister-c919d7 / ADR-0031 Phase 4a back-compat).\n",
    );
  }
  return renderCapnp({
    // gateway.metadata is the LOGICAL MANIFEST NAME (per ADR-0004:
    // "cloister-art", "cloister-mache", "cloister-constellation"), NOT
    // the cluster name. Cluster.metadata.name is the cluster identity
    // ("art-default", visible in container labels). Phase 4a lifts
    // this from `cluster.gateway` when set; falls through to the
    // ART-default template otherwise.
    metadata: gateway.metadata,
    actor: gateway.actor,
    policy: gateway.policy,
    vaultProxyServices: gateway.vaultProxyServices ?? [],
    routes: (cluster.routes ?? []).map((r) => cloneRoute(r)),
  });
}

/**
 * Phase 4a resolver: pick between the operator-authored gateway (from
 * cluster.toml `[gateway]`) and the ART-default template (back-compat
 * for pre-Phase-4a TOML files).
 *
 * Two-state semantics (intentional simplification):
 *   - All-empty gateway → ART-default template + fall-through warning.
 *   - Any field populated → use the operator's values VERBATIM.
 *
 * No field-level merge. Operators who declare `[gateway]` in
 * cluster.toml have opted into the operator-authored path; cherry-
 * picking ART-default values into their explicit declarations would
 * clobber legitimate operator intent (oss-launch-minimal explicitly
 * sets `actor.fingerprint = ""` to disable Interlace discovery — a
 * field-level merge would silently replace that with the placeholder).
 *
 * Returns the resolved gateway plus a `usedFallthrough` flag so the
 * caller can emit the back-compat warning.
 */
function resolveGateway(g) {
  if (isEmptyGateway(g)) {
    return { gateway: DEFAULT_GATEWAY, usedFallthrough: true };
  }
  return {
    gateway: normalizeGatewayForRender(g),
    usedFallthrough: false,
  };
}

/**
 * "All-empty" predicate. A gateway is empty when EVERY field on
 * metadata, actor, and policy is the zero value for its type:
 *   - String fields → "" (empty)
 *   - UInt32 (`maxCertLifetimeSeconds`) → 0
 *   - Boolean (`requireInterlock`) → false
 *
 * Any populated field flips the predicate to false + opts the operator
 * into the operator-authored path. Catches the back-compat case
 * (pre-Phase-4a cluster.toml that didn't declare `[gateway]` —
 * `parseTomlToCluster` defaults the whole struct to all-empty via
 * `normalizeGateway`).
 */
function isEmptyGateway(g) {
  if (!g || typeof g !== "object") return true;
  const m = g.metadata ?? {};
  const a = g.actor    ?? {};
  const p = g.policy   ?? {};
  const services = Array.isArray(g.vaultProxyServices) ? g.vaultProxyServices : [];
  return (
    (m.name ?? "") === "" &&
    (m.version ?? "") === "" &&
    (a.fingerprint ?? "") === "" &&
    (a.algorithm ?? "") === "" &&
    (a.pubkeyBinding ?? "") === "" &&
    (a.attestationRepo ?? "") === "" &&
    (a.tunnelEndpoint ?? "") === "" &&
    ((p.maxCertLifetimeSeconds ?? 0) === 0) &&
    ((p.requireInterlock ?? false) === false) &&
    ((p.minAlgorithm ?? "") === "") &&
    services.length === 0
  );
}

/**
 * Shape-only normalization for the render path — ensures every field
 * on the gateway is the right type (string / number / bool) so the
 * renderer's q() / interpolation can't crash on `undefined`. Does NOT
 * fall through to ART-defaults; passes operator values verbatim.
 */
function normalizeGatewayForRender(g) {
  const m = g.metadata ?? {};
  const a = g.actor    ?? {};
  const p = g.policy   ?? {};
  const services = Array.isArray(g.vaultProxyServices) ? g.vaultProxyServices : [];
  return {
    metadata: {
      name:    typeof m.name    === "string" ? m.name    : "",
      version: typeof m.version === "string" ? m.version : "",
      // Deliberately NOT added to DEFAULT_GATEWAY: that value exists to keep
      // the back-compat fall-through byte-identical, and metaNamespace omits
      // itself when empty, so the fall-through output is unchanged.
      metaNamespace: typeof m.metaNamespace === "string" ? m.metaNamespace : "",
    },
    actor: {
      fingerprint:     typeof a.fingerprint     === "string" ? a.fingerprint     : "",
      algorithm:       typeof a.algorithm       === "string" ? a.algorithm       : "",
      pubkeyBinding:   typeof a.pubkeyBinding   === "string" ? a.pubkeyBinding   : "",
      attestationRepo: typeof a.attestationRepo === "string" ? a.attestationRepo : "",
      tunnelEndpoint:  typeof a.tunnelEndpoint  === "string" ? a.tunnelEndpoint  : "",
    },
    policy: {
      maxCertLifetimeSeconds: typeof p.maxCertLifetimeSeconds === "number" ? p.maxCertLifetimeSeconds : 0,
      requireInterlock:       typeof p.requireInterlock       === "boolean" ? p.requireInterlock       : false,
      minAlgorithm:           typeof p.minAlgorithm           === "string"  ? p.minAlgorithm           : "",
    },
    vaultProxyServices: services.map(normalizeVaultProxyServiceForRender),
  };
}

function normalizeVaultProxyServiceForRender(svc) {
  const s = svc && typeof svc === "object" && !Array.isArray(svc) ? svc : {};
  return {
    name: typeof s.name === "string" ? s.name : "",
    upstreamBaseUrl: typeof s.upstreamBaseUrl === "string" ? s.upstreamBaseUrl : "",
    defaultAllowedSubs: Array.isArray(s.defaultAllowedSubs) ? s.defaultAllowedSubs : [],
    rateLimitPerMinute: typeof s.rateLimitPerMinute === "number" ? s.rateLimitPerMinute : 0,
    injection: s.injection && typeof s.injection === "object" && !Array.isArray(s.injection)
      ? s.injection
      : { authorizationBearer: null },
  };
}

function cloneRoute(r) {
  // Shallow clone is fine for void-payload routes; mcp/backends are
  // read by the renderer and not mutated. Keep this defensive though.
  if (r && r.kind && "mcp" in r.kind) {
    return {
      ...r,
      kind: {
        mcp: {
          ...r.kind.mcp,
          backends: (r.kind.mcp.backends ?? []).map((b) => ({ ...b, kind: { ...b.kind } })),
        },
      },
    };
  }
  return { ...r };
}

// ── Canonical capnp text rendering ────────────────────────────────────────

/**
 * Render the cloister.capnp source text. Stable output: two calls on
 * the same input produce byte-identical bytes.
 *
 * The shape mirrors the existing hand-edited cloister.capnp file:
 *
 *   @0xa1c0157e1a1f0001;
 *   using Cloister = import "/cloister/manifest/cloister.capnp";
 *
 *   const gateway :Cloister.Gateway = (
 *     metadata = (...),
 *     actor    = (...),
 *     policy   = (...),
 *     routes   = [ ... ],
 *   );
 *
 * The emitter includes gateway.vaultProxyServices when declared in
 * cluster.toml so the route and service registry share one operator
 * source of truth.
 */
function renderCapnp(g) {
  const lines = [];
  lines.push("# cloister.capnp — AUTO-GENERATED by scripts/emit-cloister-capnp.mjs");
  lines.push("# Per ADR-0031 (cloister-345ad1 Phase 2 + cloister-c919d7 Phase 4a).");
  lines.push("#");
  lines.push("# Source: cluster.toml [[routes]] + [gateway] — the operator-authored");
  lines.push("# route list + Gateway-level surface (metadata + actor + policy).");
  lines.push("# When [gateway] is absent / all-empty, the emitter falls through to");
  lines.push("# the ART-default template (back-compat for pre-Phase-4a cluster.toml).");
  lines.push("# The cluster.lock.toml [[generated_backends]] overlay is applied");
  lines.push("# DOWNSTREAM at `task manifest` time by scripts/build-manifest.mjs;");
  lines.push("# this file carries only the cluster.toml-declared routes.");
  lines.push("#");
  lines.push("# Do NOT edit by hand — your edits will be overwritten on the next emitter run.");
  lines.push("# To regenerate: `task emit:cloister-capnp`.");
  lines.push("");
  lines.push("@0xa1c0157e1a1f0001;");
  lines.push('using Cloister = import "/cloister/manifest/cloister.capnp";');
  lines.push("");
  lines.push("const gateway :Cloister.Gateway = (");
  // metaNamespace is omitted when empty rather than emitted as "": an absent
  // field means "use the runtime default", an empty string would assert the
  // deployment publishes under no namespace. Different claims (cloister-9c196b).
  {
    const ns = typeof g.metadata.metaNamespace === "string" ? g.metadata.metaNamespace : "";
    const nsPart = ns ? `, metaNamespace = ${q(ns)}` : "";
    lines.push(`  metadata = (name = ${q(g.metadata.name)}, version = ${q(g.metadata.version)}${nsPart}),`);
  }
  lines.push("");
  lines.push("  actor = (");
  lines.push(`    fingerprint     = ${q(g.actor.fingerprint)},`);
  lines.push(`    algorithm       = ${q(g.actor.algorithm)},`);
  lines.push(`    pubkeyBinding   = ${q(g.actor.pubkeyBinding)},`);
  lines.push(`    attestationRepo = ${q(g.actor.attestationRepo)},`);
  lines.push(`    tunnelEndpoint  = ${q(g.actor.tunnelEndpoint)},`);
  lines.push("  ),");
  lines.push("");
  lines.push("  policy = (");
  lines.push(`    maxCertLifetimeSeconds = ${g.policy.maxCertLifetimeSeconds},`);
  lines.push(`    requireInterlock       = ${g.policy.requireInterlock ? "true" : "false"},`);
  lines.push(`    minAlgorithm           = ${q(g.policy.minAlgorithm)},`);
  lines.push("  ),");
  lines.push("");
  if (Array.isArray(g.vaultProxyServices) && g.vaultProxyServices.length > 0) {
    lines.push("  vaultProxyServices = [");
    for (let i = 0; i < g.vaultProxyServices.length; i++) {
      renderVaultProxyService(lines, g.vaultProxyServices[i], i === g.vaultProxyServices.length - 1);
    }
    lines.push("  ],");
    lines.push("");
  }
  lines.push("  routes = [");
  for (let i = 0; i < g.routes.length; i++) {
    renderRoute(lines, g.routes[i], i === g.routes.length - 1);
  }
  lines.push("  ],");
  lines.push(");");
  lines.push("");
  return lines.join("\n");
}

function renderVaultProxyService(lines, svc, isLast) {
  const tag = pickTag(svc.injection, `VaultProxyService.injection (name=${svc.name})`);
  lines.push("    (");
  lines.push(`      name = ${q(svc.name)},`);
  lines.push(`      upstreamBaseUrl = ${q(svc.upstreamBaseUrl)},`);
  lines.push(`      defaultAllowedSubs = [${svc.defaultAllowedSubs.map(q).join(", ")}],`);
  lines.push(`      rateLimitPerMinute = ${svc.rateLimitPerMinute},`);
  const payload = svc.injection[tag];
  if (payload === null) {
    lines.push(`      injection = (${tag} = void),`);
  } else if (tag === "headerNamed") {
    lines.push(`      injection = (headerNamed = (name = ${q(payload.name ?? "")})),`);
  } else if (tag === "queryParam") {
    lines.push(`      injection = (queryParam = (name = ${q(payload.name ?? "")})),`);
  } else if (tag === "bodyField") {
    lines.push(`      injection = (bodyField = (path = ${q(payload.path ?? "")})),`);
  } else {
    throw new Error(`renderVaultProxyService: unsupported payload variant "${tag}"`);
  }
  lines.push(`    )${isLast ? "" : ","}`);
}

function renderRoute(lines, r, isLast) {
  const tag = pickTag(r.kind, `Route (path=${r.path})`);
  const payload = r.kind[tag];

  if (payload === null) {
    // Void variant — single-line form.
    lines.push(`    ( path = ${q(r.path)}, kind = (${tag} = void) )${isLast ? "" : ","}`);
    return;
  }

  // Payload variant — open + render.
  lines.push(`    ( path = ${q(r.path)},`);
  if (tag === "mcp") {
    renderMcpPayload(lines, payload);
  } else if (tag === "serviceBindingProxy") {
    lines.push(`      kind = (serviceBindingProxy = (`);
    lines.push(`        binding      = ${q(payload.binding)},`);
    lines.push(`        upstreamHost = ${q(payload.upstreamHost)},`);
    lines.push(`        stripPrefix  = ${q(payload.stripPrefix)},`);
    lines.push(`      )),`);
  } else if (tag === "httpProxy") {
    lines.push(`      kind = (httpProxy = (`);
    lines.push(`        urlBinding  = ${q(payload.urlBinding)},`);
    lines.push(`        stripPrefix = ${q(payload.stripPrefix)},`);
    lines.push(`      )),`);
  } else if (tag === "vaultProxy") {
    lines.push(`      kind = (vaultProxy = (`);
    lines.push(`        bundleIdName = ${q(payload.bundleIdName)},`);
    lines.push(`      )),`);
  } else if (tag === "tenantDispatch") {
    // ADR-0030 §A2 — per-tenant dispatch route. The operator declares
    // `[[routes]] kind = "tenantDispatch"` with an inline `[[routes.tenantDispatch.tenants]]`
    // array; the emitter projects it into cloister.capnp's TenantDispatchSpec.
    // Mirrors the route's runtime in `src/routes/tenant-dispatch.ts`.
    lines.push(`      kind = (tenantDispatch = (`);
    lines.push(`        tenants = [`);
    const rows = payload.tenants ?? [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sep = i === rows.length - 1 ? "" : ",";
      lines.push(`          ( name       = ${q(row.name)},`);
      lines.push(`            mode       = ${q(row.mode)},`);
      lines.push(`            matchValue = ${q(row.matchValue)},`);
      lines.push(`            binding    = ${q(row.binding)} )${sep}`);
    }
    lines.push(`        ],`);
    lines.push(`      )),`);
  } else {
    throw new Error(`renderRoute: unsupported payload variant "${tag}" on route ${r.path}`);
  }
  lines.push(`    )${isLast ? "" : ","}`);
}

function renderMcpPayload(lines, mcp) {
  lines.push(`      kind = (mcp = (`);
  lines.push(`        backends = [`);
  const backends = mcp.backends ?? [];
  for (let i = 0; i < backends.length; i++) {
    renderBackend(lines, backends[i], i === backends.length - 1);
  }
  lines.push(`        ],`);
  lines.push(`      )),`);
}

function renderBackend(lines, b, isLast) {
  const tag = pickTag(b.kind, `Backend (name=${b.name})`);
  const inner = b.kind[tag];
  lines.push(`          ( name          = ${q(b.name)},`);
  lines.push(`            handlesPrefix = ${q(b.handlesPrefix)},`);
  lines.push(`            kind = (${tag} = (`);
  switch (tag) {
    case "durableObject": {
      lines.push(`              binding = ${q(inner.binding)},`);
      lines.push(`              keyArg  = ${q(inner.keyArg)},`);
      lines.push(`              tools   = ${renderToolsInline(inner.tools)},`);
      break;
    }
    case "mcpProxy": {
      lines.push(`              urlBinding      = ${q(inner.urlBinding)},`);
      if (inner.serviceBinding) {
        lines.push(`              serviceBinding  = ${q(inner.serviceBinding)},`);
      }
      lines.push(`              tools           = ${renderToolsInline(inner.tools)},`);
      lines.push(`              dynamicTools    = ${inner.dynamicTools ? "true" : "false"},`);
      lines.push(`              stripPrefix     = ${q(inner.stripPrefix ?? "")},`);
      lines.push(`              requiresSession = ${inner.requiresSession ? "true" : "false"},`);
      if (inner.protocolMode) {
        lines.push(`              protocolMode    = ${q(inner.protocolMode)},`);
      }
      if (Array.isArray(inner.claims) && inner.claims.length > 0) {
        lines.push(`              claims          = ${renderStringList(inner.claims)},`);
      }
      break;
    }
    case "serviceBinding": {
      lines.push(`              binding = ${q(inner.binding)},`);
      lines.push(`              tools   = ${renderToolsInline(inner.tools)},`);
      break;
    }
    case "udsForward": {
      lines.push(`              socketPath = ${q(inner.socketPath)},`);
      lines.push(`              tools      = ${renderToolsInline(inner.tools)},`);
      break;
    }
    case "leylineNet": {
      lines.push(`              companionUrlBinding = ${q(inner.companionUrlBinding)},`);
      lines.push(`              upstreamId          = ${q(inner.upstreamId)},`);
      lines.push(`              tools               = ${renderToolsInline(inner.tools)},`);
      break;
    }
    default:
      throw new Error(`renderBackend: unsupported backend kind "${tag}" on ${b.name}`);
  }
  lines.push(`            )),`);
  lines.push(`          )${isLast ? "" : ","}`);
}

function renderToolsInline(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "[]";
  // For backends with a non-empty tool list (e.g. the `bead` backend),
  // emit multi-line form. The renderer above expects this to be the
  // final value on its line so we splice a continuation marker.
  // Simplest path: emit a single-line JSON-like comma-separated list
  // and let canonical reformatters expand it; for now we DO emit
  // multi-line because the existing cloister.capnp does. The
  // renderToolsBlock helper handles the indentation.
  return renderToolsBlock(tools);
}

function renderToolsBlock(tools) {
  // Returns a multi-line string fragment starting with "[" + each tool
  // on its own line + closing "]". Indentation is fixed at 16 spaces
  // (matches the backend kind context: backends[].kind.tools).
  const inner = tools.map((t) => {
    const parts = [
      `name = ${q(t.name)}`,
      `description = ${q(t.description ?? "")}`,
      `inputSchemaJson = ${q(t.inputSchemaJson ?? "")}`,
    ];
    return `                ( ${parts.join(", ")} )`;
  });
  return `[\n${inner.join(",\n")},\n              ]`;
}

function renderStringList(arr) {
  return "[ " + arr.map(q).join(", ") + " ]";
}

function pickTag(union, label) {
  if (!union || typeof union !== "object") {
    throw new Error(`${label}: kind union missing`);
  }
  const keys = Object.keys(union);
  if (keys.length !== 1) {
    throw new Error(`${label}: kind union must be single-key (got ${keys.length})`);
  }
  return keys[0];
}

function q(s) {
  // Capnp string literal — same escapes as JSON for our purposes:
  // backslash + quote escapes; no \uXXXX for ascii. We rely on JSON
  // stringify and accept that as the canonical form.
  return JSON.stringify(s == null ? "" : String(s));
}

// ── CLI entry ─────────────────────────────────────────────────────────────

const isDirectInvocation = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isDirectInvocation) {
  await runCli();
}

async function runCli() {
  const args = process.argv.slice(2);
  const writeIdx = args.indexOf("--write");
  const writePath = writeIdx >= 0 ? args[writeIdx + 1] : (process.env.CLOISTER_OUTPUT || DEFAULT_OUTPUT);

  const tomlPath = process.env.CLUSTER_TOML ?? DEFAULT_TOML;

  let cluster;
  try {
    cluster = await parseTomlToCluster(readFileSync(tomlPath, "utf8"));
  } catch (e) {
    console.error(`emit-cloister-capnp: ${e.message}`);
    process.exit(1);
  }

  let out;
  try {
    out = emitCloisterCapnp(cluster);
  } catch (e) {
    console.error(`emit-cloister-capnp: ${e.message}`);
    process.exit(2);
  }

  if (writePath) {
    mkdirSync(dirname(writePath), { recursive: true });
    writeFileSync(writePath, out);
    const rel = writePath.startsWith(REPO_ROOT + "/") ? writePath.slice(REPO_ROOT.length + 1) : writePath;
    console.error(`emit-cloister-capnp: wrote ${rel}`);
  } else {
    process.stdout.write(out);
  }
}
