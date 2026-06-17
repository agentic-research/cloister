#!/usr/bin/env node
/**
 * scripts/emit-cloister-capnp.mjs — generate cloister.capnp from
 * cluster.toml (routes).
 *
 * Phase 2 (Commit 3) of "cloister.capnp as build artifact" arc
 * (cloister-345ad1 / ADR-0031 draft pending in Commit 5).
 *
 * Pipeline:
 *
 *   cluster.toml → routes (cluster-toml-only; no lockfile overlay here)
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
 *   So this emitter writes ONLY the cluster.toml-declared routes
 *   into cloister.capnp. The lockfile injection still happens
 *   downstream at `task manifest` time, exactly as in Phase 1.
 *
 * Output is byte-stable: two consecutive runs on the same inputs
 * produce identical bytes. Makes the drift gate meaningful.
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
 *   CLOISTER_OUTPUT    path to write (default: stdout unless --write)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTomlToCluster } from "./toml-to-cluster.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_TOML = resolve(REPO_ROOT, "cluster.toml");
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
 * Emit a canonical cloister.capnp text from the parsed cluster.
 *
 * The lockfile overlay (`[[generated_backends]]`) is NOT applied here —
 * see `scripts/build-manifest.mjs:overlayLockfileBackends` for the
 * downstream injection at `task manifest` time. Keeping the layers
 * separate avoids "this row exists in both files" collisions when
 * cloister.capnp is regenerated.
 *
 * @param {object} cluster        validated Cluster object (from parseTomlToCluster)
 * @returns {string} cloister.capnp source text
 */
export function emitCloisterCapnp(cluster) {
  if (!cluster || typeof cluster !== "object") {
    throw new TypeError("emitCloisterCapnp: expected a Cluster object");
  }
  return renderCapnp({
    // gateway.metadata is the LOGICAL MANIFEST NAME (per ADR-0004:
    // "cloister-art", "cloister-mache", "cloister-constellation"), NOT
    // the cluster name. Cluster.metadata.name is the cluster identity
    // ("art-default", visible in container labels). Until Phase 3 lands
    // `[gateway]` in cluster.toml, the gateway metadata stays pinned
    // to the ART-default template — matching the existing hand-edited
    // cloister.capnp file at HEAD. Operators who want a different
    // gateway.metadata name today must edit emit-cloister-capnp.mjs
    // (and live with the deviation showing up in the drift gate).
    metadata: DEFAULT_GATEWAY.metadata,
    actor: DEFAULT_GATEWAY.actor,
    policy: DEFAULT_GATEWAY.policy,
    routes: (cluster.routes ?? []).map((r) => cloneRoute(r)),
  });
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
 * Future Phase 3+ will add supportedProtocolVersions +
 * vaultProxyServices to the operator surface; for now the emitter omits
 * them (matches the ART-default cloister.capnp at HEAD).
 */
function renderCapnp(g) {
  const lines = [];
  lines.push("# cloister.capnp — AUTO-GENERATED by scripts/emit-cloister-capnp.mjs");
  lines.push("# Phase 2 of \"cloister.capnp as build artifact\" arc (cloister-345ad1, ADR-0031).");
  lines.push("#");
  lines.push("# Source: cluster.toml [[routes]] — the operator-authored route list.");
  lines.push("# gateway.metadata + actor + policy stay pinned to ART-default values");
  lines.push("# until Phase 3 lands a `[gateway]` operator surface in cluster.toml.");
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
