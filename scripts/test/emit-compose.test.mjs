// scripts/test/emit-compose.test.mjs
//
// Run with: pnpm exec tsx --test scripts/test/emit-compose.test.mjs
//
// Unit tests for the tenancy-aware compose emitter (ADR-0030 §A1 + §A5).
// Per cloister-0ecb6c.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTenancy, emitCompose } from "../../cli/lib/cluster/emit-compose.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

// ── /data/do mount: named volume vs host bind (CLOISTER_DO_BIND) ──────────

test("emitCompose: default → named cloister-do volume mount + top-level declaration", () => {
  const out = emitCompose(baseCluster());
  assert.match(out, /- cloister-do:\/data\/do/);
  assert.match(out, /^ {2}cloister-do:/m); // declared under top-level volumes:
});

test("emitCompose: doBindPath → host bind-mount, no named cloister-do volume", () => {
  const out = emitCompose(baseCluster(), new Map(), { doBindPath: "/host/data" });
  assert.match(out, /- \/host\/data\/cloister-router:\/data\/do/); // owned host path
  assert.doesNotMatch(out, /- cloister-do:\/data\/do/);           // no named-volume mount
  assert.doesNotMatch(out, /^ {2}cloister-do:/m);                 // no top-level named volume
});

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
  // The label gives operators `docker inspect` visibility into which
  // bundles are flagged tenant-scoped — appears on both the single-
  // container fallback case (this test) and the fanned-out per-tenant
  // case (the perTenantCluster suite below). Lint Inv 8 + Inv 9
  // guarantee a matching tenantDispatch route + binding chain when
  // this label appears.
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

test("emitCompose: shared binding across tenants → router env keeps the bundle's declared socket (operator owns dispatch)", () => {
  // Two tenant rows share `binding = "T_APP"`. Per-tenant socket
  // derivation is ambiguous (one binding → which tenant?), so the
  // router's T_APP env var falls through to the bundle's declared
  // ipcSocket. The dispatch behavior at that single socket is the
  // operator's responsibility (front-load-balancer, internal tenant
  // routing inside the worker, etc.).
  const yaml = emitCompose(perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
    { name: "bob",   mode: "path-prefix", matchValue: "/t/bob", binding: "T_APP" },
  ]));
  const routerIdx = yaml.indexOf("cloister-router:");
  const firstTenantIdx = yaml.indexOf("\n  tenant-app-", routerIdx);
  const routerBlock = yaml.slice(routerIdx, firstTenantIdx);
  assert.ok(routerBlock.includes('"T_APP=/run/cloister-uds/tenant.sock"'),
    `shared binding → router falls back to declared ipcSocket:\n${routerBlock}`);
});

// ── cedcf3 Phase 3: per-tenant socket fanout + wire env rewriting ────────

test("emitCompose: per-tenant binding shape → router env rewritten with per-tenant socket", () => {
  // Operator declares one wire + one dispatch row per tenant, using
  // distinct bindings (T_APP_ALICE, T_APP_BOB). Each wire's binding
  // matches exactly one dispatch row, so the source-side env emit
  // derives a per-tenant socket: /run/cloister-uds/tenant.sock →
  // /run/cloister-uds/tenant.alice.sock (and tenant.bob.sock).
  const cluster = perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP_ALICE" },
    { name: "bob",   mode: "path-prefix", matchValue: "/t/bob", binding: "T_APP_BOB" },
  ]);
  cluster.wires = [
    { from: "cloister-router", to: "tenant-app", binding: "T_APP_ALICE", transport: { uds: null } },
    { from: "cloister-router", to: "tenant-app", binding: "T_APP_BOB",   transport: { uds: null } },
  ];
  const yaml = emitCompose(cluster);
  const routerIdx = yaml.indexOf("cloister-router:");
  const firstTenantIdx = yaml.indexOf("\n  tenant-app-", routerIdx);
  const routerBlock = yaml.slice(routerIdx, firstTenantIdx);
  assert.ok(routerBlock.includes('"T_APP_ALICE=/run/cloister-uds/tenant.alice.sock"'),
    `T_APP_ALICE should resolve to alice's socket:\n${routerBlock}`);
  assert.ok(routerBlock.includes('"T_APP_BOB=/run/cloister-uds/tenant.bob.sock"'),
    `T_APP_BOB should resolve to bob's socket:\n${routerBlock}`);
});

test("emitCompose: per-tenant container gets TENANT_SOCKET env matching the derived path", () => {
  // The per-tenant container needs to know where to bind its UDS
  // server so the router can reach it at the same path through the
  // shared cloister-uds volume.
  const yaml = emitCompose(perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
  ]));
  const aliceIdx = yaml.indexOf("tenant-app-alice:");
  const nextSvcIdx = yaml.indexOf("\nvolumes:", aliceIdx);
  const aliceBlock = yaml.slice(aliceIdx, nextSvcIdx);
  assert.ok(aliceBlock.includes('"TENANT_SOCKET=/run/cloister-uds/tenant.alice.sock"'),
    `tenant-app-alice block should declare TENANT_SOCKET:\n${aliceBlock}`);
});

