// scripts/test/emit-compose.test.mjs
//
// Run with: pnpm exec tsx --test scripts/test/emit-compose.test.mjs
//
// Unit tests for the tenancy-aware compose emitter (ADR-0030 §A1 + §A5).
// Per cloister-0ecb6c.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { resolveTenancy, emitCompose } from "../emit-compose.mjs";

// ── Test fixtures ────────────────────────────────────────────────────────

/**
 * Minimal cluster shape — one external bundle, no inputs. Lets each
 * test add its own complexity without each fixture restating the
 * boilerplate.
 */
function baseCluster(overrides = {}) {
  return {
    metadata: { name: "test", version: "0.0.1" },
    bundles: [
      {
        name: "cloister-router",
        description: "Test router",
        tier: "hypervisor",
        holdsCredential: [],
        workerdServiceName: "cloister",
        hypervisorRationale: "test",
        kind: {
          external: {
            image: "cloister:0.1",
            ipcSocket: "/run/cloister-uds/router.sock",
            httpPort: 8787,
            args: [],
            env: [],
          },
        },
      },
    ],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: {
      metadata: { name: "", version: "" },
      actor: { fingerprint: "", algorithm: "", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
      policy: { maxCertLifetimeSeconds: 0, requireInterlock: false, minAlgorithm: "" },
    },
    edges: [],
    ...overrides,
  };
}

function inputWithTenancy(name, tenancy = {}) {
  return {
    name,
    ref: `github://test/${name}@main`,
    version: "^0.1",
    digest: "",
    from: "",
    provides: [],
    requires: [],
    urlBinding: "",
    serviceBinding: "",
    tenancy: {
      mode: "",
      workerdId: "",
      trustedTier: false,
      sharesWorkerdWith: [],
      ...tenancy,
    },
  };
}

// ── resolveTenancy: validation paths ─────────────────────────────────────

test("resolveTenancy: empty inputs → empty colocation + no violations", () => {
  const { colocation, violations } = resolveTenancy(baseCluster());
  assert.equal(colocation.size, 0);
  assert.deepEqual(violations, []);
});

test("resolveTenancy: input with explicit workerdId matching a bundle resolves cleanly", () => {
  const cluster = baseCluster({
    inputs: [inputWithTenancy("notme", { mode: "co-located", workerdId: "cloister-router" })],
  });
  const { colocation, violations } = resolveTenancy(cluster);
  assert.deepEqual(violations, []);
  assert.deepEqual([...colocation.entries()], [["cloister-router", ["notme"]]]);
});

test("resolveTenancy: empty workerdId falls back to input.name (when a bundle of that name exists)", () => {
  const cluster = baseCluster({
    bundles: [
      ...baseCluster().bundles,
      {
        name: "mache",
        description: "Mache",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        kind: { external: { image: "mache:0.8", ipcSocket: "", httpPort: 0, args: [], env: [] } },
      },
    ],
    inputs: [inputWithTenancy("mache", { mode: "external" })],
  });
  const { colocation, violations } = resolveTenancy(cluster);
  assert.deepEqual(violations, []);
  assert.deepEqual([...colocation.entries()], [["mache", ["mache"]]]);
});

test("resolveTenancy: explicit workerdId pointing at NO bundle → violation", () => {
  const cluster = baseCluster({
    inputs: [inputWithTenancy("ghost", { workerdId: "phantom-workerd" })],
  });
  const { violations } = resolveTenancy(cluster);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].input, "ghost");
  assert.equal(violations[0].declaredWorkerdId, "phantom-workerd");
  assert.equal(violations[0].resolvedWorkerdId, "phantom-workerd");
  assert.ok(violations[0].problem.includes("does not match any bundle name"));
});

test("resolveTenancy: empty workerdId + input.name has no matching bundle → fall back to gateway (back-compat)", () => {
  // The baseCluster has one hypervisor-tier bundle (cloister-router).
  // An input without explicit tenancy + no same-name bundle falls back
  // to the gateway. This preserves pre-ADR-0030 behavior: inputs that
  // didn't declare tenancy composed into the router implicitly.
  const cluster = baseCluster({
    inputs: [inputWithTenancy("orphan", {})],
  });
  const { colocation, violations } = resolveTenancy(cluster);
  assert.deepEqual(violations, []);
  assert.deepEqual([...colocation.entries()], [["cloister-router", ["orphan"]]]);
});

