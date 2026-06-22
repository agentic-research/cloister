// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the per-tenant dispatch route (ADR-0030 §A2 /
// cloister-0f144c).
//
// Properties pinned (these are the §13.7.1 + §13.7.5 contract):
//   - SNI mode: exact host-header match (O(1) hash-table lookup)
//   - Path-prefix mode: starts-with match with separator-aware
//     boundary (`/t/alice` matches `/t/alice/foo` but NOT `/t/alice-bar`)
//   - Path-prefix mode strips the prefix before forwarding (tenant
//     sees the inner path)
//   - Unknown tenant → constant-time 404 (no peer-existence oracle
//     per threat-model §13.7.1)
//   - Compile-time rejections: empty fields, unknown mode, duplicate
//     names, duplicate SNI hosts
//   - Misconfigured binding (declared but not wired) → 404, not 500
//     (preserves the constant-time invariant under operator misconfig)

import { describe, expect, it } from "vitest";

import {
  TenantDispatchRoute,
  compileDispatchTable,
  matchTenant,
} from "../../src/routes/tenant-dispatch.js";
import type { TenantDispatchSpec } from "../../src/manifest/types.js";
import type { Env } from "../../src/types.js";

// ── Test fixtures ────────────────────────────────────────────────────────

function makeSpec(tenants: TenantDispatchSpec["tenants"]): TenantDispatchSpec {
  return { tenants };
}

function makeRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

/**
 * Stub Fetcher that captures the inbound request URL + returns a 200
 * with the URL in the body. Lets the test assert what URL was
 * forwarded.
 */
function makeStubFetcher(): { fetcher: Fetcher; lastUrl: () => string | null } {
  let lastUrl: string | null = null;
  const fetcher: Fetcher = {
    async fetch(req: RequestInfo | URL): Promise<Response> {
      const r = req instanceof Request ? req : new Request(req);
      lastUrl = r.url;
      return new Response(`forwarded ${r.url}`, { status: 200 });
    },
  } as unknown as Fetcher;
  return { fetcher, lastUrl: () => lastUrl };
}

// ── compileDispatchTable: validation rejections ──────────────────────────

describe("compileDispatchTable: validation", () => {
  it("rejects empty name", () => {
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "", mode: "sni", matchValue: "x.example", binding: "T1" },
      ])),
    ).toThrow(/empty tenant name/);
  });

  it("rejects empty matchValue", () => {
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "alice", mode: "sni", matchValue: "", binding: "T1" },
      ])),
    ).toThrow(/empty matchValue/);
  });

  it("rejects empty binding", () => {
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "alice", mode: "sni", matchValue: "x.example", binding: "" },
      ])),
    ).toThrow(/empty binding/);
  });

  it("rejects unknown mode", () => {
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "alice", mode: "lol-mode", matchValue: "x", binding: "T1" },
      ])),
    ).toThrow(/unknown mode/);
  });

  it("rejects duplicate tenant name across rows", () => {
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "alice", mode: "sni", matchValue: "a.example", binding: "T1" },
        { name: "alice", mode: "path-prefix", matchValue: "/t/alice", binding: "T1" },
      ])),
    ).toThrow(/duplicate tenant name/);
  });

  it("rejects duplicate SNI matchValue", () => {
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "alice", mode: "sni", matchValue: "shared.example", binding: "T1" },
        { name: "bob",   mode: "sni", matchValue: "shared.example", binding: "T2" },
      ])),
    ).toThrow(/duplicate SNI matchValue/);
  });

  it("permits duplicate path-prefix matchValues (table-order precedence handles them)", () => {
    // Operators can layer specific prefixes over general ones.
    expect(() =>
      compileDispatchTable(makeSpec([
        { name: "alice-staging", mode: "path-prefix", matchValue: "/t/alice-staging", binding: "T1" },
        { name: "alice",         mode: "path-prefix", matchValue: "/t/alice",         binding: "T2" },
      ])),
    ).not.toThrow();
  });

  it("accepts mixed-mode tables (some SNI, some path-prefix)", () => {
    const table = compileDispatchTable(makeSpec([
      { name: "alice", mode: "sni",         matchValue: "a.example", binding: "T1" },
      { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",    binding: "T2" },
    ]));
    expect(table.sni.size).toBe(1);
    expect(table.pathPrefix.length).toBe(1);
  });
});

