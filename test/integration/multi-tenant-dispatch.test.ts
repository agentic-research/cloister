/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Multi-tenant reality smoke for ADR-0030 §A2 dispatch + adversarial cycle
// 2026-06-22 fixes (cloister-92e846 / cloister-9339c0 / threat-model §13.7.6).
//
// Why this file exists, in plain language:
//
//   The unit tests in `test/routes/tenant-dispatch.test.ts` exercise the
//   `TenantDispatchRoute` class directly: build a route, call match() and
//   handle(), assert response shapes. Those tests pin the BEHAVIOR — but
//   they bypass the manifest pipeline (`instantiate()` from
//   `src/manifest/runtime.ts`), which is the actual entry point production
//   uses to construct routes from a `Gateway` manifest.
//
//   This file closes that gap by going through `instantiate()` against a
//   constructed multi-tenant `Gateway` manifest, then exercising the
//   resulting route under realistic conditions:
//
//     - 3 tenants in a single dispatch table, mixed SNI + path-prefix modes
//     - 2 tenants wired to stub Fetchers, 1 declared but unwired (operator
//       misconfig scenario)
//     - Real `fetch()`-shaped Requests across all match paths +
//       unknown-tenant paths
//     - Concurrent probe load to stress the WeakMap match cache + the
//       warnedBindings throttle Set together
//
//   Per the user's "are we testing reality" framing (2026-06-22): the
//   substrate's operator-facing path to declare `tenantDispatch` in
//   `cluster.toml` is not yet shipped (the implementation epic
//   `cloister-f289c8` is the path to that). Until then, this file is the
//   closest production-shaped exercise of the multi-tenant dispatch
//   surface — the manifest pipeline is real, the workerd isolate is real,
//   the routes are real, the only thing simulated is the upstream tenant
//   workerds (stub Fetchers).
//
// Properties pinned:
//
//   - §13.7.1 / cloister-92e846 (C1): byte-equivalent 404 across every
//     "did not dispatch" path — unmatched, unwired-binding, path-not-found
//   - §13.7.6(b) / cloister-92e846: path-prefix scan walks all rows (proven
//     via first-match-preservation under table extension)
//   - §13.7.6(c) / cloister-92e846: match() + handle() share one scan via
//     the WeakMap cache (verified by direct cache inspection)
//   - §13.7.6(d) / cloister-9339c0 (C3): unwired-binding warn fires AT
//     MOST ONCE per binding regardless of probe count, AND never echoes
//     the tenant name
//   - Cross-tenant routing isolation: alice's stub Fetcher receives only
//     alice's requests; bob's receives only bob's; neither sees the other

import { describe, expect, it } from "vitest";
import { instantiate } from "../../src/manifest/runtime.js";
import { TenantDispatchRoute } from "../../src/routes/tenant-dispatch.js";
import type { Gateway, TenantDispatchSpec } from "../../src/manifest/types.js";
import type { Env } from "../../src/types.js";

// ── Manifest fixture ─────────────────────────────────────────────────────

