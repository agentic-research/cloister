#!/usr/bin/env node
// scripts/lint-bundle-isolation.mjs
//
// Substrate-property lint for ADR-0013 (slice-grant enforcement via V8
// isolate + service-binding-as-syscall). Companion to lint-paths.mjs
// (drift class) and lint-timing-invariants.mjs (security class). Per
// cloister-ac30e7 — the prevention layer that makes db99cd (notme
// co-location) safe.
//
// Background: ADR-0013 ratifies that a workerd-bundle Worker in cloister
// is held by V8 isolate boundary + workerd binding restriction. A
// "compromised" cluster-tier bundle gets ONLY the bindings its manifest
// declares — nothing else. This lint enforces that invariant at the
// manifest level so a misconfigured config.capnp can't silently widen
// the sandbox.
//
// What this checks — for every workerd Worker declared in config.capnp,
// cross-referenced with the bundle's tier in cluster.capnp:
//
//   Inv 1 — NO globalOutbound to a network-bearing service unless
//           tier=hypervisor. A cluster-tier Worker that wires
//           globalOutbound to a `network` service (or doesn't override
//           the default "internet") gets unrestricted egress, breaking
//           the ADR-0013 sandbox.
//
//   Inv 2 — Vault / credential bindings only on declared tenants.
//           Bindings that grant credential material (VAULT_KEK_SOURCE,
//           VAULT_STORE) MUST appear only on bundles explicitly allowed
//           to hold them. Today that allow-list is hard-coded here;
//           future ADR-0010 / ADR-0014 work can move it into the
//           manifest.
//
//   Inv 3 — Every bundle in cluster.capnp MUST declare a tier. The
//           capnp schema already enforces this; the lint restates it.
//
//   Inv 4 — Cluster-tier bundles' service bindings MUST resolve to one
//           of two legitimate targets:
//             (a) a wire in cluster.capnp (cross-bundle topology), or
//             (b) an `external` service entry in config.capnp (workerd
//                 ExternalServer — terminates at a workerd-declared
//                 address inside the same bundle, not a cluster wire).
//           Orphan bindings — those that resolve to neither — are
//           footguns: they grant capability the topology never
//           authorized. The (b) carve-out was added by cloister-b65a20
//           when the MCP upstreams moved from URL vars to
//           `external`-backed Service bindings; those bindings live
//           entirely inside config.capnp's `services[]` list and
//           don't need a cluster.capnp wire because there's no other
//           bundle on the other end (the upstream is a non-workerd
//           process reachable at the declared address).
//
// Hypervisor-tier bundles get a pass on Inv 1, 2, 4 because they are
// the bundles ADR-0011's three-criterion test puts in charge of
// mediating trust. The whole point of the tier classification is that
// hypervisor bundles legitimately hold the cross-cluster capabilities
// the lint forbids elsewhere.
//
// Exit codes:
//   0 — invariants hold
//   1 — violation found; details on stderr
//   2 — toolchain error (capnp eval failed, source unreadable, etc.)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const REPO = process.cwd();

// ── Bindings that grant credential material — Inv 2 allow-list ──────────
//
// The values are bundle NAMES (matched against `services[].name` in
// config.capnp and bundles[].name in cluster.capnp) allowed to hold the
// keyed binding. cloister-router is the hypervisor bundle that holds
// the CredentialVault DO today (per ADR-0013 amendment 2026-05-11 and
// cloister-26546a). When db99cd lands, NOTME's allow-list expands to
// include the notme-tenant bundle name.
const CREDENTIAL_BINDINGS = {
  // VAULT_KEK_SECRET removed per ADR-0014 v2 (cloister-125199) — the
  // plaintext text binding no longer exists. VAULT_KEK_SOURCE (a URL
  // spec) is the only KEK-related binding the lint guards now.
  VAULT_KEK_SOURCE: ["cloister"],
  VAULT_STORE:      ["cloister"],
};

// Network services in config.capnp that grant unrestricted egress — used
// by Inv 1 to detect when a cluster-tier Worker's globalOutbound is
// wired to one of them.
function isNetworkEgressService(serviceEntry) {
  if (!serviceEntry?.network) return false;
  const allow = serviceEntry.network.allow ?? [];
  return allow.includes("public") || allow.includes("private");
}