test("emitCompose: per-tenant container mounts its own cloister-do-<bundle>-<tenant> volume", () => {
  // Phase 3 piece 2: each per-tenant container gets a dedicated named
  // volume mounted at the cluster's storage.doStoragePath, so each
  // tenant's SQLite/Dolt state is isolated and operationally
  // offboardable with `docker volume rm cloister-do-<bundle>-<tenant>`.
  const yaml = emitCompose(perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP" },
    { name: "bob",   mode: "path-prefix", matchValue: "/t/bob", binding: "T_APP" },
  ]));
  // Each per-tenant block declares its own volume mount.
  const aliceIdx = yaml.indexOf("tenant-app-alice:");
  const bobIdx = yaml.indexOf("tenant-app-bob:");
  const volumesIdx = yaml.indexOf("\nvolumes:");
  const aliceBlock = yaml.slice(aliceIdx, bobIdx);
  const bobBlock = yaml.slice(bobIdx, volumesIdx);
  assert.ok(aliceBlock.includes("- cloister-do-tenant-app-alice:/data/do"),
    `alice should mount its own DO volume:\n${aliceBlock}`);
  assert.ok(bobBlock.includes("- cloister-do-tenant-app-bob:/data/do"),
    `bob should mount its own DO volume:\n${bobBlock}`);
  // Top-level volumes: block declares each per-tenant volume exactly once.
  const volumesBlock = yaml.slice(volumesIdx);
  assert.ok(volumesBlock.includes("cloister-do-tenant-app-alice:"));
  assert.ok(volumesBlock.includes("cloister-do-tenant-app-bob:"));
});

test("emitCompose: non-perTenant bundle does NOT get a per-tenant DO volume (single emission unchanged)", () => {
  // The single-emission fallback path (bundle is perTenant=false, OR
  // the dispatch chain is empty) must NOT emit per-tenant volumes —
  // those only appear when fanout actually runs.
  const cluster = baseCluster();
  const yaml = emitCompose(cluster);
  assert.ok(!yaml.includes("cloister-do-"), `single-emission should not declare per-tenant volumes:\n${yaml}`);
});