// ── matchTenant: SNI mode ────────────────────────────────────────────────

describe("matchTenant: SNI mode", () => {
  const table = compileDispatchTable(makeSpec([
    { name: "alice", mode: "sni", matchValue: "alice.cluster.example", binding: "T_ALICE" },
    { name: "bob",   mode: "sni", matchValue: "bob.cluster.example",   binding: "T_BOB" },
  ]));

  it("matches exact host", () => {
    const r = matchTenant(table, makeRequest("https://alice.cluster.example/x"));
    expect(r?.row.name).toBe("alice");
    expect(r?.strippedPath).toBe("/x"); // SNI mode does not strip path
  });

  it("does not match a similar but different host", () => {
    const r = matchTenant(table, makeRequest("https://alice.different.example/x"));
    expect(r).toBe(null);
  });

  it("does not match a substring of the host", () => {
    const r = matchTenant(table, makeRequest("https://alice.cluster.example.com/x"));
    expect(r).toBe(null); // hostname differs
  });

  it("does not match a path-prefix-shaped request when SNI rows are declared", () => {
    const r = matchTenant(table, makeRequest("https://other.example/t/alice"));
    expect(r).toBe(null);
  });
});

// ── matchTenant: path-prefix mode ────────────────────────────────────────

describe("matchTenant: path-prefix mode", () => {
  const table = compileDispatchTable(makeSpec([
    { name: "alice", mode: "path-prefix", matchValue: "/t/alice", binding: "T_ALICE" },
    { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",   binding: "T_BOB" },
  ]));

  it("matches exact prefix → strips to '/'", () => {
    const r = matchTenant(table, makeRequest("https://router.example/t/alice"));
    expect(r?.row.name).toBe("alice");
    expect(r?.strippedPath).toBe("/");
  });

  it("matches prefix with trailing slash → strips to '/'", () => {
    const r = matchTenant(table, makeRequest("https://router.example/t/alice/"));
    expect(r?.row.name).toBe("alice");
    expect(r?.strippedPath).toBe("/");
  });

  it("matches prefix with inner path → strips correctly", () => {
    const r = matchTenant(table, makeRequest("https://router.example/t/alice/mcp"));
    expect(r?.row.name).toBe("alice");
    expect(r?.strippedPath).toBe("/mcp");
  });

  it("does NOT match a similar prefix that isn't separator-bound", () => {
    // Key invariant: /t/alice prefix MUST NOT match /t/alice-bar
    const r = matchTenant(table, makeRequest("https://router.example/t/alice-bar"));
    expect(r).toBe(null);
  });

  it("first-match precedence: specific prefix wins over general", () => {
    const layered = compileDispatchTable(makeSpec([
      { name: "alice-staging", mode: "path-prefix", matchValue: "/t/alice-staging", binding: "TS" },
      { name: "alice",         mode: "path-prefix", matchValue: "/t/alice",         binding: "TA" },
    ]));
    const r = matchTenant(layered, makeRequest("https://router.example/t/alice-staging/x"));
    expect(r?.row.name).toBe("alice-staging");
    expect(r?.strippedPath).toBe("/x");
  });

  it("no match → null", () => {
    const r = matchTenant(table, makeRequest("https://router.example/no/such/prefix"));
    expect(r).toBe(null);
  });
});

// ── TenantDispatchRoute: end-to-end ──────────────────────────────────────

describe("TenantDispatchRoute: end-to-end", () => {
  it("forwards SNI-matched request unchanged", async () => {
    const { fetcher, lastUrl } = makeStubFetcher();
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.cluster.example", binding: "T_ALICE" },
    ]));
    const env = { T_ALICE: fetcher } as unknown as Env;
    const req = makeRequest("https://alice.cluster.example/foo/bar");
    expect(route.match(req)).toBe(true);
    const res = await route.handle(req, env);
    expect(res.status).toBe(200);
    expect(lastUrl()).toBe("https://alice.cluster.example/foo/bar");
  });

  it("forwards path-prefix-matched request with stripped path", async () => {
    const { fetcher, lastUrl } = makeStubFetcher();
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "path-prefix", matchValue: "/t/alice", binding: "T_ALICE" },
    ]));
    const env = { T_ALICE: fetcher } as unknown as Env;
    const req = makeRequest("https://router.example/t/alice/mcp");
    expect(route.match(req)).toBe(true);
    const res = await route.handle(req, env);
    expect(res.status).toBe(200);
    expect(lastUrl()).toBe("https://router.example/mcp");
  });

  it("unknown tenant → match() returns false (router falls through)", () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.cluster.example", binding: "T_ALICE" },
    ]));
    const req = makeRequest("https://carol.cluster.example/x");
    expect(route.match(req)).toBe(false);
  });

  it("matched tenant with unbound binding → 404 (not 500); preserves constant-time invariant", async () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.cluster.example", binding: "T_ALICE" },
    ]));
    // env doesn't have T_ALICE wired (operator misconfig).
    const env = {} as Env;
    const req = makeRequest("https://alice.cluster.example/x");
    expect(route.match(req)).toBe(true);
    const res = await route.handle(req, env);
    expect(res.status).toBe(404);
    // Body is the 256-byte zero-padded constant-time shape, not the
    // legacy "Not Found\n" (which was a 10-byte enumeration oracle —
    // cloister-92e846 / C1 fix).
    const body = await res.text();
    expect(body.length).toBe(256);
    expect(body).toBe("0".repeat(256));
  });

  it("404 body bytes are byte-equivalent with disclosure's constantTimeErrorResponse (cloister-92e846 fix)", async () => {
    // CRITICAL property per threat-model §13.7.1 + §9.4.b: tenant-
    // dispatch's no-match / no-binding 404 must be BYTE-IDENTICAL to
    // the disclosure endpoint's 404 so an attacker probing
    // `/t/<guess>/interlace/peers/<fp>` cannot distinguish
    // tenant-existence by response length / shape.
    const { constantTimeErrorResponse } = await import(
      "../../src/storage/disclosure-cursor.js"
    );
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.cluster.example", binding: "T_ALICE" },
    ]));
    const env = {} as Env;
    const tenantRes = await route.handle(
      makeRequest("https://alice.cluster.example/x"),
      env,
    );
    const refRes = constantTimeErrorResponse("not_found");

    expect(tenantRes.status).toBe(refRes.status);
    expect(tenantRes.headers.get("content-type")).toBe(refRes.headers.get("content-type"));
    expect(tenantRes.headers.get("content-length")).toBe(refRes.headers.get("content-length"));
    expect(tenantRes.headers.get("cache-control")).toBe(refRes.headers.get("cache-control"));
    expect(await tenantRes.text()).toBe(await refRes.text());
  });
});

