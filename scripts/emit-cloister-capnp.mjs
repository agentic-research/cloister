#!/usr/bin/env node
/**
 * scripts/emit-cloister-capnp.mjs — generate cloister.capnp from
 * cluster.toml (routes) + cluster.lock.toml ([[generated_backends]]).
 *
 * Phase 2 (Commit 3) of "cloister.capnp as build artifact" arc
 * (cloister-345ad1 / ADR-0031 draft pending in Commit 5).
 *
 * Pipeline:
 *
 *   cluster.toml      → operator surface: metadata + routes
 *   cluster.lock.toml → [[generated_backends]] (Phase 1 output from
 *                       scripts/resolve-inputs.mjs)
 *                       │
 *                       ▼
 *   merge routes + inject generated backends into /mcp
 *                       │
 *                       ▼
 *   render canonical cloister.capnp (deterministic text)
 *
 * Output is byte-stable: two consecutive runs on the same inputs
 * produce identical bytes. This is what makes the optional drift gate
 * meaningful in `task verify`.
 *
 * What this emitter DOES NOT cover (Phase 2 scope):
 *
 *   - actor + policy + supportedProtocolVersions + vaultProxyServices.
 *     These Gateway-level fields aren't in cluster.toml today. The
 *     emitter carries them forward from a fixed default-template
 *     (matching the existing ART-default cloister.capnp). Phase 3+
 *     will add `[gateway]` to cluster.toml when an operator needs to
 *     override the defaults; until then the emitter pins them.
 *
 * Usage:
 *   node scripts/emit-cloister-capnp.mjs                   # stdout
 *   node scripts/emit-cloister-capnp.mjs --write FILE      # write to file
 *
 * Env vars:
 *   CLUSTER_TOML       path to cluster.toml      (default: ./cluster.toml)
 *   CLUSTER_LOCKFILE   path to cluster.lock.toml (default: ./cluster.lock.toml)
 *   CLOISTER_OUTPUT    path to write (default: stdout unless --write)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "@iarna/toml";

import { parseTomlToCluster } from "./toml-to-cluster.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_TOML = resolve(REPO_ROOT, "cluster.toml");
const DEFAULT_LOCKFILE = resolve(REPO_ROOT, "cluster.lock.toml");
const DEFAULT_OUTPUT = null; // stdout

// ── Carried-forward Gateway defaults ──────────────────────────────────────
//
// These fields aren't yet in cluster.toml. Phase 3+ will add a
// `[gateway]` section to let operators override; until then the emitter
// pins them to the ART-default values that already live in the existing
// hand-edited cloister.capnp file. This keeps Commit 3's output
// byte-compatible (modulo route + backend changes) with the current
// file when an operator runs the emitter for the first time.
//
// The strings here are EXACTLY the ones in cloister.capnp at HEAD —
// matching them is what makes Commit 4's "byte-identical or document
// deltas" work in practice.
const DEFAULT_GATEWAY = {
  metadata: { name: "cloister-art", version: "0.1.0" },
  actor: {
    fingerprint:     "sha256:placeholder-pinned-at-deploy-time",
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
 * Emit a canonical cloister.capnp text from the parsed cluster + lockfile.
 *
 * @param {object} cluster        validated Cluster object (from parseTomlToCluster)
 * @param {object} lockfile       parsed cluster.lock.toml document, or null
 * @returns {string} cloister.capnp source text
 */
export function emitCloisterCapnp(cluster, lockfile = null) {
  if (!cluster || typeof cluster !== "object") {
    throw new TypeError("emitCloisterCapnp: expected a Cluster object");
  }
  const routes = mergeRoutes(cluster.routes ?? [], extractGeneratedBackends(lockfile));
  return renderCapnp({
    metadata: cluster.metadata ?? DEFAULT_GATEWAY.metadata,
    actor: DEFAULT_GATEWAY.actor,
    policy: DEFAULT_GATEWAY.policy,
    routes,
  });
}

// ── Lockfile → mcp-route-backend overlay ─────────────────────────────────

/**
 * Return the `[[generated_backends]]` rows from a parsed lockfile, or
 * `[]` when the lockfile is null/empty or has no rows. Mirrors the
 * shape `scripts/build-manifest.mjs:overlayLockfileBackends` reads.
 */
