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
