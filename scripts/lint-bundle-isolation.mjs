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
// ── Invariants checked ────────────────────────────────────────────────────
//
//   Inv 1 — NO globalOutbound to a network-bearing service OR to an
//           `external` upstream unless tier=hypervisor. A cluster-tier
//           Worker that wires globalOutbound to a `network` service
//           (or doesn't override the default "internet") gets
//           unrestricted egress, breaking the ADR-0013 sandbox.
//           Extended per math-friend ADR-0018 review gap 4: external-
//           server-backed globalOutbound is ALSO forbidden — otherwise
//           a cluster-tier bundle could `globalOutbound = "mache-mcp"`
//           and reach an in-cluster upstream the lint never blessed.
//
//   Inv 2 — Vault / credential bindings only on declared tenants.
//           The allow-list is read from `cluster.capnp` bundles[].
//           holdsCredential (per math-friend gap 2). NO hand-edited JS
//           table — bindings that grant credential material live in
//           the manifest, audited as part of the same review that
//           tier-promotes a bundle.
//
//   Inv 3 — Every bundle in cluster.capnp MUST declare a tier AND, if
//           tier=hypervisor, a non-empty hypervisorRationale per math-
//           friend gap 1. The capnp schema enforces tier presence; the
//           rationale gate makes tier promotion a code-review event.
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
//   Inv 5 — Hypervisor-to-hypervisor service bindings MUST appear in
//           cluster.capnp `wires[]`. Per math-friend ADR-0018 review
//           gap 5: once notme-identity lands as a second hypervisor
//           tier bundle, inter-hypervisor topology becomes the next
//           ungoverned seam — a hypervisor bundle could grant itself
//           a service binding to another hypervisor without ever
//           appearing in the wire topology. Inv 5 closes that.
//
// Hypervisor-tier bundles get a pass on Inv 1, 2, 4 because they are
// the bundles ADR-0011's three-criterion test puts in charge of
// mediating trust. Inv 5 binds them — every hypervisor-to-hypervisor
// edge must be on the wire diagram.
//
// ── Scope: structural, not semantic ───────────────────────────────────────
//
// Per math-friend ADR-0018 review gap 6: this lint inspects binding
// NAMES + TARGET shapes, not VALUES. A text binding like
//
//     ( name = "INNOCUOUS_CONFIG", text = "keychain://com.cloister/master" )
//
// will pass this lint — there is no regex that reliably distinguishes
// "innocuous URL" from "secret-shaped URL." Detecting secrets in text-
// binding values is an arms race the lint deliberately stays out of;
// REVIEWERS MUST inspect text-binding VALUES during human review of
// config.capnp edits. The lint enforces the perimeter shape; humans
// enforce the content.
//
// ── Scope: config-time bindings only ──────────────────────────────────────
//
// Per math-friend ADR-0018 review gap 7: this lint relies on the
// property that all workerd bindings are declared in config.capnp at
// process start and immutable thereafter. Today this is enforced by
// the only two binding-injection paths:
//
//   - scripts/emit-workerd-config.mjs (the runtime config emitter)
//   - scripts/toml-to-cluster.mjs     (the cluster-manifest compiler — ADR-0025)
//
// (scripts/build-cluster.mjs is the legacy capnp-eval pipeline and still
// produces an equivalent cluster.ts; the drift gate
// `task cluster:toml:roundtrip` keeps them aligned.)
//
// If a future runtime-binding-injection path is added (e.g. dynamic
// `env.X = Y` assignment at request time, or a wasm-component-model
// FFI that exposes binding mutation), THIS LINT MUST BE RE-VERIFIED.
// The structural perimeter only works against config-time bindings.
//
// ── Cluster source (post-ADR-0025) ────────────────────────────────────────
//
// Reads `src/generated/cluster.ts` (the typed derived artifact) via
// dynamic import. cluster.toml is the authoritative operator source
// (ADR-0025), cluster.ts is the canonical typed artifact every other
// consumer already uses (the deployment emitters in scripts/emit-*.mjs,
// the cluster:dev launcher). The drift gate `task cluster:toml:roundtrip`
// ensures cluster.toml ↔ cluster.ts agreement; reading cluster.ts here
// keeps the lint in lock-step with what the runtime sees.
//
// Per cloister-cf519b (skeptic N3 follow-up from cloister-ae06f3).
//
// Exit codes:
//   0 — invariants hold
//   1 — violation found; details on stderr
//   2 — toolchain error (capnp eval / dynamic import failed, source unreadable, etc.)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();