test("resolveTenancy: empty workerdId + no gateway + no same-name bundle → violation", () => {
  // A cluster with no hypervisor-tier bundle has nowhere for an orphan
  // input to land. Real operator misconfig.
  const cluster = {
    ...baseCluster(),
    bundles: [
      {
        name: "tool-only",
        description: "no gateway here",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        kind: { external: { image: "x:0.1", ipcSocket: "", httpPort: 0, args: [], env: [] } },
      },
    ],
    inputs: [inputWithTenancy("orphan", {})],
  };
  const { violations } = resolveTenancy(cluster);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].problem.includes("no bundle hosts this input"));
});

test("resolveTenancy: multiple inputs sharing a workerdId co-locate under it", () => {
  const cluster = baseCluster({
    inputs: [
      inputWithTenancy("notme", { mode: "co-located", workerdId: "cloister-router" }),
      inputWithTenancy("identity-bridge", { mode: "co-located", workerdId: "cloister-router" }),
    ],
  });
  const { colocation, violations } = resolveTenancy(cluster);
  assert.deepEqual(violations, []);
  assert.deepEqual(colocation.get("cloister-router"), ["notme", "identity-bridge"]);
});

// ── emitCompose: throws on tenancy violations ────────────────────────────

test("emitCompose: throws when an input's workerdId doesn't resolve", () => {
  const cluster = baseCluster({
    inputs: [inputWithTenancy("ghost", { workerdId: "phantom-workerd" })],
  });
  assert.throws(
    () => emitCompose(cluster),
    /tenancy violation.*phantom-workerd/s,
  );
});

// ── emitCompose: YAML shape — current invariants ─────────────────────────

test("emitCompose: emits one service per external bundle", () => {
  const cluster = baseCluster();
  const yaml = emitCompose(cluster);
  assert.ok(yaml.includes("name: test"));
  assert.ok(yaml.includes("services:"));
  assert.ok(yaml.includes("  cloister-router:"));
  assert.ok(yaml.includes("    image: cloister:0.1"));
  assert.ok(yaml.includes("    container_name: cloister-cloister-router"));
});

test("emitCompose: workerd-bundle kind does NOT emit a compose service (in-process)", () => {
  const cluster = baseCluster({
    bundles: [
      ...baseCluster().bundles,
      {
        name: "tool-bundle",
        description: "In-process Worker",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        kind: { workerd: { entryPoint: "src/bundles/tool/index.ts" } },
      },
    ],
  });
  const yaml = emitCompose(cluster);
  assert.ok(!yaml.includes("  tool-bundle:"), "workerd-bundle should not emit a compose service");
});

test("emitCompose: emits volumes block + named cloister-uds + cloister-do volumes", () => {
  const yaml = emitCompose(baseCluster());
  assert.ok(yaml.includes("volumes:"));
  assert.ok(yaml.includes("  cloister-uds:"));
  assert.ok(yaml.includes("  cloister-do:"));
});

// ── emitCompose: ADR-0030 §A5 — co-location labels ───────────────────────

test("emitCompose: no inputs → no cloister.colocated-inputs label", () => {
  const yaml = emitCompose(baseCluster());
  assert.ok(!yaml.includes("cloister.colocated-inputs"));
});

test("emitCompose: single co-located input → emits one-name label", () => {
  const cluster = baseCluster({
    inputs: [inputWithTenancy("notme", { mode: "co-located", workerdId: "cloister-router" })],
  });
  const yaml = emitCompose(cluster);
  assert.ok(yaml.includes('"cloister.colocated-inputs=notme"'));
});

test("emitCompose: multiple co-located inputs → comma-joined label", () => {
  const cluster = baseCluster({
    inputs: [
      inputWithTenancy("notme", { mode: "co-located", workerdId: "cloister-router" }),
      inputWithTenancy("identity-bridge", { mode: "co-located", workerdId: "cloister-router" }),
    ],
  });
  const yaml = emitCompose(cluster);
  assert.ok(yaml.includes('"cloister.colocated-inputs=notme,identity-bridge"'));
});

test("emitCompose: co-located inputs only appear in the bundle they're declared under", () => {
  // Add a second bundle; assert notme's label only attaches to cloister-router.
  const cluster = baseCluster({
    bundles: [
      ...baseCluster().bundles,
      {
        name: "mache",
        description: "Mache",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        kind: { external: { image: "mache:0.8", ipcSocket: "", httpPort: 0, args: [], env: [] } },
      },
    ],
    inputs: [inputWithTenancy("notme", { mode: "co-located", workerdId: "cloister-router" })],
  });
  const yaml = emitCompose(cluster);
  // Find the mache block + assert no cloister.colocated-inputs in it.
  const macheStart = yaml.indexOf("  mache:");
  const macheEnd = yaml.indexOf("\n  ", macheStart + 1);
  const macheBlock = yaml.slice(macheStart, macheEnd === -1 ? undefined : macheEnd);
  assert.ok(!macheBlock.includes("cloister.colocated-inputs"));
});

