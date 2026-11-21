#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/layers.mjs — which layer each source file belongs to (ADR-0081), and
// how big each layer is.
//
// ADR-0081 separates cloister into core (what every deployment guarantees),
// drivers (one per placement, each isolating bundles its own way) and
// features (built on both), joined only by composition roots. This map
// assigns every tracked source file to one, by path prefix; the longest
// prefix that matches wins. Nothing has moved yet: until a file moves for a
// reason of its own, the map, not the directory, is the boundary.
//
// The rail, today: a tracked source file the map does not classify is
// refused, and so is a map entry that names no tracked file. A new module
// names its layer when it is added, and the inventory is never quietly
// wrong. ADR-0081 §3 (imports point inward) and §4 (core's size budget)
// read this same map, and land next.
//
// `task lint:layers` prints the inventory.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Path prefix → layer. A prefix ending in `/` names a directory; any other is
 * one file. Layers:
 *   core/<area>        what every deployment guarantees (ADR-0081 §2)
 *   driver/<placement> one placement's isolation and its need contract
 *   feature/<name>     built on core and drivers
 *   root               a composition root: the only place layers are joined
 *   tooling, config, example, vendored   not cloister's runtime code
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
  "cli/lib/canonical-path.mjs": "core/declaration",
  "cli/lib/atomic-write.mjs": "core/declaration",

  // ── core: authority (identity, leases, grants) ────────────────────────
  "manifest/identity.capnp": "core/authority",
  "src/trust-store.ts": "core/authority",
  "src/routes/lease-middleware.ts": "core/authority",
  "src/routes/lease-gate.ts": "core/authority",
  "src/routes/ca-bundle.ts": "core/authority",
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
  "rs/crates/host-runtime/src/issue.rs": "core/authority",

  // ── core: credentials ──────────────────────────────────────────────────
  "vault/src/": "core/credentials",
  "src/vault-store.ts": "core/credentials",
  "src/routes/vault-proxy.ts": "core/credentials",
  "src/routes/vault-proxy-route.ts": "core/credentials",
  "src/routes/vault-proxy-credential-store.ts": "core/credentials",
  "src/routes/vault-do-credential-store.ts": "core/credentials",
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

  // ── drivers: one per placement ─────────────────────────────────────────
  // workerd: V8 isolates and service bindings (ADR-0013). The gateway's own
  // bundles, and the whole of the Cloudflare deployment.
  "manifest/cloister.capnp": "driver/workerd",
  "wire/": "driver/workerd",
  "config.capnp": "driver/workerd",
  "src/manifest/types.ts": "driver/workerd",
  "src/manifest/runtime.ts": "driver/workerd",
  "src/manifest/backends/": "driver/workerd",
  "src/backends.ts": "driver/workerd",
  "src/wire/codec.ts": "driver/workerd",
  "src/wire/manifest.ts": "driver/workerd",
  "src/storage/workerd.ts": "driver/workerd",
  "src/storage/types.ts": "driver/workerd",
  "cli/lib/cluster/emit-cloister-capnp.mjs": "driver/workerd",
  "cli/lib/cluster/emit-compose.mjs": "driver/compose",
  "cli/lib/cluster/compose-placement.mjs": "driver/compose",
  "cli/lib/cluster/http-networks.mjs": "driver/compose",
  "cli/lib/cluster/socket-dirs.mjs": "driver/compose",
  "cli/lib/cluster/up.mjs": "driver/microvm",
  "cli/lib/cluster/edge-relay.mjs": "driver/microvm",
  "cli/lib/runtime/": "driver/microvm",
  "cli/commands/runtime-plan.mjs": "driver/microvm",
  "cli/commands/runtime-import.mjs": "driver/microvm",
  "cli/commands/runtime.mjs": "driver/microvm",
  "rs/crates/host-runtime/": "driver/microvm",
  "cli/lib/cluster/emit-k8s.mjs": "driver/kubernetes",
  "cli/lib/cluster/emit-workload.mjs": "driver/kubernetes",
  "cli/lib/cluster/manifest-addresses.mjs": "driver/kubernetes",

  // ── features ───────────────────────────────────────────────────────────
  "src/routes/mcp.ts": "feature/mcp-gateway",
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
  "src/types.ts": "feature/mcp-gateway",
  "src/obs/": "feature/mcp-gateway",
  "src/memoize/": "feature/mcp-gateway",
  "src/beads.ts": "feature/beads",
  "src/blob-store.ts": "feature/beads",
  "src/routes/bead-create-orchestrator.ts": "feature/beads",
  "src/storage/bead-canonical.ts": "feature/beads",
  "src/routes/oci-registry.ts": "feature/registries",
  "src/routes/well-known-mcp-registry.ts": "feature/registries",
  "src/storage/registry-membership.ts": "feature/registries",
  "src/storage/registry-tags.ts": "feature/registries",
  "src/storage/bundle-canonical.ts": "feature/registries",
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
  "cli/lib/started-as-script.mjs": "feature/cli",
  "cli/lib/install-layout.mjs": "feature/cli",

  // ── composition roots ──────────────────────────────────────────────────
  "src/index.ts": "root",
  "cli/index.mjs": "root",
  "bin/cloister.mjs": "root",
  "cli/lib/cluster/generate.mjs": "root",

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
});

/** The kinds a layer name may take. */
export const LAYER_SHAPE = /^(core\/[a-z-]+|driver\/[a-z-]+|feature\/[a-z-]+|root|tooling|config|example|vendored)$/;

/** The layers that are cloister's runtime code, and so ADR-0081's subject. */
export const RUNTIME = ["core", "driver", "feature", "root"];

const SOURCE = /\.(ts|mjs|js|rs|capnp)$/;
const EXCLUDED = /(^|\/)(test|tests)\/|\.test\.|\/generated\/|\/vendor\/|\.d\.ts$/;

/** Every tracked source file the map must classify: tests and generated code are not. */
export function sourceFiles(root = ROOT) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => SOURCE.test(f) && !EXCLUDED.test(f));
}

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
 * Every tracked source file, by layer, with its size in lines; what the map
 * does not classify; and every map entry that names no tracked file.
 */
export function inventory(root = ROOT, layers = LAYERS) {
  const files = sourceFiles(root);
  const byLayer = new Map();
  const unclassified = [];
  const used = new Set();
  for (const file of files) {
    const entry = entryFor(file, layers);
    if (entry === null) { unclassified.push(file); continue; }
    used.add(entry);
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

function main() {
  const { byLayer, unclassified, unused } = inventory();
  const problems = [
    ...unclassified.map((f) => `${f}: no layer; add it to LAYERS in lint/layers.mjs (ADR-0081)`),
    ...unused.map((e) => `LAYERS names ${JSON.stringify(e)}, which matches no tracked source file; remove or correct it`),
  ];
  for (const [entry, layer] of Object.entries(LAYERS)) {
    if (!LAYER_SHAPE.test(layer)) problems.push(`LAYERS gives ${JSON.stringify(entry)} the layer ${JSON.stringify(layer)}, which is not one ADR-0081 defines`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`lint-layers: ${p}`);
    process.exit(1);
  }
  const runtime = RUNTIME.reduce((sum, g) => sum + groupLines(byLayer, g), 0);
  console.log("lint-layers: OK — every tracked source file has a layer (ADR-0081)");
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
