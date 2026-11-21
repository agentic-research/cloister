#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/layers.mjs — which layer each source file belongs to (ADR-0081), which
// way its imports point, and how big core is.
//
// ADR-0081 separates cloister into core (what every deployment guarantees),
// drivers (one per placement, each isolating bundles its own way) and
// features (built on both), joined only by composition roots. LAYERS assigns
// every tracked code file to one, by path prefix; the longest prefix that
// matches wins. Until a file moves for a reason of its own, the map, not the
// directory, is the boundary.
//
// The rail refuses:
//   - a tracked code file the map does not classify, and a map entry that
//     names no tracked file (§3);
//   - an import that points outward, unless OUTWARD lists it, and an OUTWARD
//     entry that no longer exists, so that list only shrinks (§3);
//   - core larger than the `core-budget` in ADR-0081's frontmatter (§4).
//
// Imports are read by a parser where there is one: TypeScript's own
// pre-processor for .ts, .mjs and .js. Rust has none here, so `mod`
// declarations and `crate::` and workspace-crate paths are read after
// comments and strings are removed. `super::` is not followed, since it names
// the enclosing module, which may be an inline one the text does not show.
// Cap'n Proto has none either: its `import "…"` statements are read after its
// comments are removed (lint:structured-parse exempts .capnp for the same
// reason). An import of data (JSON, wasm) is not code and has no direction.
//
// `task lint:layers` prints the inventory.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Path prefix → layer. A prefix ending in `/` names a directory; any other is
 * one file. Layers:
 *   core/<area>        what every deployment guarantees (ADR-0081 §2)
 *   driver/<placement> one placement's isolation and its need contract
 *   feature/<name>     built on core and drivers
 *   root               a composition root: the only place layers are joined
 *   tooling, config, example, vendored   not cloister's runtime code
 * A generated file has the layer of the schema it is generated from; it counts
 * for direction, not for size.
 */
