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
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { parse as parseToml } from "@iarna/toml";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isCanonicalAbsolutePath } from "./lib/canonical-path.mjs";
import { resolveTenancy } from "./emit-compose.mjs";

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

/**
 * Invariant 6 (ADR-0030 §"Substrate-property lint gains a property" /
 * cloister-104199): tenancy.workerdId on every `[inputs.*]` MUST resolve
 * to a bundle declared in `cluster.bundles[]`, AND the bundle's tier
 * MUST align with the operator's trustedTier hint:
 *
 *   - tenancy.trustedTier = true   → bundle.tier MUST be "hypervisor"
 *                                    (trusted-tier bundles carry
 *                                    hypervisor-layer bindings per
 *                                    ADR-0013).
 *   - tenancy.trustedTier = false  → bundle.tier MUST be "cluster"
 *                                    (tool-bundle workers are sandboxed
 *                                    per the slice-grant model).
 *
 * Same-name fallback (rung 2 of emit-compose's resolveTenancy):
 * empty `tenancy.workerdId` + a bundle named like the input → that
 * bundle hosts it. Gateway fallback (rung 3): empty `workerdId` + no
 * same-name → the hypervisor-tier bundle hosts it. Same three rungs
 * the compose-emitter uses, so the lint matches what's actually
 * generated.
 *
 * `tenancy.sharesWorkerdWith` consistency: each named co-tenant must
 * exist as another `[inputs.*]` entry, and must resolve to the SAME
 * workerdId. Asymmetric: A declaring shares-with-B is enough — B
 * doesn't have to declare it back, but if it does, the resolved
 * workerdIds must agree.
 *
 * Skipped (no-op) when the cluster has no inputs declared (pre-ADR-0030
 * cluster.toml is back-compat by construction).
 */