// Network services in config.capnp that grant unrestricted egress — used
// by Inv 1 to detect when a cluster-tier Worker's globalOutbound is
// wired to one of them.
function isNetworkEgressService(serviceEntry) {
  if (!serviceEntry?.network) return false;
  const allow = serviceEntry.network.allow ?? [];
  return allow.includes("public") || allow.includes("private");
}

// Per math-friend gap 4: an external-server-backed service is also a
// network-reachable target — wiring globalOutbound to one bypasses the
// (a)/(b) discipline of Inv 4. Cluster-tier bundles must NOT name an
// external service as their globalOutbound.
function isExternalServerService(serviceEntry) {
  return Boolean(serviceEntry?.external);
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

// Load the cluster object from `src/generated/cluster.ts` via dynamic
// import. cluster.ts is the canonical derived artifact (ADR-0025); the
// drift gate `task cluster:toml:roundtrip` ensures it matches the
// authoritative cluster.toml.
//
// Requires the tsx loader (the Taskfile entry invokes
// `pnpm exec tsx scripts/lint-bundle-isolation.mjs`). When invoked
// without tsx (bare `node`), the dynamic import of a .ts file fails
// loudly with a useful error.
//
// CLUSTER_TS env-var overrides the default path — used by the test
// harness to point at a synthesized fixture.
async function loadCluster() {
  const clusterTsPath = process.env.CLUSTER_TS ?? resolve(REPO, "src/generated/cluster.ts");
  if (!existsSync(clusterTsPath)) {
    throw new Error(
      `cluster source not found at ${clusterTsPath} — run \`task cluster:toml\` ` +
        `(or set CLUSTER_TS to point at a generated cluster.ts)`,
    );
  }
  try {
    const mod = await import(pathToFileURL(clusterTsPath).href);
    if (!mod.cluster) {
      throw new Error(`${clusterTsPath} does not export 'cluster'`);
    }
    return mod.cluster;
  } catch (e) {
    throw new Error(
      `failed to load cluster source from ${clusterTsPath}: ${e.message}\n` +
        `(this script requires the tsx loader — invoke via ` +
        `\`pnpm exec tsx scripts/lint-bundle-isolation.mjs\` or use the ` +
        `\`task lint:bundle-isolation\` entry.)`,
    );
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

// ── Manifest-derived indexes (built once, consulted by all invariants) ───

// Build the credential allow-list FROM the cluster manifest, not from a
// hand-edited JS constant. Per math-friend gap 2. Output shape mirrors
// the old CREDENTIAL_BINDINGS map: { bindingName: [bundleName, ...] }.
function buildCredentialAllowList(cluster) {
  const allow = Object.create(null);
  for (const b of cluster.bundles ?? []) {
    for (const bindingName of b.holdsCredential ?? []) {
      if (!allow[bindingName]) allow[bindingName] = [];
      allow[bindingName].push(b.name);
    }
  }
  return allow;
}

// Build the workerd-service → bundle index FROM bundles[].workerdServiceName.
// Per math-friend gap 3: the prior alias map { cloister: "cloister-router" }
// was hand-edited and one rename away from silent mis-classification.
function buildServiceToBundleIndex(cluster) {
  const idx = Object.create(null);
  for (const b of cluster.bundles ?? []) {
    const svc = b.workerdServiceName;
    if (svc && svc.length > 0) {
      if (idx[svc]) {
        // Duplicate workerdServiceName is itself a config error — two
        // bundles claiming the same workerd service have ambiguous tier
        // resolution. Lint flags this loudly rather than silently
        // picking one.
        throw new Error(
          `duplicate workerdServiceName "${svc}" claimed by bundles ` +
          `"${idx[svc]}" and "${b.name}" — each workerd service must ` +
          `map to at most one cluster bundle`,
        );
      }
      idx[svc] = b.name;
    }
  }
  return idx;
}

// ── Walk: per-Worker analysis ────────────────────────────────────────────

function workersIn(config) {
  return (config.services ?? []).filter((s) => s.worker);
}

function tierForWorker(workerName, cluster, serviceToBundle, warnings) {
  // The workerdServiceName field in cluster.capnp is the canonical join
  // key. A workerd service that isn't claimed by any bundle is treated
  // as cluster-tier (the strictest default — orphans don't get
  // hypervisor privileges), but a WARNING surfaces because that's the
  // alias-miss case math-friend gap 3 highlighted: silent default is
  // either an unmapped bundle or a typo.
  const bundleName = serviceToBundle[workerName];
  if (!bundleName) {
    warnings.push(
      `lint-bundle-isolation: workerd service "${workerName}" has no ` +
      `matching bundle in cluster.capnp (no bundle declares ` +
      `workerdServiceName = "${workerName}"). Treating as cluster-tier ` +
      `(strict default). If this Worker IS a cluster bundle, add ` +
      `workerdServiceName = "${workerName}" to its entry. If it's an ` +
      `auxiliary service with no bundle counterpart, this warning is ` +
      `informational.`,
    );
    return { tier: "cluster", bundleName: null };
  }
  const bundle = (cluster.bundles ?? []).find((b) => b.name === bundleName);
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
  const target = typeof gob === "string" ? gob : gob.name;
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
    return;
  }
  // Per math-friend gap 4: an external-server-backed service is also a
  // network-reachable upstream. A cluster-tier bundle pointing
  // globalOutbound at one bypasses Inv 4's wire/external discipline by
  // making ALL unbound fetch() egress reach that target.
  if (isExternalServerService(svc)) {
    violations.push(
      `lint-bundle-isolation: Worker "${workerSvc.name}" (tier=${tier}) ` +
      `wires globalOutbound to external-server service "${target}" — ` +
      `cluster-tier bundles MUST route external upstreams through an ` +
      `explicit service binding, not via globalOutbound (Inv 1, ADR-0013, ` +
      `gap 4 of the ADR-0018 lint review). This shape would let unbound ` +
      `fetch() in the worker reach "${target}" without an authorized ` +
      `binding name on this bundle's manifest.`,
    );
  }
}

function checkInvariant2(workerSvc, bundleName, credentialAllowList, violations) {
  for (const b of bindingsOf(workerSvc)) {
    const allow = credentialAllowList[b.name];
    if (!allow) continue;
    // Resolve the workerd service name back through the workerdServiceName
    // index — but at this point the caller already has the bundle name in
    // hand, so use it directly. If bundleName is null (no manifest match)
    // the lint already flagged the orphan; treat null as a separate
    // failure surface (orphan worker can't hold credentials).
    if (bundleName === null) {
      violations.push(
        `lint-bundle-isolation: Worker "${workerSvc.name}" has credential ` +
        `binding "${b.name}" but is not mapped to any cluster bundle ` +
        `(no bundle declares workerdServiceName = "${workerSvc.name}"). ` +
        `Add the bundle to cluster.capnp with holdsCredential = [..., ` +
        `"${b.name}", ...] OR remove the binding from the workerd config.`,
      );
      continue;
    }
    if (!allow.includes(bundleName)) {
      violations.push(
        `lint-bundle-isolation: Worker "${workerSvc.name}" (bundle ` +
        `"${bundleName}") has binding "${b.name}" but is not on the ` +
        `credential-binding allow-list (allowed: ${allow.join(", ")}) — ` +
        `Inv 2, ADR-0013. To grant this binding, add "${b.name}" to the ` +
        `bundle's holdsCredential list in cluster.capnp.`,
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
      continue;
    }
    if (b.tier !== "hypervisor" && b.tier !== "cluster") {
      violations.push(
        `lint-bundle-isolation: bundle "${b.name}" has unknown tier ` +
        `"${b.tier}" — must be "hypervisor" or "cluster" (Inv 3, ADR-0011).`,
      );
      continue;
    }
    // Per math-friend gap 1: tier=hypervisor inherits Inv 1 / Inv 2 /
    // Inv 4 exemptions, so promotion to hypervisor needs an explicit
    // justification visible in code review.
    if (b.tier === "hypervisor") {
      const rationale = b.hypervisorRationale ?? "";
      if (rationale.trim().length === 0) {
        violations.push(
          `lint-bundle-isolation: bundle "${b.name}" is tier=hypervisor ` +
          `but hypervisorRationale is empty — Inv 3, ADR-0011 three-` +
          `criterion test. Promotion to hypervisor inherits the Inv 1/2/4 ` +
          `exemptions and must be explicitly justified in the manifest. ` +
          `Add a non-empty hypervisorRationale = "..." field explaining ` +
          `(a) the trust-mediation role, (b) the multi-bundle blast ` +
          `radius, and (c) the singleton property.`,
        );
      }
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

// Inv 5 — Hypervisor-to-hypervisor service bindings MUST appear in
// cluster.capnp `wires[]`. Per math-friend ADR-0018 review gap 5.
//
// The check: for a hypervisor-tier Worker, every service binding whose
// target maps to ANOTHER hypervisor-tier bundle (via workerdServiceName
// or a `service` entry whose name matches a bundle) must have a
// corresponding wire entry. External-server-backed bindings still get
// the (b) carve-out — those don't address a bundle.
function checkInvariant5(workerSvc, tier, bundleName, cluster, services, serviceToBundle, violations) {
  if (tier !== "hypervisor") return;
  if (!bundleName) return;
  const externalServices = new Set(
    services.filter((s) => s.external).map((s) => s.name),
  );
  // Build set of hypervisor-tier bundle names for quick lookup.
  const hypervisorBundles = new Set(
    (cluster.bundles ?? []).filter((b) => b.tier === "hypervisor").map((b) => b.name),
  );
  const wireBindings = new Set(
    (cluster.wires ?? [])
      .filter((w) => w.from === bundleName)
      .map((w) => w.binding),
  );
  for (const b of bindingsOf(workerSvc)) {
    if (!b.service) continue;
    const target = typeof b.service === "string" ? b.service : b.service.name;
    if (externalServices.has(target)) continue;  // external upstream, not a bundle
    // Does this service binding's target name map to a hypervisor-tier
    // bundle? Two paths:
    //   (1) the target IS a workerdServiceName claimed by a hypervisor
    //       bundle (e.g. service "cloister" → bundle "cloister-router")
    //   (2) the target name EQUALS a hypervisor bundle's name directly
    //       (e.g. a `service = "notme-identity"` binding)
    const mappedBundle = serviceToBundle[target];
    const targetBundle = mappedBundle ?? target;
    if (!hypervisorBundles.has(targetBundle)) continue;
    // Self-binding (hypervisor bundle binding to itself) — no wire
    // required; intra-bundle plumbing.
    if (targetBundle === bundleName) continue;
    if (wireBindings.has(b.name)) continue;       // wired ✓
    violations.push(
      `lint-bundle-isolation: hypervisor-tier bundle "${bundleName}" has ` +
      `service binding "${b.name}" (→ hypervisor "${targetBundle}") but no ` +
      `matching wire in cluster.capnp — Inv 5, ADR-0018 review gap 5. ` +
      `Inter-hypervisor topology must be on the wire diagram even when ` +
      `both ends are hypervisor-tier. Add a wire from "${bundleName}" to ` +
      `"${targetBundle}" with binding="${b.name}".`,
    );
  }
}

// ── Run ──────────────────────────────────────────────────────────────────

let cluster, config;
try {
  cluster = await loadCluster();
  config = evalConfig();
} catch (e) {
  console.error(`lint-bundle-isolation: ${e.message}`);
  process.exit(2);
}

const violations = [];
const warnings = [];

let credentialAllowList;
let serviceToBundle;
try {
  credentialAllowList = buildCredentialAllowList(cluster);
  serviceToBundle = buildServiceToBundleIndex(cluster);
} catch (e) {
  console.error(`lint-bundle-isolation: ${e.message}`);
  process.exit(1);
}

checkInvariant3(cluster, violations);

const services = config.services ?? [];
for (const wsvc of workersIn(config)) {
  const { tier, bundleName } = tierForWorker(wsvc.name, cluster, serviceToBundle, warnings);
  checkInvariant1(wsvc, tier, services, violations);
  checkInvariant2(wsvc, bundleName, credentialAllowList, violations);
  checkInvariant4(wsvc, tier, bundleName, cluster, services, violations);
  checkInvariant5(wsvc, tier, bundleName, cluster, services, serviceToBundle, violations);
}

if (warnings.length) {
  for (const w of warnings) console.error(`  ⚠ ${w}`);
  console.error("");
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
console.log(`  ${bundleCount} bundle(s) in src/generated/cluster.ts`);
console.log(`  invariants 1–5 hold (ADR-0013 sandbox preserved)`);