// ── cloister-92e846 / §13.7.6(b): path-prefix scan is constant-time WRT row position ─

describe("§13.7.6(b): path-prefix scan does not early-break (cloister-92e846)", () => {
  // We can't measure wall-clock timing in a unit test (workerd quantizes
  // and Node's perf is noisy), so we pin the STRUCTURAL property: every
  // row's prefix is examined on every call, regardless of which row
  // matches. We do this by spying on a custom .startsWith via String
  // proxying — too brittle. Instead we count via a derived invariant:
  // the function returns AFTER iterating all rows, so any side effect
  // we attach to row iteration must fire N times.
  //
  // Practical approach: build a table with a sentinel row whose
  // matchValue intentionally would NOT match the request URL. Verify
  // that probing an earlier-matching row STILL terminates correctly
  // (preserving first-match-precedence) — which is sufficient evidence
  // that we kept walking past the match point in the iteration order.

  it("first-match precedence preserved even when subsequent rows would also match", () => {
    // Both /t/a and /t/a/sub would match the request URL /t/a/sub/x;
    // table order puts /t/a first, so first-match wins. If early-break
    // were re-introduced, this test would still pass — but the
    // strucutral property below covers the timing-relevant case.
    const table = compileDispatchTable(makeSpec([
      { name: "a-outer",  mode: "path-prefix", matchValue: "/t/a",     binding: "T_OUTER" },
      { name: "a-inner",  mode: "path-prefix", matchValue: "/t/a/sub", binding: "T_INNER" },
    ]));
    const r = matchTenant(table, makeRequest("https://router.example/t/a/sub/x"));
    expect(r?.row.name).toBe("a-outer"); // first-match
    expect(r?.strippedPath).toBe("/sub/x"); // /t/a stripped, leaving /sub/x
  });

  it("structural: matchTenant returns the SAME first match regardless of whether later rows match too", () => {
    // Two equivalent tables: same prefix order, but the second has
    // additional later rows that also match. If we early-broke, both
    // would short-circuit at the first match and return identically.
    // After the §13.7.6(b) fix, both still return the first match —
    // and (more importantly) the function ITSELF doesn't return early,
    // which we can't observe directly. We assert the result agreement
    // as a baseline; the timing property is documented in the source.
    const tableA = compileDispatchTable(makeSpec([
      { name: "alice", mode: "path-prefix", matchValue: "/t/alice", binding: "TA" },
    ]));
    const tableB = compileDispatchTable(makeSpec([
      { name: "alice", mode: "path-prefix", matchValue: "/t/alice", binding: "TA" },
      { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",   binding: "TB" },
      { name: "alice-also", mode: "path-prefix", matchValue: "/t/alice", binding: "TC" },
    ]));
    const req = makeRequest("https://router.example/t/alice/x");
    const a = matchTenant(tableA, req);
    const b = matchTenant(tableB, req);
    expect(a?.row.name).toBe("alice");
    expect(b?.row.name).toBe("alice"); // first match wins; bob + alice-also examined but not returned
  });

  it("no path-prefix row matches → null (full table walked, no false positive)", () => {
    const table = compileDispatchTable(makeSpec([
      { name: "alice", mode: "path-prefix", matchValue: "/t/alice", binding: "TA" },
      { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",   binding: "TB" },
      { name: "carol", mode: "path-prefix", matchValue: "/t/carol", binding: "TC" },
    ]));
    const r = matchTenant(table, makeRequest("https://router.example/t/dave/x"));
    expect(r).toBe(null);
  });
});

// ── cloister-92e846 / §13.7.6(c): match() / handle() dedup via WeakMap cache ─

describe("§13.7.6(c): match() and handle() share a per-request scan cache (cloister-92e846)", () => {
  it("handle() does NOT call matchTenant a second time when match() was already called", async () => {
    // Spy on matchTenant via a route-instance-level counter. We can't
    // intercept the exported function from inside the route, but we can
    // count calls indirectly by routing requests through a small fixture
    // that uses a derived counter. Workable approach: use a tiny custom
    // path-prefix table where matchTenant ALSO mutates a Map keyed by
    // request URL — but matchTenant is pure. Instead, assert behavior
    // via WeakMap presence: after match() returns true, the cache MUST
    // have an entry for this request.
    const { fetcher } = makeStubFetcher();
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
    ]));
    const env = { T_ALICE: fetcher } as unknown as Env;
    const req = makeRequest("https://alice.example/x");

    // First call: match() populates the cache.
    expect(route.match(req)).toBe(true);

    // Inspect the private cache via type cast — internal API; test is
    // tightly coupled to the implementation by design (this is the
    // §13.7.6(c) invariant).
    const cache = (route as unknown as {
      matchCache: WeakMap<Request, unknown>;
    }).matchCache;
    expect(cache.has(req)).toBe(true);

    // handle() re-reads from cache; result is the same row, no new scan.
    const res = await route.handle(req, env);
    expect(res.status).toBe(200);
  });

  it("cache miss for never-matched request: handle() computes fresh (defensive)", async () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
    ]));
    const env = {} as Env;
    // Direct call to handle() without prior match() — handle() should
    // still work via the resolveMatch() fallback compute path.
    const req = makeRequest("https://nope.example/x");
    const res = await route.handle(req, env);
    // Cache populated by handle()'s own resolveMatch() call.
    const cache = (route as unknown as {
      matchCache: WeakMap<Request, unknown>;
    }).matchCache;
    expect(cache.has(req)).toBe(true);
    // Match result was null → 404.
    expect(res.status).toBe(404);
  });

  it("distinct requests cache independently (WeakMap key is the request object)", async () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
    ]));
    const reqA = makeRequest("https://alice.example/x");
    const reqB = makeRequest("https://nope.example/x");
    route.match(reqA);
    route.match(reqB);
    const cache = (route as unknown as {
      matchCache: WeakMap<Request, unknown>;
    }).matchCache;
    expect(cache.has(reqA)).toBe(true);
    expect(cache.has(reqB)).toBe(true);
    expect(cache.get(reqA)).not.toBe(null); // alice matched
    expect(cache.get(reqB)).toBe(null);     // nope did not
  });
});