function checkInvariant6(cluster, violations) {
  const bundles = cluster.bundles ?? [];
  const bundleByName = new Map(bundles.map((b) => [b.name, b]));
  const gateway = bundles.find((b) => b.tier === "hypervisor");
  const inputs = cluster.inputs ?? [];

  // Index inputs by name for sharesWorkerdWith cross-checks.
  const inputByName = new Map(inputs.map((i) => [i.name, i]));
  const resolvedWorkerdId = new Map(); // input name → resolved workerd_id

  for (const input of inputs) {
    const t = input.tenancy ?? {};
    const declared = typeof t.workerdId === "string" ? t.workerdId : "";
    let workerdId;
    if (declared !== "") {
      // Rung 1: explicit declaration. Must resolve.
      workerdId = declared;
      if (!bundleByName.has(workerdId)) {
        violations.push(
          `lint-bundle-isolation: input "${input.name}" declares ` +
          `tenancy.workerdId="${workerdId}" but no bundle of that name ` +
          `exists in cluster.bundles[] — Inv 6, ADR-0030 §A5.`,
        );
        continue;
      }
    } else if (bundleByName.has(input.name)) {
      // Rung 2: same-name bundle exists.
      workerdId = input.name;
    } else if (gateway) {
      // Rung 3: back-compat fallback to the gateway / hypervisor-tier
      // bundle. The compose-emitter does the same fallback; the lint
      // matches the emitter's behavior.
      workerdId = gateway.name;
    } else {
      violations.push(
        `lint-bundle-isolation: input "${input.name}" has no resolvable ` +
        `workerd_id — no explicit tenancy.workerdId, no same-name bundle, ` +
        `and no hypervisor-tier bundle to fall back on. Declare a ` +
        `tenancy.workerdId or add a [[bundles]] entry. Inv 6, ADR-0030 §A5.`,
      );
      continue;
    }
    resolvedWorkerdId.set(input.name, workerdId);

    // Trusted-tier alignment check.
    const trustedTier = t.trustedTier === true;
    const bundle = bundleByName.get(workerdId);
    if (!bundle) continue; // already flagged above
    if (trustedTier && bundle.tier !== "hypervisor") {
      violations.push(
        `lint-bundle-isolation: input "${input.name}" declares ` +
        `tenancy.trustedTier=true but its workerd_id "${workerdId}" ` +
        `is bundle.tier="${bundle.tier}". Trusted-tier inputs MUST be ` +
        `hosted on a hypervisor-tier bundle per ADR-0013 / threat-model ` +
        `§13.7.4. Inv 6, ADR-0030 §A5.`,
      );
    }
    if (!trustedTier && bundle.tier === "hypervisor") {
      // Non-trusted-tier input lands on hypervisor bundle. RESOLVED-
      // workerdId-aware check per cloister-93132f (C2) — fires
      // regardless of how the input resolved (explicit, same-name,
      // gateway-fallback, sharesWorkerdWith-transitive). Previously
      // the check fired only on explicit declaration, which allowed
      // an operator to bypass via sharesWorkerdWith or the rung-3
      // back-compat gateway fallback.
      //
      // To preserve back-compat for pre-ADR-0030 cluster.toml (which
      // typically has [inputs.llo] etc. that implicitly land on the
      // gateway), the rung-3 gateway fallback is EXEMPTED — but ONLY
      // when input.name doesn't suggest a trusted-tier shape and the
      // operator hasn't declared workerdId/sharesWorkerdWith. That
      // narrow exemption matches the historical shape (llo composed
      // into the router with no explicit tenancy) without admitting
      // the sharesWorkerdWith bypass.
      const isPureRung3Fallback =
        declared === "" &&
        !bundleByName.has(input.name) &&
        (!Array.isArray(t.sharesWorkerdWith) || t.sharesWorkerdWith.length === 0);
      if (!isPureRung3Fallback) {
        violations.push(
          `lint-bundle-isolation: input "${input.name}" resolves to ` +
          `workerd_id "${workerdId}" (a hypervisor-tier bundle) but ` +
          `tenancy.trustedTier is not true. Either flip trustedTier ` +
          `to acknowledge the trust grant, or move the input to a ` +
          `cluster-tier bundle. Resolution rung: ${
            declared !== "" ? "explicit" :
            bundleByName.has(input.name) ? "same-name" :
            (Array.isArray(t.sharesWorkerdWith) && t.sharesWorkerdWith.length > 0) ? "sharesWorkerdWith-transitive" :
            "gateway-fallback"
          }. Inv 6, ADR-0030 §A5.`,
        );
      }
    }
  }

  // sharesWorkerdWith cross-checks. Asymmetric — A→B is enforced; B
  // need not declare A. But if both declare each other, resolved
  // workerd_ids must agree.
  for (const input of inputs) {
    const sharesWith = Array.isArray(input.tenancy?.sharesWorkerdWith)
      ? input.tenancy.sharesWorkerdWith
      : [];
    for (const partner of sharesWith) {
      const partnerInput = inputByName.get(partner);
      if (!partnerInput) {
        violations.push(
          `lint-bundle-isolation: input "${input.name}" declares ` +
          `tenancy.sharesWorkerdWith="${partner}" but no input of that ` +
          `name exists in cluster.inputs[]. Inv 6, ADR-0030 §A5.`,
        );
        continue;
      }
      const myWid = resolvedWorkerdId.get(input.name);
      const partnerWid = resolvedWorkerdId.get(partner);
      if (myWid && partnerWid && myWid !== partnerWid) {
        violations.push(
          `lint-bundle-isolation: input "${input.name}" declares ` +
          `sharesWorkerdWith="${partner}" but their resolved workerd_ids ` +
          `differ ("${myWid}" vs "${partnerWid}"). Co-tenants must share ` +
          `a workerd. Inv 6, ADR-0030 §A5.`,
        );
      }
    }
  }
}

/**
 * Invariant 7 (ADR-0034 / cloister-ce936e): every `TenantDispatchRow`
 * in a `tenantDispatch` route MUST resolve to a `[[wires]]` entry
 * whose `to` bundle hosts inputs sharing the same `workerdId` as the
 * row's `name`. This is the tenant-dispatch ↔ workerd-alignment
 * invariant — without it, an operator can declare routing to a
 * tenant that has no actual workerd to receive it.
 *
 * Per `docs/reference/tenancy-model.md`. The substrate's two tenancy
 * primitives (`InputSpec.tenancy` per-input + `TenantDispatchRow`
 * per-route) compose via this invariant: the row's `binding` resolves
 * a wire to a bundle; that bundle hosts inputs; those inputs declare a
 * `workerdId` that MUST match the row's `name`.
 *
 * Skipped (no-op) when no tenantDispatch route is declared (pre-ADR-0034
 * single-tenant deployments are back-compat by construction).
 */