export const LAYERS = Object.freeze({
  // ── core: the declaration ──────────────────────────────────────────────
  "manifest/cluster.capnp": "core/declaration",
  "src/manifest/cluster-types.ts": "core/declaration",
  "src/manifest/bundle-drift-guard.ts": "core/declaration",
  "cli/lib/cluster/toml-to-cluster.mjs": "core/declaration",
  "cli/lib/cluster/cluster-schema.mjs": "core/declaration",
  "cli/lib/cluster/toml-schema.mjs": "core/declaration",
  "cli/lib/cluster/cluster-to-toml.mjs": "core/declaration",
  "cli/lib/cluster/capability-matchmaker.mjs": "core/declaration",
  "cli/lib/cluster/connections.mjs": "core/declaration",
  "cli/lib/cluster/confinement.mjs": "core/declaration",
  "cli/lib/cluster/workspace.mjs": "core/declaration",
  "cli/lib/cluster/lockfile.mjs": "core/declaration",
  // Pinning is core; its fetchers (GitHub, HTTPS, registries) are
  // feature-shaped, and the first split ADR-0081 names.
  "cli/lib/cluster/resolve-inputs.mjs": "core/declaration",
  "cli/lib/app-protocol.mjs": "core/declaration",
  "cli/lib/oci-artifact.mjs": "core/declaration",

  // ── core: authority (identity, leases, grants) ────────────────────────
  "manifest/identity.capnp": "core/authority",
  "src/trust-store.ts": "core/authority",
  "src/routes/lease-middleware.ts": "core/authority",
  "src/routes/lease-gate.ts": "core/authority",
  "src/routes/actor-fingerprint.ts": "core/authority",
  "src/routes/pre-auth-budget.ts": "core/authority",
  "src/routes/bundle-auth.ts": "core/authority",
  "src/routes/bundle-token-verify.ts": "core/authority",
  "src/storage/actor-ca-bundle.ts": "core/authority",
  "src/storage/ca-bundle-cache.ts": "core/authority",
  "src/storage/ca-bundle-source.ts": "core/authority",
  "src/storage/notme-bundle-fetcher.ts": "core/authority",
  "src/storage/peer-lease-counters.ts": "core/authority",
  "src/storage/seen-nonces.ts": "core/authority",
  "src/wire/signet-verify.ts": "core/authority",
  "src/wire/interlace-capability.ts": "core/authority",
  "src/wire/compromise-notice.ts": "core/authority",
  "src/wire/run-id.ts": "core/authority",
  "src/storage/bundle-canonical.ts": "core/authority",

  // ── core: credentials ──────────────────────────────────────────────────
  "vault/src/": "core/credentials",
  "src/vault-store.ts": "core/credentials",
  "src/routes/vault-proxy.ts": "core/credentials",
  "src/routes/vault-proxy-credential-store.ts": "core/credentials",
  "src/manifest/vault-proxy-services.ts": "core/credentials",

  // ── core: audit ────────────────────────────────────────────────────────
  "src/routes/receipt-emitter.ts": "core/audit",
  "src/routes/receipt-guard.ts": "core/audit",
  "src/routes/receipt-stream.ts": "core/audit",
  "src/storage/peer-attestations.ts": "core/audit",
  "src/storage/peer-receipts.ts": "core/audit",
  "src/storage/pending-attestations.ts": "core/audit",
  "src/wire/receipts.ts": "core/audit",
  "src/wire/receipts-cbor.ts": "core/audit",
  "src/wire/receipt-verify.ts": "core/audit",
  "src/wire/receipt-delegated-signer.ts": "core/audit",
  "src/wire/origin.ts": "core/audit",

  // ── core: confinement policy, content addressing ───────────────────────
  "src/wire/confinement-digest.ts": "core/confinement",
  "rs/crates/host-runtime/src/mediator/": "core/confinement",
  "src/wire/cas-hash.ts": "core/content-addressing",
  "src/wire/partition.ts": "core/content-addressing",
  "src/storage/canonical.ts": "core/content-addressing",
  "src/storage/typed-cid.ts": "core/content-addressing",
  "rs/crates/cas/": "core/content-addressing",
  "src/storage/types.ts": "core/content-addressing",

  // ── core: support ──────────────────────────────────────────────────────
  // What core needs and that carries no policy of its own: the structured
  // log the trust surface writes (lint:log-shape), atomic file writes,
  // canonical paths, telling a script from an import, and the environment
  // core reads, which every placement provides.
  "src/core-env.ts": "core/support",
  "src/obs/": "core/support",
  "cli/lib/canonical-path.mjs": "core/support",
  "cli/lib/atomic-write.mjs": "core/support",
  "cli/lib/started-as-script.mjs": "core/support",

  // ── drivers: one per placement ─────────────────────────────────────────
  // workerd: V8 isolates and service bindings (ADR-0013). The gateway's own
  // bundles, and the whole of the Cloudflare deployment.
  "config.capnp": "driver/workerd",
  // src/types.ts is the worker's Env, the bindings each isolate is given. It
  // also holds the JSON-RPC, MCP and bead types the features use: a file to
  // split, which ADR-0081's import rail lists.
  "src/types.ts": "driver/workerd",
  "src/storage/workerd.ts": "driver/workerd",
  // The vault's CredentialStore, implemented over its Durable Object: core's
  // port (vault-proxy-credential-store.ts), as this driver provides it.
  "src/routes/vault-do-credential-store.ts": "driver/workerd",
  "cli/lib/cluster/emit-compose.mjs": "driver/compose",
  "cli/lib/cluster/compose-placement.mjs": "driver/compose",
  "cli/lib/cluster/http-networks.mjs": "driver/compose",
  "cli/lib/cluster/socket-dirs.mjs": "driver/compose",
  "cli/lib/cluster/up.mjs": "driver/microvm",
  "cli/lib/cluster/edge-relay.mjs": "driver/microvm",
  "cli/lib/runtime/": "driver/microvm",
  "cli/lib/install-layout.mjs": "driver/microvm",
  // The grant builder for ley-line-open's execution daemon (ADR-0079): its
  // grants carry the libkrun confinement document, so it is this driver's.
  // The authority model it follows is core's.
  "rs/crates/host-runtime/src/issue.rs": "driver/microvm",
  "cli/commands/runtime-plan.mjs": "driver/microvm",
  "cli/commands/runtime-import.mjs": "driver/microvm",
  "rs/crates/host-runtime/": "driver/microvm",
  "cli/lib/cluster/emit-k8s.mjs": "driver/kubernetes",
  "cli/lib/cluster/emit-workload.mjs": "driver/kubernetes",
  "cli/lib/cluster/manifest-addresses.mjs": "driver/kubernetes",

  // ── features ───────────────────────────────────────────────────────────
  "src/routes/mcp.ts": "feature/mcp-gateway",
  // The gateway's manifest (routes and backends), its backend kinds, and the
  // wires those backends speak, all serve MCP tool calls.
  "manifest/cloister.capnp": "feature/mcp-gateway",
  "src/manifest/types.ts": "feature/mcp-gateway",
  "cli/lib/cluster/emit-cloister-capnp.mjs": "feature/mcp-gateway",
  "src/backends.ts": "feature/mcp-gateway",
  "src/manifest/backends/": "feature/mcp-gateway",
  "src/wire/codec.ts": "feature/mcp-gateway",
  "src/wire/manifest.ts": "feature/mcp-gateway",
  "wire/": "feature/mcp-gateway",
  "src/routes/vault-proxy-route.ts": "feature/mcp-gateway",
  "src/routes/ca-bundle.ts": "feature/mcp-gateway",
  "src/routes/roots-state.ts": "feature/mcp-gateway",
  "src/routes/health.ts": "feature/mcp-gateway",
  "src/routes/tenant-dispatch.ts": "feature/mcp-gateway",
  "src/routes/well-known.ts": "feature/mcp-gateway",
  "src/routes/well-known-identity.ts": "feature/mcp-gateway",
  "src/routes/notme-identity.ts": "feature/mcp-gateway",
  "src/wire/tool-call.ts": "feature/mcp-gateway",
  "src/wire/tool-result.ts": "feature/mcp-gateway",
  "src/tool-schemas/": "feature/mcp-gateway",
  "src/manifest/spec.ts": "feature/mcp-gateway",
  "src/cors.ts": "feature/mcp-gateway",
  "src/router.ts": "feature/mcp-gateway",
  "src/memoize/": "feature/mcp-gateway",
  "src/beads.ts": "feature/beads",
  "src/blob-store.ts": "feature/beads",
  "src/routes/bead-create-orchestrator.ts": "feature/beads",
  "src/storage/bead-canonical.ts": "feature/beads",
  "src/routes/oci-registry.ts": "feature/registries",
  "src/routes/well-known-mcp-registry.ts": "feature/registries",
  "src/storage/registry-membership.ts": "feature/registries",
  "src/storage/registry-tags.ts": "feature/registries",
  "src/routes/disclosure.ts": "feature/disclosure",
  "src/storage/disclosure-cursor.ts": "feature/disclosure",
  "src/harness-shim/": "feature/harness",
  "cli/lib/harness/": "feature/harness",
  "cli/commands/run.mjs": "feature/harness",
  "tools/harness-sandbox/": "feature/harness",
  "cli/lib/facts/": "feature/plan-checker",
  "cli/commands/inspect.mjs": "feature/plan-checker",
  "cli/commands/skills.mjs": "feature/skills",
  "manifest/cli.capnp": "feature/cli",
  "cli/surface.mjs": "feature/cli",
  "cli/help.mjs": "feature/cli",
  "cli/commands/cluster.mjs": "feature/cli",
  "cli/commands/runtime.mjs": "feature/cli",
  "cli/lib/cluster/generate.mjs": "feature/cli",
  "cli/commands/add.mjs": "feature/cli",
  "cli/commands/artifacts-pull.mjs": "feature/cli",
  "cli/commands/init.mjs": "feature/cli",
  "cli/commands/install.mjs": "feature/cli",
  "cli/commands/dev.mjs": "feature/cli",
  "cli/lib/dev/": "feature/cli",
  "cli/lib/cluster/graph.mjs": "feature/cli",
  "cli/lib/flags.mjs": "feature/cli",
  "cli/lib/global-options.mjs": "feature/cli",
  "cli/lib/output.mjs": "feature/cli",
  "cli/lib/output-format.mjs": "feature/cli",
  "cli/lib/operator-consent.mjs": "feature/cli",

  // ── composition roots ──────────────────────────────────────────────────
  "src/index.ts": "root",
  // Instantiates the gateway's routes and backends from its manifest.
  "src/manifest/runtime.ts": "root",
  "cli/index.mjs": "root",
  "bin/cloister.mjs": "root",

  // ── not cloister's runtime code ────────────────────────────────────────
  "lint/": "tooling",
  "gen/": "tooling",
  "dev/": "tooling",
  "tools/edge-probe/": "tooling",
  "vitest.config.ts": "tooling",
  "vitest.bench.config.ts": "tooling",
  "cluster.capnp": "config",
  "cloister.capnp": "config",
  "recipes/": "example",
  "tools/dolt-grpc-demo/": "example",
  "manifest/_traits.capnp": "vendored",

  // ── generated: each has its source's layer ─────────────────────────────
  "src/generated/cluster.zod.ts": "core/declaration",
  "src/generated/identity.zod.ts": "core/authority",
  "src/generated/cloister.zod.ts": "feature/mcp-gateway",
  "src/generated/tool-schemas.ts": "feature/mcp-gateway",
  "src/generated/cli.zod.ts": "feature/cli",
  // This repository's own cluster and gateway, compiled from cluster.toml
  // and cloister.capnp.
  "src/generated/cluster.ts": "config",
  "src/generated/manifest.ts": "config",
});