// ── emitCompose: header comment carries input count when populated ───────

test("emitCompose: header omits input-count line when no inputs", () => {
  const yaml = emitCompose(baseCluster());
  assert.ok(!yaml.includes("tenancy resolved per ADR-0030"));
});

test("emitCompose: header includes input-count line when inputs declared", () => {
  const cluster = baseCluster({
    inputs: [inputWithTenancy("notme", { workerdId: "cloister-router" })],
  });
  const yaml = emitCompose(cluster);
  assert.ok(yaml.includes("1 input(s); tenancy resolved per ADR-0030 §A5"));
});

// ── Regression: pre-ADR-0030 single-tenant cluster.toml still emits ──────

test("regression: cluster with no inputs at all emits a valid compose body", () => {
  const cluster = baseCluster();
  const yaml = emitCompose(cluster);
  assert.ok(yaml.startsWith("# AUTO-GENERATED"));
  assert.ok(yaml.includes("services:"));
  assert.ok(yaml.includes("volumes:"));
  assert.ok(yaml.endsWith("\n"));
});

// ── cedcf3 Phase 2 prep: perTenant=true emits a label for operator visibility ──

test("emitCompose: bundle with perTenant=true emits cloister.per-tenant=true label", () => {
  // Phase 2 piece 2 (per-tenant container splitting) is deferred, but the
  // label gives operators `docker inspect` visibility into which bundles
  // are flagged tenant-scoped. Lint Inv 8 + Inv 9 already guarantee a
  // matching tenantDispatch route + binding chain when this appears.
  const cluster = baseCluster({
    bundles: [
      ...baseCluster().bundles,
      {
        name: "rosary",
        description: "Per-tenant bead orchestrator",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        perTenant: true,
        kind: {
          external: {
            image: "rosary:0.2.0",
            ipcSocket: "/run/cloister-uds/rosary.sock",
            httpPort: 0,
            args: [],
            env: [],
          },
        },
      },
    ],
  });
  const yaml = emitCompose(cluster);
  assert.ok(yaml.includes('"cloister.per-tenant=true"'),
    "perTenant=true bundle must emit cloister.per-tenant=true label");
  // The label appears under the rosary service block, NOT the
  // cloister-router block (which has no perTenant flag).
  const rosaryIdx  = yaml.indexOf("  rosary:");
  const routerIdx  = yaml.indexOf("  cloister-router:");
  const labelIdx   = yaml.indexOf("cloister.per-tenant=true");
  assert.ok(rosaryIdx >= 0);
  assert.ok(labelIdx > rosaryIdx, "label must appear AFTER the rosary service line");
  // And the router block (which precedes rosary) doesn't have it.
  const routerBlock = yaml.slice(routerIdx, rosaryIdx);
  assert.ok(!routerBlock.includes("cloister.per-tenant=true"),
    "cloister-router block (no perTenant flag) must NOT emit the label");
});

test("emitCompose: bundle without perTenant (or false) emits NO per-tenant label (back-compat)", () => {
  // Pre-cedcf3 cluster.toml: bundles have no perTenant field. Emitted
  // compose YAML stays unchanged — no spurious label.
  const yaml = emitCompose(baseCluster());
  assert.ok(!yaml.includes("cloister.per-tenant"));
});

// ── Output determinism (same input twice → same bytes) ───────────────────

test("emitCompose: deterministic — two emits produce byte-identical output", () => {
  const cluster = baseCluster({
    inputs: [
      inputWithTenancy("notme", { mode: "co-located", workerdId: "cloister-router" }),
    ],
  });
  const a = emitCompose(cluster);
  const b = emitCompose(cluster);
  assert.equal(a, b);
});

// ── perTenant fanout (cedcf3 Phase 2 piece 2) ────────────────────────────

/** Cluster fixture with one perTenant bundle + N tenantDispatch rows. */
function perTenantCluster(tenants) {
  return baseCluster({
    bundles: [
      {
        name: "cloister-router",
        description: "Router",
        tier: "hypervisor",
        holdsCredential: [],
        workerdServiceName: "cloister",
        hypervisorRationale: "test",
        perTenant: false,
        kind: { external: { image: "cloister:0.1", ipcSocket: "/run/cloister-uds/router.sock", httpPort: 8787, args: [], env: [] } },
      },
      {
        name: "tenant-app",
        description: "Per-tenant app",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        perTenant: true,
        kind: { external: { image: "cloister:0.1", ipcSocket: "/run/cloister-uds/tenant.sock", httpPort: 0, args: [], env: [] } },
      },
    ],
    wires: [
      { from: "cloister-router", to: "tenant-app", binding: "T_APP", transport: { uds: null } },
    ],
    routes: [
      {
        path: "/",
        kind: { tenantDispatch: { tenants } },
      },
    ],
  });
}