function checkInvariant7(cluster, violations) {
  const routes = cluster.routes ?? [];
  const tenantDispatchRoutes = routes.filter((r) => r.kind?.tenantDispatch);
  if (tenantDispatchRoutes.length === 0) return; // no-op: single-tenant

  const wires    = cluster.wires ?? [];
  const bundles  = cluster.bundles ?? [];
  const inputs   = cluster.inputs ?? [];

  // Index: binding name → wire.to bundle name
  const bindingToBundle = new Map();
  for (const w of wires) {
    if (w.binding && w.to) bindingToBundle.set(w.binding, w.to);
  }
  // Index: bundle name → set of workerdIds hosted (from inputs declaring
  // this bundle as their workerdId resolution target). Per ADR-0030 §A5
  // resolution rules: explicit input.tenancy.workerdId wins; same-name
  // bundle is fallback rung 2; gateway is rung 3.
  const gateway = bundles.find((b) => b.tier === "hypervisor");
  const workerdIdByInput = new Map();
  for (const inp of inputs) {
    const t = inp.tenancy ?? {};
    const declared = typeof t.workerdId === "string" ? t.workerdId : "";
    let workerdId;
    if (declared !== "") workerdId = declared;
    else if (bundles.some((b) => b.name === inp.name)) workerdId = inp.name;
    else if (gateway) workerdId = gateway.name;
    else continue;
    workerdIdByInput.set(inp.name, workerdId);
  }

  for (const route of tenantDispatchRoutes) {
    const tenants = route.kind.tenantDispatch.tenants ?? [];
    for (const row of tenants) {
      if (!row.binding) continue; // operator error caught elsewhere
      const targetBundle = bindingToBundle.get(row.binding);
      if (!targetBundle) {
        violations.push(
          `lint-bundle-isolation: tenantDispatch row "${row.name}" ` +
          `(binding=${JSON.stringify(row.binding)}) does not resolve to any ` +
          `[[wires]] entry — Inv 7, ADR-0034 / cloister-ce936e. Declare a ` +
          `wire with binding=${JSON.stringify(row.binding)} OR remove the ` +
          `tenant row.`,
        );
        continue;
      }
      // Find the set of workerdIds that inputs assign to this bundle.
      // Phase 1 acceptance: if ANY input resolves to targetBundle with
      // workerdId == row.name, the row aligns. Stricter checks (every
      // input assigns the same workerdId) are deferred to a future Inv 8
      // when per-bundle tenancy lands (cloister-cedcf3).
      const aligned = Array.from(workerdIdByInput.entries()).some(
        ([inputName, wid]) => {
          // Input's workerdId resolution lands on this bundle: either
          // input.name == bundle (rung 2) OR input.tenancy.workerdId
          // names the bundle (rung 1).
          if (wid !== targetBundle && inputName !== targetBundle) return false;
          // And the workerdId matches the row's tenant name.
          return wid === row.name;
        },
      );
      // Soft check: when no inputs are declared (pre-ADR-0026 cluster.toml),
      // skip the alignment check — the recipe demonstrates the routing
      // primitive without requiring a full inputs declaration.
      if (inputs.length === 0) continue;
      if (!aligned) {
        violations.push(
          `lint-bundle-isolation: tenantDispatch row "${row.name}" routes to ` +
          `bundle "${targetBundle}" (via binding ${JSON.stringify(row.binding)}) ` +
          `but no input declares tenancy.workerdId="${row.name}" against ` +
          `that bundle — Inv 7, ADR-0034. Add an [inputs.X].tenancy with ` +
          `workerdId="${row.name}" OR rename the tenant row to match an ` +
          `existing input's workerdId.`,
        );
      }
    }
  }
}