/** The kinds a layer name may take. */
export const LAYER_SHAPE = /^(core\/[a-z-]+|driver\/[a-z-]+|feature\/[a-z-]+|root|tooling|config|example|vendored)$/;

/** Core's areas (ADR-0081 §1). A new one is an amendment there, not an entry here. */
export const CORE_AREAS = Object.freeze([
  "declaration",
  "authority",
  "credentials",
  "audit",
  "confinement",
  "content-addressing",
  "support",
]);

/** The layer groups that are cloister's runtime code, and so ADR-0081's subject. */
export const RUNTIME = Object.freeze(["core", "driver", "feature", "root"]);

/**
 * Platform modules that are one driver's own API, by specifier prefix
 * (ADR-0081 §3): importing one is importing that driver. `node:` is not here,
 * because Node runs the CLI and is no placement.
 */
export const PLATFORM = Object.freeze({
  "cloudflare:": "driver/workerd",
});

/** The layer of a platform module specifier, or null when it names none. */
export function platformLayer(spec) {
  const prefix = Object.keys(PLATFORM).find((p) => spec.startsWith(p));
  return prefix === undefined ? null : PLATFORM[prefix];
}

/**
 * The imports that point outward today (ADR-0081 §3), each `importer -> target`.
 * Any other outward import is refused, and so is an entry here that no longer
 * exists: this list only shrinks. Each is work ADR-0081 names.
 */