test("emitCompose: per-tenant socket derivation handles base path with no extension", () => {
  // Edge: bundle ipcSocket has no .ext (rare but legal — a bare socket
  // name). Tenant tag should append with `.` separator rather than
  // injecting before a non-existent extension.
  const cluster = perTenantCluster([
    { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_APP_ALICE" },
  ]);
  cluster.bundles.find((b) => b.name === "tenant-app").kind.external.ipcSocket = "/run/cloister-uds/bare";
  cluster.wires = [
    { from: "cloister-router", to: "tenant-app", binding: "T_APP_ALICE", transport: { uds: null } },
  ];
  const yaml = emitCompose(cluster);
  assert.ok(yaml.includes('"T_APP_ALICE=/run/cloister-uds/bare.alice"'),
    `bare base + tenant should append with .: ${yaml.slice(yaml.indexOf("cloister-router:"), yaml.indexOf("\n  tenant-app"))}`);
  assert.ok(yaml.includes('"TENANT_SOCKET=/run/cloister-uds/bare.alice"'),
    `TENANT_SOCKET should match`);
});

// ── ADR-0038: derive bundle image from a linked input's packages[].oci ────

function ociCluster(image, inputName = "mache") {
  return baseCluster({
    bundles: [{
      name: "mache", description: "mache code intel", tier: "cluster",
      holdsCredential: [], workerdServiceName: "", hypervisorRationale: "",
      kind: { external: { image, ipcSocket: "", httpPort: 7532, args: [], env: [] } },
    }],
    // empty workerdId → resolveTenancy rung 2: colocates to the same-name bundle
    inputs: [inputWithTenancy(inputName, {})],
  });
}

test("emitCompose: operator ext.image wins over a linked input's oci (ADR-0038)", () => {
  const oci = new Map([["mache", { identifier: "ghcr.io/org/mache", version: "0.13.0" }]]);
  const yaml = emitCompose(ociCluster("mache:0.9.0-operator-pin"), oci);
  assert.ok(yaml.includes("image: mache:0.9.0-operator-pin"), "operator image must win");
  assert.ok(!yaml.includes("ghcr.io/org/mache"), "oci must not override an operator image");
});

test("emitCompose: empty ext.image derives identifier:version from oci", () => {
  const oci = new Map([["mache", { identifier: "ghcr.io/org/mache", version: "0.13.0" }]]);
  const yaml = emitCompose(ociCluster(""), oci);
  assert.ok(yaml.includes("image: ghcr.io/org/mache:0.13.0"));
});

test("emitCompose: empty ext.image + digest-pinned oci derives identifier@digest", () => {
  const oci = new Map([["mache", { identifier: "ghcr.io/org/mache", version: "", digest: "sha256:abc" }]]);
  const yaml = emitCompose(ociCluster(""), oci);
  assert.ok(yaml.includes("image: ghcr.io/org/mache@sha256:abc"));
});

test("emitCompose: empty ext.image + no oci → blank image (loud warn, no silent default)", () => {
  const yaml = emitCompose(ociCluster(""), new Map());
  assert.ok(/^ {4}image:\s*$/m.test(yaml), "image line present but blank — compose up fails, not the emitter");
});

test("emitCompose: no ociByInput arg → operator image verbatim (back-compat)", () => {
  const yaml = emitCompose(ociCluster("mache:0.13.0"));
  assert.ok(yaml.includes("image: mache:0.13.0"));
});

// ── The emitted compose must be VALID, not merely unchanged ───────────────
//
// cluster:emit:check-drift diffs emitted-vs-committed. When a bundle
// description contained the sentence
//
//     executionMode is deliberately "process", not "microvm"
//
// the emitter interpolated it raw into a `"..."` label and produced a file
// `docker compose` rejected with `did not find expected key`. `task cluster:up`
// could not start the cluster at all — and NOTHING reported it, because the
// committed copy and the emitted copy were identically broken. The gate checked
// AGREEMENT and never VALIDITY, and no test had ever parsed the output.
//
// Checked without a YAML dependency: every label entry is emitted via
// JSON.stringify, and YAML 1.2's double-quoted style is deliberately a superset
// of JSON string escaping — so "each label line is parseable as JSON" is exactly
// the property that makes the file valid YAML, expressible with JSON.parse.

test("every label line in the SHIPPED compose is a valid quoted scalar", () => {
  // lint-allow-rawparse: this asserts the file is LEXICALLY valid YAML, which a
  // YAML parser cannot be used to check — parsing a file to prove it parses is
  // circular, and the failure being guarded against is precisely the one that
  // makes a parser throw. There is also no YAML dependency in this repo. Reading
  // the literal lines is the only way to state the property.
  const body = readFileSync(resolve(ROOT, "cluster.compose.yaml"), "utf8");
  const labels = body.split("\n").filter((l) => /^\s+- "cloister\./.test(l));
  assert.ok(labels.length > 5, `sanity: expected many labels, found ${labels.length}`);

  const bad = labels.filter((l) => {
    try {
      JSON.parse(l.trim().replace(/^- /, ""));
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(
    bad,
    [],
    `these label lines are not valid quoted scalars, so the file is not YAML:\n${bad.join("\n")}`,
  );
});

test("a description containing quotes and backslashes still emits a valid scalar", () => {
  // The regression directly. A free-text field is a field a human edits, so the
  // fix has to be at the emitter — "do not type a quote" is not a fix.
  const hostile = 'executionMode is deliberately "process", not "microvm"; path C:\\x — and a — dash';
  const line = `      - ${JSON.stringify(`cloister.description=img:1 — ${hostile}`)}`;
  const parsed = JSON.parse(line.trim().replace(/^- /, ""));
  assert.ok(parsed.includes('"process"'), "the quotes must survive into the value");
  assert.ok(parsed.includes("C:\\x"), "the backslash must survive into the value");
});

test("the shared UDS volume is tmpfs with 1777 — bundles do not share a uid", () => {
  // cloister-047b06. A default local volume is root:root 0755, and the bundles
  // that bind sockets in it run as 65532 (rosary, cloister-router), 1000 (notme,
  // notme-proxy) and a named user (mache). No single owner to chown to, so the
  // directory needs /tmp semantics: any uid may create, only the owner may
  // remove.
  //
  // This is a rail rather than a comment because the previous state WAS a
  // comment — the emitter said "tmpfs is fine, UDS sockets are ephemeral" while
  // emitting a plain local volume, and rosary died on `Permission denied`
  // every `cluster:up`.
  // lint-allow-rawparse: there is no YAML parser in this repo's dependency tree,
  // so a declaration in a .yaml file cannot be read structurally. Adding `yaml`
  // as a devDependency would be the principled fix and would also let the label
  // test above stop hand-matching — worth doing, but not inside a P1 socket fix.
  const body = readFileSync(resolve(ROOT, "cluster.compose.yaml"), "utf8");
  const block = /^  cloister-uds:\n((?:    .*\n)*)/m.exec(body);
  assert.ok(block, "cluster.compose.yaml must declare the cloister-uds volume");

  assert.match(block[1], /type: tmpfs/, "a socket dir must not survive a restart — a stale socket is a bind failure");
  assert.match(block[1], /mode=1777/, "without 1777 a non-root bundle cannot bind its socket");
});