/**
 * Invariant 8 (ADR-0034 / cloister-cedcf3 Phase 2): a bundle declaring
 * `perTenant = true` MUST have a `tenantDispatch` route declared in
 * `cluster.routes`. Otherwise the per-tenant declaration is a no-op —
 * the operator asked for tenant-scoped instances but provided no way to
 * route external traffic to them.
 *
 * Stricter sub-check: if a `tenantDispatch` route exists, at least ONE
 * of its tenants' `binding` values SHOULD wire to the perTenant bundle.
 * Phase 1 implements only the existence check; the binding-wires-to-this-
 * bundle correlation is deferred to a future Inv 9 (needs the wire graph
 * walked + per-bundle binding resolution).
 *
 * Per `docs/reference/tenancy-model.md`. The substrate's `perTenant`
 * field (cluster.capnp Bundle.perTenant @8) signals to emit-compose
 * Phase 2 that one container per tenant should be emitted; this lint
 * catches the typo / forgotten-route case at the manifest layer instead
 * of surfacing as silent absence at boot.
 *
 * Skipped (no-op) when no perTenant bundles exist (pre-cedcf3
 * deployments are back-compat by construction).
 */
function checkInvariant8(cluster, violations) {
  const bundles = cluster.bundles ?? [];
  const perTenantBundles = bundles.filter((b) => b.perTenant === true);
  if (perTenantBundles.length === 0) return; // no-op for non-multi-tenant

  const routes = cluster.routes ?? [];
  const hasTenantDispatch = routes.some((r) => r.kind?.tenantDispatch);
  if (!hasTenantDispatch) {
    for (const b of perTenantBundles) {
      violations.push(
        `lint-bundle-isolation: bundle "${b.name}" declares perTenant = true but ` +
        `cluster.routes has NO tenantDispatch route — Inv 8, ADR-0034 / cloister-cedcf3. ` +
        `Add a [[routes]] entry with kind = "tenantDispatch" OR remove the ` +
        `perTenant flag from this bundle.`,
      );
    }
  }
}

/**
 * Invariant 9 (ADR-0034 / cloister-cedcf3 Phase 2 piece 3): each
 * perTenant=true bundle must be the `to` of at least one `[[wires]]`
 * entry whose `binding` appears in a `tenantDispatch` row. Otherwise
 * the perTenant declaration is reachable only via direct in-cluster
 * bindings — external traffic can't dispatch to a per-tenant instance
 * of the bundle.
 *
 * The chain Inv 9 enforces:
 *
 *   tenantDispatch row.binding ──► [[wires]].binding (same name)
 *                                   └─► [[wires]].to == this perTenant bundle's name
 *
 * Without this chain, an operator might declare `perTenant=true` and a
 * tenantDispatch route, but wire their tenantDispatch rows to a
 * DIFFERENT bundle. Inv 8 catches the no-route case; Inv 9 catches the
 * wrong-route case.
 *
 * Skipped (no-op) when there are no perTenant bundles OR no
 * tenantDispatch routes (Inv 8 covers those edges).
 */