export const OUTWARD = Object.freeze([
  // Core hosted as the workerd driver's Durable Objects: the trust store and
  // the vault are DO classes, and the lease middleware reaches the trust store
  // through its namespace in Env (src/types.ts), which also holds the JSON-RPC
  // answer the middleware returns.
  "src/routes/lease-middleware.ts -> src/types.ts",
  "src/trust-store.ts -> src/types.ts",
  "src/trust-store.ts -> cloudflare:workers",
  "src/vault-store.ts -> src/types.ts",
  "src/vault-store.ts -> cloudflare:workers",
  // The OCI registry feature's state, kept in core's trust store.
  "src/trust-store.ts -> src/storage/registry-membership.ts",
  "src/trust-store.ts -> src/storage/registry-tags.ts",
  // Core reading the MCP gateway's manifest types.
  "src/manifest/vault-proxy-services.ts -> src/manifest/types.ts",
  "src/routes/actor-fingerprint.ts -> src/manifest/types.ts",
  // Core's lock writer carrying the microVM driver's rootfs rows.
  "cli/lib/cluster/lockfile.mjs -> cli/lib/runtime/rootfs-lock.mjs",
]);

/** ADR-0081, whose frontmatter states core's budget in lines. */
export const BUDGET_ADR = "docs/adr/0081-cloister-is-a-core-drivers-and-features.md";

const CODE = /\.(ts|mjs|js|rs|capnp)$/;
const EXCLUDED = /(^|\/)(test|tests)\/|\.test\.|\/vendor\/|\.d\.ts$/;

/** Every tracked file, for resolving imports. */
function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

/** Every tracked code file the map must classify: tests and vendored code are not. */
export function codeFiles(root = ROOT) {
  return trackedFiles(root).filter((f) => CODE.test(f) && !EXCLUDED.test(f));
}

/** A generated file is classified, and counted by the source it is generated from. */
export const isGenerated = (path) => /(^|\/)generated\//.test(path);