test("emitCompose: perTenant=true bundle fans out to one service per tenantDispatch row", () => {
  const yaml = emitCompose(perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
    { name: "bob",   mode: "path-prefix", matchValue: "/t/bob", binding: "T_APP" },
  ]));
  // Two service names derived from `<bundle>-<tenant>`.
  assert.match(yaml, /^ {2}tenant-app-alice:$/m);
  assert.match(yaml, /^ {2}tenant-app-bob:$/m);
  // The bare bundle name does NOT appear as a service.
  assert.doesNotMatch(yaml, /^ {2}tenant-app:$/m);
});

test("emitCompose: perTenant container names + labels + env", () => {
  const yaml = emitCompose(perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
  ]));
  assert.ok(yaml.includes("container_name: cloister-tenant-app-alice"));
  assert.ok(yaml.includes('"cloister.tenant=alice"'));
  assert.ok(yaml.includes('"cloister.dispatch-mode=sni"'));
  assert.ok(yaml.includes('"cloister.dispatch-match=alice.example"'));
  assert.ok(yaml.includes('"cloister.per-tenant=true"'));
  assert.ok(yaml.includes('"TENANT_ID=alice"'));
  assert.ok(yaml.includes('"TENANT_MODE=sni"'));
  assert.ok(yaml.includes('"TENANT_MATCH_VALUE=alice.example"'));
});

test("emitCompose: perTenant containers do NOT bind host ports (avoid collision)", () => {
  // Per-tenant instances must NOT each bind the same host port —
  // collision would prevent docker compose up. Operators add explicit
  // per-tenant ports via a compose overlay if they want TCP exposure.
  const withPort = perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
  ]);
  withPort.bundles.find((b) => b.name === "tenant-app").kind.external.httpPort = 9000;
  const yaml = emitCompose(withPort);
  const aliceIdx = yaml.indexOf("tenant-app-alice:");
  const nextSvcIdx = yaml.indexOf("\nvolumes:", aliceIdx);
  const aliceBlock = yaml.slice(aliceIdx, nextSvcIdx);
  assert.ok(!aliceBlock.includes("ports:"), `tenant-app-alice block should not have ports: \n${aliceBlock}`);
});

test("emitCompose: perTenant=true with no dispatch chain → falls back to single-emission", () => {
  // Lint Inv 8 + Inv 9 catch this case; the emitter falls back rather
  // than fail-late, so a perTenant=true bundle without matching tenant
  // rows still emits ONE container (the chain didn't resolve any
  // tenants to fan out over).
  const cluster = baseCluster({
    bundles: [
      {
        name: "cloister-router",
        description: "Router",
        tier: "hypervisor",
        holdsCredential: [],
        workerdServiceName: "cloister",
        hypervisorRationale: "test",
        perTenant: false,
        kind: { external: { image: "cloister:0.1", ipcSocket: "/run/cloister-uds/router.sock", httpPort: 8787, args: [], env: [] } },
      },
      {
        name: "orphan",
        description: "perTenant without dispatch",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        perTenant: true,
        kind: { external: { image: "cloister:0.1", ipcSocket: "/run/cloister-uds/orphan.sock", httpPort: 0, args: [], env: [] } },
      },
    ],
    wires: [],
    routes: [],
  });
  const yaml = emitCompose(cluster);
  assert.match(yaml, /^ {2}orphan:$/m);
  assert.ok(yaml.includes('"cloister.per-tenant=true"'));
  assert.ok(!yaml.includes("cloister.tenant="));
});

test("emitCompose: per-tenant containers preserve wire env vars on the source side", () => {
  // The router (wire source) still has its T_APP env var pointing at
  // the bundle's declared ipcSocket. The fact that tenant-app fans
  // out doesn't rewrite the wire on the source side — that's a known
  // Phase 2 piece 2 limitation; operators handle per-tenant socket
  // plumbing.
  const yaml = emitCompose(perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
  ]));
  const routerIdx = yaml.indexOf("cloister-router:");
  const nextIdx = yaml.indexOf("\n  tenant-app-alice:", routerIdx);
  const routerBlock = yaml.slice(routerIdx, nextIdx);
  assert.ok(routerBlock.includes('"T_APP=/run/cloister-uds/tenant.sock"'),
    `router block should keep T_APP wire env:\n${routerBlock}`);
});
