/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Runtime half of the multi-tenant recipe bridge. The Node-side test at
// scripts/test/recipe-multi-tenant-bridge.test.mjs parses and validates the
// real recipe, then proves this portable fixture is byte-for-byte equivalent
// to its Gateway projection. Keeping that Node-only parser out of workerd is
// intentional: importing node:fs / tsx into a Worker isolate is not a product
// boundary and crashes the native pool before tests can register.
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
// `?raw` inlines the checked JSON bridge at bundle time. workerd has no
// host filesystem primitive, and the Node-side test keeps this projection
// synchronized with the real TOML recipe.
// eslint-disable-next-line import/no-unresolved
import RECIPE_GATEWAY_JSON from "../fixtures/multi-tenant-smoke.gateway.json?raw";
import { TenantDispatchRoute, compileDispatchTable } from "../../src/routes/tenant-dispatch.js";
import { instantiate } from "../../src/manifest/runtime.js";
import type { Gateway, TenantDispatchSpec } from "../../src/manifest/types.js";

const gateway = JSON.parse(RECIPE_GATEWAY_JSON) as Gateway;

function recipeSpec(): TenantDispatchSpec {
  const route = gateway.routes.find((candidate) => "tenantDispatch" in candidate.kind);
  expect(route).toBeDefined();
  return (route!.kind as { tenantDispatch: TenantDispatchSpec }).tenantDispatch;
}

describe("recipe → instantiate pipeline: multi-tenant-smoke (cloister-c2bd47)", () => {
  it("the validated recipe fixture carries both declared tenants", () => {
    const spec = recipeSpec();
    expect(gateway.routes[0]?.path).toBe("/");
    expect(spec.tenants.length).toBe(2);

    // The recipe shape: alice via SNI, bob via path-prefix. Pin both.
    const alice = spec.tenants.find((t) => t.name === "alice")!;
    const bob = spec.tenants.find((t) => t.name === "bob")!;
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

  it("the parsed tenantDispatch payload survives instantiate() without throwing", () => {
    const routes = instantiate(gateway);
    expect(routes.length).toBe(1);
    expect(routes[0]).toBeInstanceOf(TenantDispatchRoute);
  });

  it("compileDispatchTable accepts the recipe's tenants without operator-config rejections", () => {
    const spec = recipeSpec();
    // The compiler enforces: non-empty names, valid modes, no SNI
    // collision, non-empty bindings. The recipe shape is the
    // operator-facing canonical example — these properties MUST hold.
    expect(() => compileDispatchTable(spec)).not.toThrow();
  });

  it("alice's SNI host matches alice; bob's path-prefix matches bob; unknown does not match (round-trip semantics)", () => {
    const spec = recipeSpec();
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