/** The map entry that classifies `path`: the longest prefix that matches, or null. */
export function entryFor(path, layers = LAYERS) {
  let best = null;
  for (const prefix of Object.keys(layers)) {
    const matches = prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
    if (matches && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best;
}

/** `path`'s layer, or null when the map does not classify it. */
export function layerOf(path, layers = LAYERS) {
  const entry = entryFor(path, layers);
  return entry === null ? null : layers[entry];
}

/** The group a layer counts toward: `core/audit` → `core`. */
export const groupOf = (layer) => layer.split("/")[0];

/**
 * Every tracked code file, by layer, with its size in lines (generated files
 * are not counted); what the map does not classify; and every map entry that
 * names no tracked file.
 */
export function inventory(root = ROOT, layers = LAYERS) {
  const files = codeFiles(root);
  const byLayer = new Map();
  const unclassified = [];
  const used = new Set();
  for (const file of files) {
    const entry = entryFor(file, layers);
    if (entry === null) { unclassified.push(file); continue; }
    used.add(entry);
    if (isGenerated(file)) continue;
    const layer = layers[entry];
    const lines = readFileSync(resolve(root, file), "utf8").split("\n").length - 1;
    const row = byLayer.get(layer) ?? { lines: 0, files: 0, homes: new Map() };
    row.lines += lines;
    row.files += 1;
    const home = file.includes("/") ? `${file.split("/")[0]}/` : file;
    row.homes.set(home, (row.homes.get(home) ?? 0) + lines);
    byLayer.set(layer, row);
  }
  const unused = Object.keys(layers).filter((entry) => !used.has(entry));
  return { byLayer, unclassified, unused };
}

/** Lines of runtime code in `group` (`core`, `driver`, `feature`, `root`). */
export function groupLines(byLayer, group) {
  let total = 0;
  for (const [layer, row] of byLayer) if (groupOf(layer) === group) total += row.lines;
  return total;
}

/** Where `group`'s lines live today, by top-level directory. */
export function homesOf(byLayer, group) {
  const homes = new Map();
  for (const [layer, row] of byLayer) {
    if (groupOf(layer) !== group) continue;
    for (const [home, lines] of row.homes) homes.set(home, (homes.get(home) ?? 0) + lines);
  }
  return homes;
}

// ── imports ───────────────────────────────────────────────────────────────

/**
 * Whether a file in layer `from` may import one in layer `to` (ADR-0081 §3).
 * Core imports core; a driver imports core and itself; a feature imports
 * anything but a root; a root imports anything. Vendored code is anyone's.
 * Tooling, config and examples are not runtime code, so runtime code imports
 * none of them.
 */
export function allowedImport(from, to) {
  // Roots join the layers; tooling, config, examples and vendored code are not runtime code.
  if (groupOf(from) === "root" || !RUNTIME.includes(groupOf(from))) return true;
  if (to === "vendored") return true;
  if (!RUNTIME.includes(groupOf(to))) return false;
  switch (groupOf(from)) {
    case "core": return groupOf(to) === "core";
    case "driver": return groupOf(to) === "core" || to === from;
    case "feature": return groupOf(to) !== "root";
    default: return true;
  }
}

/** A relative script specifier, resolved to a tracked file the way Node and TypeScript do here. */
function resolveScript(importer, spec, tracked) {
  // A package is no layer's; a driver's platform module stands for that driver.
  if (!spec.startsWith(".")) return platformLayer(spec) === null ? null : spec;
  const base = posix.normalize(posix.join(posix.dirname(importer), spec));
  const extension = /\.[A-Za-z0-9]+$/.test(base);
  const candidates = [base];
  if (base.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"));
  if (!extension) candidates.push(`${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.mjs`);
  const hit = candidates.find((c) => tracked.has(c));
  if (hit !== undefined) return hit;
  // Data (JSON) and build artifacts (wasm) are not code; a missing script is.
  return CODE.test(base) || !extension ? { unresolved: base } : null;
}

/** A Cap'n Proto import, resolved: `/cloister/…` is this repository; other absolute paths are include paths outside it. */
function resolveCapnp(importer, spec, tracked) {
  let path;
  if (spec.startsWith("/cloister/")) path = spec.slice("/cloister/".length);
  else if (spec.startsWith("/")) return null;
  else path = posix.normalize(posix.join(posix.dirname(importer), spec));
  return tracked.has(path) ? path : { unresolved: path };
}

/** Rust text with comments, string and char literals blanked, so a path in them is not read as code. */
function rustCode(text) {
  return text.replace(/r(#*)"[\s\S]*?"\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
}

/** The workspace's Rust crates: each tracked Cargo.toml with a [package], by directory. */
function rustCrates(root, tracked) {
  const crates = [];
  for (const file of tracked) {
    if (!file.endsWith("Cargo.toml")) continue;
    const manifest = parseToml(readFileSync(resolve(root, file), "utf8"));
    if (!manifest.package?.name) continue;
    const dir = posix.dirname(file);
    const src = `${dir}/src`;
    const libRoot = tracked.has(`${src}/lib.rs`) ? `${src}/lib.rs` : null;
    crates.push({ dir, src, libRoot, lib: manifest.lib?.name ?? manifest.package.name.replace(/-/g, "_") });
  }
  return crates;
}

/** The file of module `name` in crate source dir `src`, or the crate root when it is no module. */
function rustModule(crate, name, fallback, tracked) {
  for (const candidate of [`${crate.src}/${name}.rs`, `${crate.src}/${name}/mod.rs`]) {
    if (tracked.has(candidate)) return candidate;
  }
  return fallback;
}

function rustImports(file, text, tracked, crates) {
  const own = crates.filter((c) => file.startsWith(`${c.src}/`)).sort((a, b) => b.src.length - a.src.length)[0];
  if (!own) return [];
  const code = rustCode(text);
  const targets = [];
  // `mod name;` declares a module file beside this one (lib.rs, main.rs,
  // mod.rs) or beneath it (any other file).
  const here = posix.dirname(file);
  const base = posix.basename(file);
  const beneath = ["lib.rs", "main.rs", "mod.rs"].includes(base) ? here : `${here}/${base.replace(/\.rs$/, "")}`;
  for (const m of code.matchAll(/\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) {
    const hit = [`${beneath}/${m[1]}.rs`, `${beneath}/${m[1]}/mod.rs`].find((c) => tracked.has(c));
    targets.push(hit ?? { unresolved: `${beneath}/${m[1]}.rs` });
  }
  // `crate::name` and `<workspace crate>::name`: the module the first segment
  // names, or the crate's root. Layers are given per file or directory, so a
  // deeper segment names a module in the same layer.
  const ownRoot = own.libRoot ?? file;
  for (const m of code.matchAll(/\b(crate|[a-z_][a-z0-9_]*)::(\{|[A-Za-z_][A-Za-z0-9_]*)/g)) {
    const crate = m[1] === "crate" ? own : crates.find((c) => c.lib === m[1]);
    if (!crate) continue; // std, a dependency, or a path within this module
    const fallback = m[1] === "crate" ? ownRoot : (crate.libRoot ?? ownRoot);
    targets.push(m[2] === "{" ? fallback : rustModule(crate, m[2], fallback, tracked));
  }
  return targets;
}

/** The tracked files and driver platform modules `file` imports, or `{unresolved}` for an import that names none. */
export function importsOf(root, file, tracked, crates) {
  const text = readFileSync(resolve(root, file), "utf8");
  if (file.endsWith(".rs")) return rustImports(file, text, tracked, crates);
  if (file.endsWith(".capnp")) {
    const code = text.replace(/#[^\n]*/g, "");
    return [...code.matchAll(/\bimport\s+"([^"]+)"/g)].map((m) => resolveCapnp(file, m[1], tracked)).filter((t) => t !== null);
  }
  return ts.preProcessFile(text, true, true).importedFiles
    .map((i) => resolveScript(file, i.fileName, tracked))
    .filter((t) => t !== null);
}

/**
 * Every import from runtime code that points outward, against `outward`:
 * those it does not list, those it lists that no longer exist, and imports
 * that name no tracked file.
 */
export function directionProblems(root = ROOT, layers = LAYERS, outward = OUTWARD) {
  const tracked = new Set(trackedFiles(root));
  const crates = rustCrates(root, tracked);
  const found = new Map();
  const unresolved = [];
  for (const file of codeFiles(root)) {
    const from = layerOf(file, layers);
    if (from === null || !RUNTIME.includes(groupOf(from))) continue;
    for (const target of importsOf(root, file, tracked, crates)) {
      if (typeof target === "object") { unresolved.push(`${file} imports ${target.unresolved}, which is no tracked file`); continue; }
      if (target === file) continue;
      const to = layerOf(target, layers) ?? platformLayer(target);
      // A target with no layer is a test or a declaration file; an unclassified code file is refused by the inventory.
      if (to === null || allowedImport(from, to)) continue;
      found.set(`${file} -> ${target}`, { from, to });
    }
  }
  const listed = new Set(outward);
  const unlisted = [...found].filter(([edge]) => !listed.has(edge)).map(([edge, { from, to }]) => `${edge} (${from} -> ${to})`);
  const stale = outward.filter((edge) => !found.has(edge));
  return { found, unlisted, stale, unresolved };
}

// ── budget ────────────────────────────────────────────────────────────────

/** Core's budget in lines: `core-budget` in ADR-0081's frontmatter. */
export function coreBudget(root = ROOT) {
  const text = readFileSync(resolve(root, BUDGET_ADR), "utf8");
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  const budget = block === undefined ? undefined : parseYaml(block)?.["core-budget"];
  if (!Number.isInteger(budget)) throw new Error(`${BUDGET_ADR} states no integer core-budget in its frontmatter`);
  return budget;
}

/** The refusal for core at `lines` against `budget`, or null when it fits. */
export function budgetProblem(lines, budget) {
  if (lines <= budget) return null;
  return `core is ${lines} lines, over ADR-0081's budget of ${budget}. Shrink it, or raise core-budget in ` +
    `${BUDGET_ADR} and say why in the change (ADR-0081 §4)`;
}

function main() {
  const { byLayer, unclassified, unused } = inventory();
  const problems = [
    ...unclassified.map((f) => `${f}: no layer; add it to LAYERS in lint/layers.mjs (ADR-0081)`),
    ...unused.map((e) => `LAYERS names ${JSON.stringify(e)}, which matches no tracked code file; remove or correct it`),
  ];
  for (const [entry, layer] of Object.entries(LAYERS)) {
    if (!LAYER_SHAPE.test(layer)) problems.push(`LAYERS gives ${JSON.stringify(entry)} the layer ${JSON.stringify(layer)}, which ADR-0081 does not define`);
    if (groupOf(layer) === "core" && !CORE_AREAS.includes(layer.slice("core/".length))) {
      problems.push(`LAYERS gives ${JSON.stringify(entry)} the core area ${JSON.stringify(layer)}, which is not one of ADR-0081's`);
    }
  }
  const direction = directionProblems();
  problems.push(
    ...direction.unlisted.map((e) => `${e}: an import that points outward (ADR-0081 §3); invert it, or move the code to the layer it belongs in`),
    ...direction.stale.map((e) => `OUTWARD lists ${JSON.stringify(e)}, which no longer exists; remove it (the list only shrinks)`),
    ...direction.unresolved,
  );
  const core = groupLines(byLayer, "core");
  let budget = null;
  try {
    budget = coreBudget();
  } catch (error) {
    problems.push(error.message);
  }
  const overBudget = budget === null ? null : budgetProblem(core, budget);
  if (overBudget) problems.push(overBudget);
  if (problems.length) {
    for (const p of problems) console.error(`lint-layers: ${p}`);
    process.exit(1);
  }
  const runtime = RUNTIME.reduce((sum, g) => sum + groupLines(byLayer, g), 0);
  console.log(`lint-layers: OK — every code file has a layer, ${direction.found.size} outward import(s) remain and each is listed, core is ${core} of its ${budget}-line budget (ADR-0081)`);
  for (const [layer, row] of [...byLayer].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${String(row.lines).padStart(6)} lines ${String(row.files).padStart(3)} files  ${layer}`);
  }
  for (const group of RUNTIME) {
    const lines = groupLines(byLayer, group);
    console.log(`  ${group.padEnd(8)} ${String(lines).padStart(6)} lines  ${Math.round((100 * lines) / runtime)}% of runtime code`);
  }
  const homes = [...homesOf(byLayer, "core")].sort(([, a], [, b]) => b - a).map(([h, n]) => `${h} ${n}`).join(", ");
  console.log(`  core lives in: ${homes}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