function extractGeneratedBackends(lockfile) {
  if (!lockfile || typeof lockfile !== "object") return [];
  const rows = lockfile.generated_backends;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Merge cluster.toml routes with the generated_backends rows from the
 * lockfile. Generated rows land as additional/replacement entries in
 * the /mcp route's `backends` list — same precedence semantics as the
 * existing `scripts/build-manifest.mjs` overlay:
 *
 *   - Same-name collision: generated row WINS, replaces in-place.
 *   - No collision: generated row APPENDS to the backends list.
 *
 * When cluster.toml has no /mcp route AND the lockfile has generated
 * backends, we synthesize a minimal /mcp route (matches the Phase 1
 * behavior — if the operator declared no routes but resolved an MCP
 * input, the emitter materializes the /mcp surface for them).
 */
function mergeRoutes(declaredRoutes, generatedRows) {
  // Defensive deep-clone the route list so we don't mutate the caller's
  // Cluster object.
  const out = declaredRoutes.map((r) => cloneRoute(r));

  if (generatedRows.length === 0) {
    return out;
  }

  let mcpIdx = out.findIndex((r) => r.kind && "mcp" in r.kind);
  if (mcpIdx === -1) {
    // Synthesize a minimal /mcp route so the generated backends have
    // somewhere to land. Same shape `build-manifest.mjs` warns about
    // today when it finds a lockfile without an /mcp route.
    out.push({ path: "/mcp", kind: { mcp: { backends: [] } } });
    mcpIdx = out.length - 1;
  }

  const backends = out[mcpIdx].kind.mcp.backends ?? [];
  const byName = new Map(backends.map((b, i) => [b.name, i]));

  for (const row of generatedRows) {
    const backend = backendFromGeneratedRow(row);
    if (backend === null) continue;
    const existing = byName.get(backend.name);
    if (existing !== undefined) {
      backends[existing] = backend; // generated wins
    } else {
      backends.push(backend);
      byName.set(backend.name, backends.length - 1);
    }
  }
  out[mcpIdx].kind.mcp.backends = backends;
  return out;
}

function cloneRoute(r) {
  // Shallow clone is fine — payloads are read-only here, but mcp's
  // backends list gets mutated during merge so we deep-clone it.
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

/**
 * Convert one [[generated_backends]] row from cluster.lock.toml into a
 * Backend declaration. Mirrors `scripts/build-manifest.mjs:backendFromGeneratedRow`
 * shape (kept consistent so the same emitter logic works both at
 * cloister.capnp emit + at src/generated/manifest.ts build time).
 */
function backendFromGeneratedRow(row) {
  if (!row || typeof row !== "object" || typeof row.name !== "string" || row.name === "") {
    return null;
  }
  const handlesPrefix  = typeof row.handlesPrefix  === "string" ? row.handlesPrefix  : "";
  const urlBinding     = typeof row.urlBinding     === "string" ? row.urlBinding     : "";
  const serviceBinding = typeof row.serviceBinding === "string" ? row.serviceBinding : "";
  const dynamicTools   = row.dynamicTools !== false; // default true
  const claims         = Array.isArray(row.claims) ? row.claims.slice() : [];

  const mcpProxy = {
    urlBinding,
    tools: [],
    dynamicTools,
    // Always include these fields — schema requires them; canonical
    // emit always emits non-default values, never elides.
    stripPrefix: typeof row.stripPrefix === "string" ? row.stripPrefix : "",
    requiresSession: row.requiresSession === true,
    protocolMode: typeof row.protocolMode === "string" ? row.protocolMode : "",
    serviceBinding,
    claims,
  };

  return {
    name:          row.name,
    handlesPrefix,
    kind:          { mcpProxy },
  };
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
 * Future Phase 3+ will add supportedProtocolVersions +
 * vaultProxyServices to the operator surface; for now the emitter omits
 * them (matches the ART-default cloister.capnp at HEAD).
 */
function renderCapnp(g) {
  const lines = [];
  lines.push("# cloister.capnp — AUTO-GENERATED by scripts/emit-cloister-capnp.mjs");
  lines.push("# Phase 2 of \"cloister.capnp as build artifact\" arc (cloister-345ad1, ADR-0031).");
  lines.push("# Source: cluster.toml ([metadata], [[routes]]) + cluster.lock.toml ([[generated_backends]]).");
  lines.push("# Do NOT edit by hand — your edits will be overwritten on the next emitter run.");
  lines.push("#");
  lines.push("# To regenerate: `task emit:cloister-capnp` (or `node scripts/emit-cloister-capnp.mjs --write cloister.capnp`).");
  lines.push("");
  lines.push("@0xa1c0157e1a1f0001;");
  lines.push('using Cloister = import "/cloister/manifest/cloister.capnp";');
  lines.push("");
  lines.push("const gateway :Cloister.Gateway = (");
  lines.push(`  metadata = (name = ${q(g.metadata.name)}, version = ${q(g.metadata.version)}),`);
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
  lines.push("  routes = [");
  for (let i = 0; i < g.routes.length; i++) {
    renderRoute(lines, g.routes[i], i === g.routes.length - 1);
  }
  lines.push("  ],");
  lines.push(");");
  lines.push("");
  return lines.join("\n");
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
  const lockfilePath = process.env.CLUSTER_LOCKFILE ?? DEFAULT_LOCKFILE;

  let cluster;
  try {
    cluster = await parseTomlToCluster(readFileSync(tomlPath, "utf8"));
  } catch (e) {
    console.error(`emit-cloister-capnp: ${e.message}`);
    process.exit(1);
  }

  let lockfile = null;
  if (existsSync(lockfilePath)) {
    try {
      lockfile = parseToml(readFileSync(lockfilePath, "utf8"));
    } catch (e) {
      console.error(`emit-cloister-capnp: failed to parse ${lockfilePath}: ${e.message}`);
      process.exit(1);
    }
  }

  let out;
  try {
    out = emitCloisterCapnp(cluster, lockfile);
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