function checkInvariant9(cluster, violations) {
  const bundles    = cluster.bundles ?? [];
  const wires      = cluster.wires ?? [];
  const routes     = cluster.routes ?? [];
  const perTenantBundles = bundles.filter((b) => b.perTenant === true);
  const tenantDispatchRoutes = routes.filter((r) => r.kind?.tenantDispatch);

  // Both sides empty → Inv 8 handles edges; here just no-op.
  if (perTenantBundles.length === 0) return;
  if (tenantDispatchRoutes.length === 0) return; // Inv 8 already flagged

  // Build the set of bindings referenced by any tenantDispatch row.
  const dispatchedBindings = new Set();
  for (const route of tenantDispatchRoutes) {
    const tenants = route.kind.tenantDispatch.tenants ?? [];
    for (const row of tenants) {
      if (row.binding) dispatchedBindings.add(row.binding);
    }
  }

  // For each perTenant bundle, find at least one wire whose `to` matches
  // AND whose `binding` is in dispatchedBindings.
  for (const b of perTenantBundles) {
    const incomingWires = wires.filter((w) => w.to === b.name);
    const matchingWire  = incomingWires.find((w) => dispatchedBindings.has(w.binding));
    if (!matchingWire) {
      const tenantBindingsList = Array.from(dispatchedBindings).sort().join(", ");
      const incomingBindingsList = incomingWires.map((w) => w.binding).sort().join(", ") || "(none)";
      violations.push(
        `lint-bundle-isolation: perTenant=true bundle "${b.name}" has no [[wires]] ` +
        `entry whose binding is referenced by any tenantDispatch row — Inv 9, ADR-0034 / cloister-cedcf3. ` +
        `tenantDispatch bindings: [${tenantBindingsList}]; incoming wire bindings on this bundle: [${incomingBindingsList}]. ` +
        `Either point a tenantDispatch row's binding at one of the incoming wires, or add a wire ` +
        `to this bundle with binding matching a tenantDispatch row.`,
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

// ADR-0038 (Inv 10): load each input's self-declared oci image from the
// lockfile (resolve-inputs records packages[].oci there). CLOISTER_LOCKFILE
// overrides the path (test fixtures). Missing/unreadable lockfile → empty
// map → Inv 10 treats every image-less external bundle as un-derivable.
function loadOciByInput() {
  const map = new Map();
  const lockfile = process.env.CLOISTER_LOCKFILE ?? resolve(REPO, "cluster.lock.toml");
  if (!existsSync(lockfile)) return map;
  try {
    const lock = parseToml(readFileSync(lockfile, "utf8"));
    for (const [name, row] of Object.entries(lock.inputs ?? {})) {
      if (row && typeof row === "object" && row.oci && row.oci.identifier) {
        map.set(name, row.oci);
      }
    }
  } catch {
    // Warn-level invariant: a bad lockfile never fails the substrate lint.
  }
  return map;
}

/**
 * Inv 10 (ADR-0038, WARN-level) — an external bundle should have a
 * resolvable container image: a non-empty operator `ext.image`, OR a linked
 * input whose server.json declares a packages[].oci (recorded in
 * cluster.lock.toml). Neither → warn. Fail-loud, NOT fail-closed: an
 * operator mid-migration who dropped the hand-set image before the producer
 * ships its oci is legitimate, so this must never block.
 */
function checkInvariant10(cluster, ociByInput, warnings) {
  // bundle name → linked input names, using the same three-rung tenancy
  // resolution as emit-compose. If tenancy has violations, Inv 6 reports
  // them; Inv 10 remains warn-level and uses the valid partial colocation.
  const { colocation: inputsByBundle } = resolveTenancy(cluster);
  for (const b of cluster.bundles ?? []) {
    if (!("external" in b.kind)) continue;
    const linked = inputsByBundle.get(b.name) ?? [];

    // Colocation means "this bundle ROUTES this input", not "this bundle IS
    // this input's container" — and the agreement check below is only
    // meaningful for the second relationship.
    //
    // The first draft conflated them and produced a false positive on
    // `cloister-router`: it hand-sets `cloister:0.1.0` (correctly — it is
    // cloister's own router) and has llo + canonical-hours colocated, so the
    // check demanded its image be ley-line-open's. That is the same shape as
    // the line-anchored TOML regex that produced four phantom binding-parity
    // violations: a relation read one rung too loosely.
    //
    // The discriminator is the repo's own convention, which mache and rosary
    // both follow: a bundle that IS an input's container carries that input's
    // NAME. A router does not.
    //
    // The two halves of Inv 10 need DIFFERENT relations, and conflating them
    // broke a passing test ("image-less gateway bundle can derive oci from
    // fallback-colocated input"):
    //
    //   DERIVABILITY (no image set) — ANY linked input with an oci will do.
    //     An image-less gateway legitimately derives from a fallback-colocated
    //     input that does not share its name. Narrowing this to same-name made
    //     a derivable bundle report as un-derivable.
    //   AGREEMENT (image set) — ONLY the same-name input. Anything looser asks
    //     a router to claim the image of something it merely routes.
    const derivableOci = linked.map((n) => ociByInput.get(n)).find((o) => o?.identifier);
    const ownInput = linked.find((n) => n === b.name);
    const ownOci = ownInput ? ociByInput.get(ownInput) : undefined;

    if (b.kind.external.image) {
      // The operator hand-set an image. This USED TO `continue` — so setting the
      // field was what turned the invariant OFF, and the one bundle that
      // restated an image by hand was the only one nothing checked.
      //
      // cloister-cb735c measured it: rosary's bundle carried
      // `image = "rosary:0.7.0"` while the lockfile had already resolved
      // ghcr.io/agentic-research/rosary:0.8.1 to a digest, and rosary's real
      // version was 0.10.0 — three disagreeing numbers for one upstream, none
      // reported. mache passes cleanly for the opposite reason: it declares NO
      // image, so ADR-0038 derives it and there is nothing to drift.
      //
      // A hand-set image is still legitimate — a locally-built bundle
      // (`cloister:0.1.0`, `notme:0.1.0`) has no registry to derive from, and no
      // linked input resolves an oci for it. What is NOT legitimate is
      // restating an image the substrate ALREADY resolved, differently.
      if (!ownOci) continue;

      const declared = b.kind.external.image;
      // Compare on identifier+tag, ignoring any digest the operator pinned:
      // `identifier:version` is what emit-compose derives, and a digest the
      // operator added themselves is strictly more pinned, not a disagreement.
      const expected = `${ownOci.identifier}:${ownOci.version}`;
      const declaredNoDigest = declared.split("@")[0];
      if (declaredNoDigest !== expected) {
        warnings.push(
          `bundle "${b.name}" (external) hand-sets image "${declared}" but its linked ` +
          `input (${linked.join(", ")}) already resolved "${expected}"` +
          `${ownOci.digest ? ` @ ${ownOci.digest.slice(0, 19)}…` : ""}. ` +
          `Two statements of one fact, and only the resolved one tracks the ` +
          `upstream. DELETE the image line so ADR-0038 derives it — that is why ` +
          `mache has nothing to drift (Inv 10, ADR-0038, cloister-cb735c).`,
        );
      }
      continue;
    }

    if (!derivableOci) {
      warnings.push(
        `bundle "${b.name}" (external) has no image — no operator ext.image and no ` +
        `packages[].oci from a linked input (${linked.join(", ") || "none"}). Set image in ` +
        `cluster.toml or add an oci package to the input's server.json (Inv 10, ADR-0038).`,
      );
    }
  }
}

/**
 * Inv 11 (cloister-a34edc, cloister/confinement/v1) — a declared confinement
 * facet must be valid + fail-closed. The four dimensions are allow-lists with no
 * "unrestricted" escape hatch (fail-closed by construction), so this enforces the
 * §2-4 validity constraints a malformed/over-broad declaration would break:
 *   §2 fs.allow  — absolute canonical path prefixes; mode "" (ro) | "rw".
 *   §3 allowHosts — wildcard only as a leading "*.".
 *   §4 port.bind — 0 (no listener) or 1024-65535 (privileged ports out of scope).
 * The empty deny-all default (no entries) passes trivially.
 */
function checkInvariant11(cluster, violations) {
  for (const b of cluster.bundles ?? []) {
    const c = b.confinement;
    if (!c || typeof c !== "object") continue;
    const where = `bundle "${b.name}" confinement`;
    for (const e of c.fs?.allow ?? []) {
      const path = typeof e === "string" ? e : e?.path;
      const mode = typeof e === "string" ? "" : (e?.mode ?? "");
      if (!isCanonicalAbsolutePath(path)) {
        violations.push(
          `${where}: fs.allow ${JSON.stringify(path)} is not an absolute canonical ` +
            `prefix (Inv 11, confinement/v1 §2).`,
        );
      }
      if (mode !== "" && mode !== "rw") {
        violations.push(
          `${where}: fs.allow mode ${JSON.stringify(mode)} invalid — only "" (ro) or ` +
            `"rw" (Inv 11, §2).`,
        );
      }
    }
    for (const h of c.network?.allowHosts ?? []) {
      if (typeof h === "string" && h.includes("*") && !h.startsWith("*.")) {
        violations.push(
          `${where}: network.allowHosts ${JSON.stringify(h)} — a wildcard is only ` +
            `permitted as a leading "*." (Inv 11, §3).`,
        );
      }
    }
    const bind = c.port?.bind ?? 0;
    if (bind !== 0 && (bind < 1024 || bind > 65535)) {
      violations.push(
        `${where}: port.bind ${bind} out of range — 0 (none) or 1024-65535 (Inv 11, §4).`,
      );
    }
  }
}

/**
 * Invariant 12 (cloister-f9d473) — every Durable Object binding declared
 * on a bundle's Worker MUST resolve to a declared `durableObjectNamespaces`
 * entry. `durableObjectNamespaces` is a hardcoded list the HOST (cloister)
 * maintains in config.capnp on behalf of every bundle that binds a Durable
 * Object — but until this rail, nothing checked that a binding naming a DO
 * class actually had that class declared anywhere. Grep for `durableObject`
 * in this file used to return nothing; the chain `tenantDispatch
 * row.binding → wire → bundle ← input.workerdId` (Inv 6-9) was enforced,
 * but the parallel chain `bundle DO binding → durableObjectNamespaces
 * entry` was not. A binding whose class isn't declared resolves at
 * config-eval time (capnp doesn't cross-check this) but fails — or
 * behaves unexpectedly — at request time, long after the manifest was
 * reviewed and merged.
 *
 * The deeper reason this class of bug recurs: a host hardcoding a guest's
 * namespace list is the host GUESSING what the guest is. A guest that
 * declares its own namespaces can be checked at manifest-review time; a
 * host's guess about a guest's shape can only be discovered wrong at
 * runtime — the same shape as ADR-0056's "a value that doesn't declare
 * what it is, and a consumer that proceeds on a silently-substituted
 * default." This rail doesn't change the hardcoded-list architecture
 * (that's a separate, undecided design question — see cloister-f9d473);
 * it only makes the existing chain checkable instead of merely assumed.
 *
 * Resolution: for each `durableObjectNamespace` binding on a Worker, the
 * designator's `className` must appear in that SAME Worker's
 * `durableObjectNamespaces[]` — UNLESS the designator names a cross-
 * worker `serviceName` (workerd's discouraged-but-legal escape hatch),
 * in which case the className must be declared on the NAMED Worker
 * instead. A `serviceName` that doesn't resolve to any Worker in
 * config.capnp is itself a violation — an unresolvable cross-worker
 * reference is exactly the "guess that can only be discovered wrong at
 * runtime" this rail exists to catch.
 */
/**
 * Inv 13 (ADR-0048, cloister-54b834) — every external bundle declares an
 * `executionMode`, and it is one the host runtime implements.
 *
 * The sandbox is one of ADR-0048's four tool facets, and the ADR's whole point
 * is that a facet must be declared INSIDE the boundary rather than left
 * ambient. Four of five bundles left it ambient: only mache said `microvm`.
 *
 * Left ambient it is not merely undocumented — it is a deferred hard failure.
 * `scripts/emit-host-launch-plan.mjs` REQUIRES "microvm" or "process" and
 * throws otherwise, so `task runtime:plan -- <bundle>` could not emit a plan
 * for any of the four, and nothing said so until someone tried. This is the
 * same shape as Inv 10 before cloister-cb735c: the check existed downstream,
 * and no gate reached it.
 *
 * FAIL-level, not warn. Unlike Inv 10 — where an operator mid-migration who
 * dropped a hand-set image before the producer ships its oci is legitimate —
 * there is no legitimate in-between state here. A bundle either runs in a
 * microVM or as a process; "unstated" is not a third option, it is just the
 * answer being kept out of the manifest.
 */
function checkInvariant13(cluster, violations) {
  // Kept in step with emit-host-launch-plan.mjs, which is the consumer that
  // actually enforces these two values at launch. A third mode added there
  // must be added here, or this rail starts rejecting a mode the runtime
  // accepts.
  const MODES = ["microvm", "process"];
  for (const b of cluster.bundles ?? []) {
    if (!("external" in b.kind)) continue;
    const mode = b.kind.external.executionMode;
    if (!mode) {
      violations.push(
        `bundle "${b.name}" (external) declares no executionMode. ADR-0048 makes the ` +
        `sandbox a facet that must be declared, not inferred — and ` +
        `emit-host-launch-plan refuses to launch without it, so leaving it unset ` +
        `defers the failure to \`task runtime:plan\` instead of reporting it here ` +
        `(Inv 13, cloister-54b834).`,
      );
    } else if (!MODES.includes(mode)) {
      violations.push(
        `bundle "${b.name}" (external) declares executionMode "${mode}", which the host ` +
        `runtime does not implement — it selects exactly and never substitutes a weaker ` +
        `backend. Expected one of: ${MODES.join(", ")} (Inv 13).`,
      );
    }
  }
}

function checkInvariant12(workerSvc, bundleName, config, violations) {
  const workersByName = new Map(workersIn(config).map((w) => [w.name, w]));
  const bundleLabel = bundleName ? `"${bundleName}"` : "(unmapped)";
  for (const b of bindingsOf(workerSvc)) {
    if (!b.durableObjectNamespace) continue;
    const desig = b.durableObjectNamespace;
    const className = typeof desig === "string" ? desig : desig.className;
    const serviceName = typeof desig === "string" ? undefined : desig.serviceName;

    let targetWorker = workerSvc;
    let targetLabel = workerSvc.name;
    if (serviceName) {
      const found = workersByName.get(serviceName);
      if (!found) {
        violations.push(
          `lint-bundle-isolation: Worker "${workerSvc.name}" (bundle ${bundleLabel}) has ` +
          `durableObjectNamespace binding "${b.name}" naming cross-worker serviceName ` +
          `"${serviceName}", but no Worker of that name exists in config.capnp — Inv 12, ` +
          `cloister-f9d473. Either fix the serviceName typo or declare a \`( name = ` +
          `"${serviceName}", worker = ... )\` service entry.`,
        );
        continue;
      }
      targetWorker = found;
      targetLabel = serviceName;
    }

    const namespaces = targetWorker.worker?.durableObjectNamespaces ?? [];
    const declared = namespaces.some((ns) => ns.className === className);
    if (!declared) {
      violations.push(
        `lint-bundle-isolation: Worker "${workerSvc.name}" (bundle ${bundleLabel}) has binding ` +
        `"${b.name}" naming durable object class "${className}", but Worker "${targetLabel}" ` +
        `has no matching durableObjectNamespaces entry — Inv 12, cloister-f9d473. The bundle ` +
        `DO binding → durableObjectNamespaces chain is broken. Add \`( className = ` +
        `"${className}", uniqueKey = "...", enableSql = true )\` to "${targetLabel}"'s ` +
        `durableObjectNamespaces in config.capnp, or remove the binding if the class is unused.`,
      );
    }
  }
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
checkInvariant6(cluster, violations);
checkInvariant7(cluster, violations);
checkInvariant8(cluster, violations);
checkInvariant9(cluster, violations);
checkInvariant10(cluster, loadOciByInput(), warnings);
checkInvariant11(cluster, violations);
checkInvariant13(cluster, violations);

const services = config.services ?? [];
for (const wsvc of workersIn(config)) {
  const { tier, bundleName } = tierForWorker(wsvc.name, cluster, serviceToBundle, warnings);
  checkInvariant1(wsvc, tier, services, violations);
  checkInvariant2(wsvc, bundleName, credentialAllowList, violations);
  checkInvariant4(wsvc, tier, bundleName, cluster, services, violations);
  checkInvariant5(wsvc, tier, bundleName, cluster, services, serviceToBundle, violations);
  checkInvariant12(wsvc, bundleName, config, violations);
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
const inputCount = (cluster.inputs ?? []).length;
console.log(`  ${inputCount} input(s) walked for tenancy resolution`);
const tenantDispatchCount = (cluster.routes ?? []).filter((r) => r.kind?.tenantDispatch).length;
console.log(`  ${tenantDispatchCount} tenantDispatch route(s) walked for Inv 7`);
const perTenantCount = (cluster.bundles ?? []).filter((b) => b.perTenant === true).length;
console.log(`  ${perTenantCount} perTenant bundle(s) walked for Inv 8 + Inv 9`);
const imagelessExternal = (cluster.bundles ?? []).filter(
  (b) => "external" in b.kind && !b.kind.external.image,
).length;
console.log(`  ${imagelessExternal} image-less external bundle(s) checked for Inv 10 (ADR-0038 oci derivation)`);
const doBindingCount = workersIn(config).reduce(
  (n, w) => n + bindingsOf(w).filter((b) => b.durableObjectNamespace).length,
  0,
);
console.log(`  ${doBindingCount} durableObjectNamespace binding(s) checked for Inv 12 (cloister-f9d473)`);
console.log(`  invariants 1–13 hold (ADR-0013 sandbox + ADR-0030 §A5 tenancy + ADR-0034 dispatch alignment + perTenant routing/wiring + ADR-0038 image derivation + confinement/v1 §2-4 validity + DO-namespace resolution + ADR-0048 executionMode declared)`);