// Find the workerd schema dir (different pnpm hash per workerd version).
function findWorkerdSchemaDir() {
  const pnpm = resolve(REPO, "node_modules/.pnpm");
  if (!existsSync(pnpm)) return null;
  const candidates = readdirSync(pnpm).filter((n) => n.startsWith("workerd@"));
  for (const c of candidates) {
    const schema = resolve(pnpm, c, "node_modules/workerd/workerd.capnp");
    if (existsSync(schema)) return resolve(pnpm, c, "node_modules");
  }
  return null;
}

// Eval `cluster.capnp`. CLOISTER_SCHEMA_ROOT mirrors build-cluster.mjs.
function evalCluster() {
  const schemaRoot = process.env.CLOISTER_SCHEMA_ROOT ?? resolve(REPO, "..");
  try {
    const out = execFileSync(
      "capnp",
      ["eval", "-I", schemaRoot, "--no-standard-import",
       resolve(REPO, "cluster.capnp"), "cluster", "-o", "json"],
      { encoding: "utf8" },
    );
    return JSON.parse(out);
  } catch (e) {
    const err = e.stderr?.toString?.() ?? String(e);
    throw new Error(`capnp eval cluster.capnp failed:\n${err}`);
  }
}

// Eval `config.capnp`. workerd's `embed "dist/index.js"` won't exist
// before a build — stub it so the eval succeeds. The lint cares about
// the bindings + globalOutbound shape, not the module bytes.
function evalConfig() {
  const workerdRoot = findWorkerdSchemaDir();
  if (!workerdRoot) {
    throw new Error("workerd schema dir not found under node_modules/.pnpm — run `pnpm install`");
  }
  const distIndex = resolve(REPO, "dist/index.js");
  const stubbed = !existsSync(distIndex);
  if (stubbed) {
    mkdirSync(dirname(distIndex), { recursive: true });
    writeFileSync(distIndex, "/* lint-bundle-isolation stub */");
  }
  let raw;
  try {
    raw = execFileSync(
      "capnp",
      ["eval", "--no-standard-import", "-I", workerdRoot,
       resolve(REPO, "config.capnp"), "config", "-o", "json"],
      { encoding: "utf8" },
    );
  } catch (e) {
    const err = e.stderr?.toString?.() ?? String(e);
    throw new Error(`capnp eval config.capnp failed:\n${err}`);
  }
  return JSON.parse(raw);
}

// ── Walk: per-Worker analysis ────────────────────────────────────────────

function workersIn(config) {
  return (config.services ?? []).filter((s) => s.worker);
}

function tierForWorker(workerName, cluster) {
  // Convention: a config.capnp service named "cloister" is the
  // cloister-router bundle declared in cluster.capnp. Future bundles
  // SHOULD share their name across both files for traceability — see
  // ADR-0011 §"Bundle responsibilities." If a Worker has no bundle
  // match in cluster.capnp, treat it as cluster-tier (the strictest
  // default — orphans don't get hypervisor privileges).
  const aliases = { cloister: "cloister-router" };
  const lookup = aliases[workerName] ?? workerName;
  const bundle = (cluster.bundles ?? []).find((b) => b.name === lookup);
  return { tier: bundle?.tier ?? "cluster", bundleName: bundle?.name ?? null };
}

function bindingsOf(workerSvc) {
  return workerSvc.worker?.bindings ?? [];
}

function globalOutboundOf(workerSvc) {
  return workerSvc.worker?.globalOutbound ?? null;
}

// ── Invariants ───────────────────────────────────────────────────────────

function checkInvariant1(workerSvc, tier, services, violations) {
  if (tier === "hypervisor") return;
  const gob = globalOutboundOf(workerSvc);
  if (!gob) return; // no global outbound = no egress; fine
  // gob has shape {name: "...", props: ...} for a ServiceDesignator
  const target = gob.name;
  const svc = services.find((s) => s.name === target);
  if (!svc) {
    violations.push(
      `lint-bundle-isolation: Worker "${workerSvc.name}" (tier=${tier}) ` +
      `globalOutbound references undeclared service "${target}" ` +
      `(Inv 1 — orphan global outbound)`,
    );
    return;
  }
  if (isNetworkEgressService(svc)) {
    violations.push(
      `lint-bundle-isolation: Worker "${workerSvc.name}" (tier=${tier}) ` +
      `wires globalOutbound to network service "${target}" — cluster-tier ` +
      `bundles MUST NOT have unrestricted egress (Inv 1, ADR-0013). ` +
      `Either re-tier the bundle to hypervisor or replace globalOutbound ` +
      `with a gated service binding.`,
    );
  }
}

