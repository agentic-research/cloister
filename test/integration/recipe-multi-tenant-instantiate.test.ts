/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// End-to-end pipeline test: recipes/multi-tenant-smoke/cluster.toml is
// the canonical operator-facing example of multi-tenancy. This test
// closes the gap between "the emitter writes valid capnp" (covered by
// `scripts/test/emit-cloister-capnp.test.mjs`) and "the resulting
// Gateway actually instantiates into the right route shape at runtime"
// — the missing rung of the validation ladder.
//
// What this catches that the contract test doesn't:
//
// 1. The runtime's `instantiate()` accepts the recipe's tenantDispatch
//    payload without throwing. Past schema gaps (zod missing the
//    variant, runtime missing the dispatcher branch) would fail here.
// 2. The TenantDispatchRoute constructor consumes the parsed tenants
//    table without rejecting any row.
// 3. The route's `match()` semantics align with what the recipe
//    declares: alice's SNI host matches alice; bob's path prefix
//    matches bob; unknown host/path → no match.
//
// Per ADR-0030 §A2 + cloister-f289c8 epic. Tracking bead: cloister-c2bd47.

import { describe, expect, it } from "vitest";
// `?raw` inlines the TOML file at vitest bundle time. workerd has no
// fs primitive; this is the only way to read the recipe from inside a
// pool-workers test. Same pattern used by other workerd-pool fixtures.
// eslint-disable-next-line import/no-unresolved
import RECIPE_TOML_STRING from "../../recipes/multi-tenant-smoke/cluster.toml?raw";
import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";
import { TenantDispatchRoute, compileDispatchTable } from "../../src/routes/tenant-dispatch.js";
import { instantiate } from "../../src/manifest/runtime.js";
import type { Gateway, TenantDispatchSpec } from "../../src/manifest/types.js";

// ── Stage 1: parse the recipe TOML ───────────────────────────────────────

describe("recipe → instantiate pipeline: multi-tenant-smoke (cloister-c2bd47)", () => {
  it("recipe's cluster.toml parses without zod errors", async () => {
    const tomlString = RECIPE_TOML_STRING;
    const cluster = await parseTomlToCluster(tomlString);
    expect(cluster.metadata.name).toBe("cloister-multi-tenant-smoke");
    expect(cluster.bundles.length).toBe(3);
    expect(cluster.routes.length).toBe(2);
  });

  it("the tenantDispatch route appears in the parsed Cluster.routes list", async () => {
    const tomlString = RECIPE_TOML_STRING;
    const cluster = await parseTomlToCluster(tomlString);
    const dispatchRoute = cluster.routes.find(
      (r: { kind: Record<string, unknown> }) => "tenantDispatch" in r.kind,
    );
    expect(dispatchRoute).toBeDefined();
    expect(dispatchRoute?.path).toBe("/");

    const kind = dispatchRoute!.kind as { tenantDispatch: TenantDispatchSpec };
    expect(kind.tenantDispatch.tenants.length).toBe(2);

    // The recipe shape: alice via SNI, bob via path-prefix. Pin both.
    const alice = kind.tenantDispatch.tenants.find((t) => t.name === "alice")!;
    const bob   = kind.tenantDispatch.tenants.find((t) => t.name === "bob")!;
    expect(alice.mode).toBe("sni");
    expect(alice.matchValue).toBe("alice.cluster.example");
    expect(alice.binding).toBe("T_ALICE");
    expect(bob.mode).toBe("path-prefix");
    expect(bob.matchValue).toBe("/t/bob");
    expect(bob.binding).toBe("T_BOB");
  });

  // ── Stage 2: build a Gateway from the parsed tenants table and
  //              instantiate() it. This closes the cross-pipeline gap —
  //              the parsed shape MUST be assignable to Gateway.routes
  //              and instantiate() MUST construct a TenantDispatchRoute
  //              from it without throwing.

  function gatewayFromTenants(spec: TenantDispatchSpec): Gateway {
    return {
      metadata: { name: "recipe-instantiate-test", version: "0.0.0" },
      routes: [{ path: "/", kind: { tenantDispatch: spec } }],
      actor: {
        fingerprint:     "",
        algorithm:       "ed25519",
        pubkeyBinding:   "",
        attestationRepo: "",
        tunnelEndpoint:  "",
      },
      policy: {
        maxCertLifetimeSeconds: 300,
        requireInterlock:       false,
        minAlgorithm:           "ed25519",
      },
    };
  }

  it("the parsed tenantDispatch payload survives instantiate() without throwing", async () => {
    const tomlString = RECIPE_TOML_STRING;
    const cluster = await parseTomlToCluster(tomlString);
    const dispatchRoute = cluster.routes.find(
      (r: { kind: Record<string, unknown> }) => "tenantDispatch" in r.kind,
    )!;
    const spec = (dispatchRoute.kind as { tenantDispatch: TenantDispatchSpec }).tenantDispatch;

    const gw = gatewayFromTenants(spec);
    const routes = instantiate(gw);
    expect(routes.length).toBe(1);
    expect(routes[0]).toBeInstanceOf(TenantDispatchRoute);
  });

  it("compileDispatchTable accepts the recipe's tenants without operator-config rejections", async () => {
    const tomlString = RECIPE_TOML_STRING;
    const cluster = await parseTomlToCluster(tomlString);
    const dispatchRoute = cluster.routes.find(
      (r: { kind: Record<string, unknown> }) => "tenantDispatch" in r.kind,
    )!;
    const spec = (dispatchRoute.kind as { tenantDispatch: TenantDispatchSpec }).tenantDispatch;

    // The compiler enforces: non-empty names, valid modes, no SNI
    // collision, non-empty bindings. The recipe shape is the
    // operator-facing canonical example — these properties MUST hold.
    expect(() => compileDispatchTable(spec)).not.toThrow();
  });

  it("alice's SNI host matches alice; bob's path-prefix matches bob; unknown does not match (round-trip semantics)", async () => {
    const tomlString = RECIPE_TOML_STRING;
    const cluster = await parseTomlToCluster(tomlString);
    const dispatchRoute = cluster.routes.find(
      (r: { kind: Record<string, unknown> }) => "tenantDispatch" in r.kind,
    )!;
    const spec = (dispatchRoute.kind as { tenantDispatch: TenantDispatchSpec }).tenantDispatch;

    const route = new TenantDispatchRoute(spec);

    // alice: SNI host match
    expect(route.match(new Request("https://alice.cluster.example/foo"))).toBe(true);
    // bob: path-prefix match
    expect(route.match(new Request("https://router.example/t/bob/mcp"))).toBe(true);
    // bob: exact prefix (no trailing path) match
    expect(route.match(new Request("https://router.example/t/bob"))).toBe(true);
    // separator-aware: /t/bob-staging does NOT match /t/bob (boundary check)
    expect(route.match(new Request("https://router.example/t/bob-staging"))).toBe(false);
    // unknown host
    expect(route.match(new Request("https://dave.cluster.example/foo"))).toBe(false);
    // unknown path
    expect(route.match(new Request("https://router.example/t/dave"))).toBe(false);
  });
});