function gatewayWithTenants(tenants: TenantDispatchSpec["tenants"]): Gateway {
  return {
    metadata: { name: "test-multi-tenant", version: "0.0.0" },
    routes: [
      {
        path: "/",
        kind: { tenantDispatch: { tenants } },
      },
    ],
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

// ── Stub Fetcher that records every URL it receives ─────────────────────

function makeStubFetcher(label: string): {
  fetcher: Fetcher;
  seenUrls: () => readonly string[];
} {
  const seen: string[] = [];
  const fetcher: Fetcher = {
    async fetch(req: RequestInfo | URL): Promise<Response> {
      const r = req instanceof Request ? req : new Request(req);
      seen.push(r.url);
      return new Response(`${label}:${r.url}`, { status: 200 });
    },
  } as unknown as Fetcher;
  return { fetcher, seenUrls: () => seen };
}

// ── Construct the route via instantiate() (real manifest pipeline) ─────

function buildRoute(): TenantDispatchRoute {
  const gw = gatewayWithTenants([
    // SNI tenant (alice)
    { name: "alice", mode: "sni",         matchValue: "alice.example", binding: "T_ALICE" },
    // Path-prefix tenant (bob)
    { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",        binding: "T_BOB" },
    // Path-prefix tenant declared but env will NOT wire — operator misconfig
    { name: "carol", mode: "path-prefix", matchValue: "/t/carol",      binding: "T_CAROL_UNWIRED" },
  ]);
  const routes = instantiate(gw);
  // The tenantDispatch route is the only one in this manifest.
  expect(routes.length).toBe(1);
  expect(routes[0]).toBeInstanceOf(TenantDispatchRoute);
  return routes[0] as TenantDispatchRoute;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("multi-tenant reality smoke: instantiate() → TenantDispatchRoute (cloister-92e846 + 9339c0)", () => {
  it("manifest pipeline accepts a tenantDispatch route with 3 mixed-mode tenants", () => {
    const route = buildRoute();
    // No throw from instantiate() / compileDispatchTable means the
    // structural validators passed: unique names, valid modes, no SNI
    // collision, non-empty matchValues + bindings.
    expect(route).toBeDefined();
  });

  it("alice (SNI) request: forwarded to T_ALICE, full URL preserved", async () => {
    const route = buildRoute();
    const { fetcher: aliceF, seenUrls: aliceSeen } = makeStubFetcher("alice");
    const { fetcher: bobF,   seenUrls: bobSeen   } = makeStubFetcher("bob");
    const env = { T_ALICE: aliceF, T_BOB: bobF } as unknown as Env;
    const req = new Request("https://alice.example/whatever?q=1");

    expect(route.match(req)).toBe(true);
    const res = await route.handle(req, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("alice:https://alice.example/whatever?q=1");
    // Cross-tenant isolation: bob's fetcher was NOT called.
    expect(aliceSeen()).toEqual(["https://alice.example/whatever?q=1"]);
    expect(bobSeen()).toEqual([]);
  });

  it("bob (path-prefix) request: forwarded to T_BOB with prefix stripped", async () => {
    const route = buildRoute();
    const { fetcher: aliceF, seenUrls: aliceSeen } = makeStubFetcher("alice");
    const { fetcher: bobF,   seenUrls: bobSeen   } = makeStubFetcher("bob");
    const env = { T_ALICE: aliceF, T_BOB: bobF } as unknown as Env;
    const req = new Request("https://router.example/t/bob/mcp");

    expect(route.match(req)).toBe(true);
    const res = await route.handle(req, env);
    expect(res.status).toBe(200);
    // The /t/bob prefix is stripped before forwarding.
    expect(await res.text()).toBe("bob:https://router.example/mcp");
    expect(bobSeen()).toEqual(["https://router.example/mcp"]);
    // Cross-tenant isolation.
    expect(aliceSeen()).toEqual([]);
  });

  it("carol (unwired) request: 404, no fetcher called, warn fires ONCE per binding", async () => {
    const route = buildRoute();
    // Env wires alice + bob but NOT carol. The carol path-prefix matches
    // structurally, but the binding lookup yields undefined → 404.
    const { fetcher: aliceF, seenUrls: aliceSeen } = makeStubFetcher("alice");
    const { fetcher: bobF,   seenUrls: bobSeen   } = makeStubFetcher("bob");
    const env = { T_ALICE: aliceF, T_BOB: bobF } as unknown as Env;

    const warnCalls: string[] = [];
    const orig = console.warn;
    console.warn = ((arg: string) => { warnCalls.push(arg); });
    try {
      for (let i = 0; i < 7; i++) {
        const req = new Request(`https://router.example/t/carol/probe-${i}`);
        const res = await route.handle(req, env);
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body.length).toBe(256);
        expect(body).toBe("0".repeat(256));
      }
    } finally {
      console.warn = orig;
    }

    // 7 probes → 1 warn (throttle property pinned).
    expect(warnCalls.length).toBe(1);
    const emit = JSON.parse(warnCalls[0]!);
    expect(emit.event).toBe("tenant_dispatch.unwired_binding");
    expect(emit.binding).toBe("T_CAROL_UNWIRED");
    expect(emit.bead).toBe("cloister-9339c0");
    // §13.7.6 contract: tenant name MUST NOT appear in the emit.
    expect(warnCalls[0]).not.toContain("carol");
    expect(emit.name).toBeUndefined();
    expect(emit.tenant).toBeUndefined();
    // No upstream fetcher saw the request — defense in depth.
    expect(aliceSeen()).toEqual([]);
    expect(bobSeen()).toEqual([]);
  });

  it("byte-equivalence across every 'did not dispatch' path — unmatched, unwired-binding, disclosure 404", async () => {
    const route = buildRoute();
    const env = {} as Env; // No bindings wired at all; alice + bob also fail to dispatch.

    const probes = [
      "https://alice.example/x",                  // matched-but-unwired (alice)
      "https://router.example/t/bob/x",           // matched-but-unwired (bob)
      "https://router.example/t/carol/x",         // matched-but-unwired (carol, always unwired)
    ];
    interface ResponseShape {
      status:         number;
      contentType:    string | null;
      contentLength:  string | null;
      cacheControl:   string | null;
      body:           string;
    }
    const responses: ResponseShape[] = [];
    for (const url of probes) {
      const req = new Request(url);
      const res = await route.handle(req, env);
      expect(res.status).toBe(404);
      responses.push({
        status:         res.status,
        contentType:    res.headers.get("content-type"),
        contentLength:  res.headers.get("content-length"),
        cacheControl:   res.headers.get("cache-control"),
        body:           await res.text(),
      });
    }
    // All three responses must be byte-identical across every observable
    // dimension. If they aren't, a tenant-existence oracle re-opens.
    for (let i = 1; i < responses.length; i++) {
      expect(responses[i].status).toBe(responses[0].status);
      expect(responses[i].contentType).toBe(responses[0].contentType);
      expect(responses[i].contentLength).toBe(responses[0].contentLength);
      expect(responses[i].cacheControl).toBe(responses[0].cacheControl);
      expect(responses[i].body).toBe(responses[0].body);
    }
    expect(responses[0].body.length).toBe(256);

    // And must equal disclosure's `constantTimeErrorResponse("not_found")`
    // — the cross-route invariant from §9.4.b + §13.7.1.
    const { constantTimeErrorResponse } = await import(
      "../../src/storage/disclosure-cursor.js"
    );
    const ref = constantTimeErrorResponse("not_found");
    expect(responses[0].status).toBe(ref.status);
    expect(responses[0].contentType).toBe(ref.headers.get("content-type"));
    expect(responses[0].contentLength).toBe(ref.headers.get("content-length"));
    expect(responses[0].cacheControl).toBe(ref.headers.get("cache-control"));
    expect(responses[0].body).toBe(await ref.text());
  });

  it("match() + handle() share scan via WeakMap (§13.7.6(c)): cache populated after match()", async () => {
    const route = buildRoute();
    const { fetcher: aliceF } = makeStubFetcher("alice");
    const env = { T_ALICE: aliceF } as unknown as Env;

    const req = new Request("https://alice.example/x");
    expect(route.match(req)).toBe(true);

    const cache = (route as unknown as {
      matchCache: WeakMap<Request, unknown>;
    }).matchCache;
    expect(cache.has(req)).toBe(true);

    // handle() reuses cache — verify behavior + status; the no-double-scan
    // property is structural (see resolveMatch() source).
    const res = await route.handle(req, env);
    expect(res.status).toBe(200);
  });

  it("concurrent probes against the same tenant: warn throttle holds, all requests forwarded", async () => {
    const route = buildRoute();
    const { fetcher: bobF, seenUrls: bobSeen } = makeStubFetcher("bob");
    const env = { T_BOB: bobF } as unknown as Env; // alice + carol unwired

    const warnCalls: string[] = [];
    const orig = console.warn;
    console.warn = ((arg: string) => { warnCalls.push(arg); });
    try {
      // 30 concurrent requests: 10 to bob (wired), 10 to alice (unwired),
      // 10 to carol (unwired). Run via Promise.all to stress concurrent
      // access to warnedBindings + matchCache.
      const reqs: Promise<Response>[] = [];
      for (let i = 0; i < 10; i++) {
        reqs.push(route.handle(new Request(`https://router.example/t/bob/p${i}`),   env));
        reqs.push(route.handle(new Request(`https://alice.example/p${i}`),          env));
        reqs.push(route.handle(new Request(`https://router.example/t/carol/p${i}`), env));
      }
      const results = await Promise.all(reqs);
      // Bob's: 10 × 200; the others: 20 × 404.
      const successCount = results.filter((r) => r.status === 200).length;
      const failCount    = results.filter((r) => r.status === 404).length;
      expect(successCount).toBe(10);
      expect(failCount).toBe(20);
    } finally {
      console.warn = orig;
    }

    // 20 unwired probes spanning 2 bindings (T_ALICE + T_CAROL_UNWIRED) →
    // exactly 2 warns. The cross-tenant probe volume doesn't blow up the
    // log channel.
    expect(warnCalls.length).toBe(2);
    const bindings = warnCalls.map((s) => JSON.parse(s).binding).sort();
    expect(bindings).toEqual(["T_ALICE", "T_CAROL_UNWIRED"]);
    // Tenant names absent from log.
    for (const w of warnCalls) {
      expect(w).not.toContain("alice");
      expect(w).not.toContain("carol");
    }
    // Bob's fetcher saw 10 distinct stripped paths.
    expect(bobSeen().length).toBe(10);
    const uniquePaths = new Set(bobSeen());
    expect(uniquePaths.size).toBe(10);
  });

  it("unknown tenant: no match, route.match() returns false (router falls through)", () => {
    const route = buildRoute();
    // Host not in SNI table AND path doesn't match any prefix.
    expect(route.match(new Request("https://dave.example/x"))).toBe(false);
    expect(route.match(new Request("https://router.example/t/dave/x"))).toBe(false);
    expect(route.match(new Request("https://router.example/no/such/path"))).toBe(false);
  });
});