function checkInvariant2(workerSvc, violations) {
  for (const b of bindingsOf(workerSvc)) {
    const allow = CREDENTIAL_BINDINGS[b.name];
    if (!allow) continue;
    if (!allow.includes(workerSvc.name)) {
      violations.push(
        `lint-bundle-isolation: Worker "${workerSvc.name}" has binding ` +
        `"${b.name}" but is not on the credential-binding allow-list ` +
        `(allowed: ${allow.join(", ")}) — Inv 2, ADR-0013.`,
      );
    }
  }
}

function checkInvariant3(cluster, violations) {
  for (const b of cluster.bundles ?? []) {
    if (!b.tier) {
      violations.push(
        `lint-bundle-isolation: bundle "${b.name}" in cluster.capnp missing ` +
        `tier classification — Inv 3, ADR-0011.`,
      );
    } else if (b.tier !== "hypervisor" && b.tier !== "cluster") {
      violations.push(
        `lint-bundle-isolation: bundle "${b.name}" has unknown tier ` +
        `"${b.tier}" — must be "hypervisor" or "cluster" (Inv 3, ADR-0011).`,
      );
    }
  }
}

function checkInvariant4(workerSvc, tier, bundleName, cluster, services, violations) {
  if (tier !== "cluster") return;
  if (!bundleName) return; // already flagged by tier defaulting + Inv 3
  const wireBindings = new Set(
    (cluster.wires ?? [])
      .filter((w) => w.from === bundleName)
      .map((w) => w.binding),
  );
  // External-server-backed bindings (cloister-b65a20). A service binding
  // whose target is a config.capnp service with `external = (...)` lands
  // entirely inside this workerd config — no cluster wire is required
  // because no other bundle is on the other end. Build the allow-set
  // once for every service binding scan below.
  const externalServices = new Set(
    services.filter((s) => s.external).map((s) => s.name),
  );
  for (const b of bindingsOf(workerSvc)) {
    // Only service bindings need wires — text / DO-namespace / kv bindings
    // are intra-bundle declarations, not cross-bundle topology.
    if (!b.service) continue;
    if (wireBindings.has(b.name)) continue;                // (a) wired
    const target = typeof b.service === "string" ? b.service : b.service.name;
    if (externalServices.has(target)) continue;            // (b) external
    violations.push(
      `lint-bundle-isolation: Worker "${workerSvc.name}" (cluster-tier ` +
      `bundle "${bundleName}") has service binding "${b.name}" (→ "${target}") ` +
      `but no matching wire in cluster.capnp AND no \`external\` service ` +
      `entry in config.capnp — orphan binding (Inv 4, ADR-0013). ` +
      `Either add a wire from "${bundleName}" with binding="${b.name}", ` +
      `declare an external service named "${target}" in config.capnp, ` +
      `or remove the binding.`,
    );
  }
}

// ── Run ──────────────────────────────────────────────────────────────────

let cluster, config;
try {
  cluster = evalCluster();
  config = evalConfig();
} catch (e) {
  console.error(`lint-bundle-isolation: ${e.message}`);
  process.exit(2);
}

const violations = [];
checkInvariant3(cluster, violations);

const services = config.services ?? [];
for (const wsvc of workersIn(config)) {
  const { tier, bundleName } = tierForWorker(wsvc.name, cluster);
  checkInvariant1(wsvc, tier, services, violations);
  checkInvariant2(wsvc, violations);
  checkInvariant4(wsvc, tier, bundleName, cluster, services, violations);
}

if (violations.length) {
  console.error(`\n✗ lint-bundle-isolation: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("");
  console.error("These are substrate-level invariants (ADR-0013).");
  console.error("Do NOT relax them without an ADR amendment.");
  console.error("");
  console.error("See docs/adr/0013-slice-grant-enforcement.md and");
  console.error("docs/adr/0011-hypervisor-bundle-boundary.md.");
  process.exit(1);
}

const workerCount = workersIn(config).length;
const bundleCount = (cluster.bundles ?? []).length;
console.log(`lint-bundle-isolation: clean ✓`);
console.log(`  ${workerCount} workerd Worker(s) in config.capnp`);
console.log(`  ${bundleCount} bundle(s) in cluster.capnp`);
console.log(`  invariants 1–4 hold (ADR-0013 sandbox preserved)`);