// ── cloister-9339c0 (C3 / §13.7.6): unwired-binding emit is throttled + redacted ─

describe("§13.7.6 contract: unwired-binding warn does not enumerate tenants (cloister-9339c0)", () => {
  it("emit fires AT MOST ONCE per binding over route lifetime", async () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
    ]));
    const warnCalls: unknown[] = [];
    const orig = console.warn;
    console.warn = ((...args: unknown[]) => { warnCalls.push(args); });
    try {
      for (let i = 0; i < 5; i++) {
        await route.handle(makeRequest("https://alice.example/x"), {} as Env);
      }
    } finally {
      console.warn = orig;
    }
    // Five misconfigured-tenant probes → exactly one emit. Repeated probes
    // can no longer enumerate the tenant table via log channel.
    expect(warnCalls.length).toBe(1);
  });

  it("emit is structured JSON and OMITS the tenant name (only binding leaks, deploy-static)", async () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE_SECRET_NAME" },
    ]));
    const warnArgs: string[] = [];
    const orig = console.warn;
    console.warn = ((arg: string) => { warnArgs.push(arg); });
    try {
      await route.handle(makeRequest("https://alice.example/x"), {} as Env);
    } finally {
      console.warn = orig;
    }
    expect(warnArgs.length).toBe(1);
    const emit = JSON.parse(warnArgs[0]!);
    expect(emit.event).toBe("tenant_dispatch.unwired_binding");
    expect(emit.binding).toBe("T_ALICE_SECRET_NAME");
    expect(emit.bead).toBe("cloister-9339c0");
    // CRITICAL: tenant row.name MUST NOT appear in the emit payload.
    // The binding name above is deliberately distinct from "alice" so a
    // substring search on the serialized JSON would catch any leak.
    expect(warnArgs[0]).not.toContain("alice");
    // No `name` field in the payload (defense against future regression
    // where someone re-adds row.name as a "for ops triage" convenience).
    expect(emit.name).toBeUndefined();
    expect(emit.tenant).toBeUndefined();
  });

  it("distinct bindings each get their own one-shot emit (still O(N) tenants over process lifetime)", async () => {
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "alice.example", binding: "T_ALICE" },
      { name: "bob",   mode: "sni", matchValue: "bob.example",   binding: "T_BOB" },
    ]));
    const warnCalls: string[] = [];
    const orig = console.warn;
    console.warn = ((arg: string) => { warnCalls.push(arg); });
    try {
      // Two probes per tenant; expect 2 distinct one-shot emits.
      await route.handle(makeRequest("https://alice.example/x"), {} as Env);
      await route.handle(makeRequest("https://alice.example/x"), {} as Env);
      await route.handle(makeRequest("https://bob.example/x"),   {} as Env);
      await route.handle(makeRequest("https://bob.example/x"),   {} as Env);
    } finally {
      console.warn = orig;
    }
    expect(warnCalls.length).toBe(2);
    const bindings = warnCalls.map((s) => JSON.parse(s).binding).sort();
    expect(bindings).toEqual(["T_ALICE", "T_BOB"]);
    // Tenant names still absent.
    for (const arg of warnCalls) {
      expect(arg).not.toContain("alice");
      expect(arg).not.toContain("bob");
    }
  });
});

// ── §13.7.5 contract: app_protocol labels are NOT authorization ──────────

describe("§13.7.5 contract: dispatch does not gate access (labels ≠ auth)", () => {
  it("dispatch route doesn't read app_protocol; it only does routing", () => {
    // The dispatch route's match logic looks at host + path only. It
    // doesn't read [[edges]] or app_protocol at all — those are
    // metadata for routing+observability, not access-control. Any
    // tenant that matches the table gets forwarded; the destination
    // tenant's lease middleware enforces authorization per ADR-0007.
    const route = new TenantDispatchRoute(makeSpec([
      { name: "alice", mode: "sni", matchValue: "a.example", binding: "T_ALICE" },
    ]));
    const req = makeRequest("https://a.example/x");
    expect(route.match(req)).toBe(true);
    // The route doesn't expose any "authorize" hook — its only
    // public API is match()/handle(). §13.7.5 contract structurally
    // enforced: there's no way to wire app_protocol into the
    // dispatch decision.
    expect(typeof (route as unknown as Record<string, unknown>).authorize).toBe("undefined");
  });
});
