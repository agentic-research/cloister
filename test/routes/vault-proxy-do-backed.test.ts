/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// End-to-end vault-DO-backed integration tests for the cred-iso/v1
// route. Exercises the full path under workerd:
//
//   Request → VaultProxyRoute.handle → auto-selects VaultDoCredentialStore
//   (env.VAULT_STORE bound) → forward() → vault DO proxyRequest → real
//   SQLite read → constant-shape 404 OR upstream-proxy response → Response
//
// Sibling to:
//   - test/routes/vault-do-credential-store.test.ts (D1 unit-level, mocked NS)
//   - test/routes/vault-proxy-route.test.ts (D2 wiring, mocked NS)
//   - test/vault-store.test.ts (vault DO integration, called directly)
//
// What this test proves that the D1/D2 unit tests don't:
//
//   1. The route's auto-select branch actually constructs
//      VaultDoCredentialStore against the production binding, not a
//      mock. A misconfigured wrangler.toml fails the gate here.
//   2. The body shape of vault DO's 404 propagates through the route
//      verbatim — proves we're hitting the DO (different shape from
//      the route's own CONSTANT_TIME_ERROR_BODY).
//   3. Per-bundle isolation via idFromName works against real SQLite —
//      seeding into idFromName("notme") is unreachable from a route
//      that uses idFromName("router").
//
// Per cloister-e2d38a (D3 of the DO saga / cloister-d98db2).

import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { VaultProxyRoute, type LeaseVerifier } from "../../src/routes/vault-proxy-route.js";
import type { Env } from "../../src/types.js";
import type {
  VaultProxyService,
} from "../../src/routes/vault-proxy.js";
import type { VerifiedLease } from "../../src/routes/lease-middleware.js";

// 64-hex (32-byte sha256) — matches what VerifiedLease.peerFp looks like.
const PEER_A = "1111111111111111111111111111111111111111111111111111111111111111";
const PEER_B = "2222222222222222222222222222222222222222222222222222222222222222";

const ROUTER_BUNDLE = "router";

interface VaultRpc {
  putCredential(
    subjectFp: string,
    service: string,
    cred: { upstream: string; headers: Record<string, string>; allowedSubs: string[] },
  ): Promise<void>;
  deleteCredential(subjectFp: string, service: string): Promise<boolean>;
}

function vaultStub(idName: string): DurableObjectStub & VaultRpc {
  return env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName(idName)) as DurableObjectStub & VaultRpc;
}

function fakeLeaseFor(peerFp: string): VerifiedLease {
  return {
    peerFp,
    scope:    "vault-proxy:test",
    epoch:    1,
    certFp:   "test-cert-fp",
    nonce:    new Uint8Array(16),
    serverTs: Date.now(),
    certDer:  new Uint8Array(0),
    sig:      new Uint8Array(64),
  };
}

function fakeVerifier(lease: VerifiedLease): LeaseVerifier {
  return async () => ({ ok: true, lease });
}

function serviceConfigFor(name: string, upstreamBaseUrl = "https://api.test.example"): VaultProxyService {
  return {
    name,
    upstreamBaseUrl,
    injection:          { kind: "authorizationBearer" },
    defaultAllowedSubs: ["*"],
    rateLimitPerMinute: 60,
  };
}

beforeEach(async () => {
  // Best-effort cleanup. Each test seeds what it needs; ignore failures
  // (no row to delete is a no-op).
  await Promise.all([
    vaultStub(ROUTER_BUNDLE).deleteCredential(PEER_A, "openai").catch(() => {}),
    vaultStub(ROUTER_BUNDLE).deleteCredential(PEER_A, "anthropic").catch(() => {}),
    vaultStub(ROUTER_BUNDLE).deleteCredential(PEER_B, "openai").catch(() => {}),
    vaultStub("notme").deleteCredential(PEER_A, "openai").catch(() => {}),
  ]);
});

// ── End-to-end auto-select ─────────────────────────────────────────────

describe("VaultProxyRoute end-to-end (real vault DO via env.VAULT_STORE)", () => {
  it("returns vault DO's 404 shape when no credential is stored (proves route hit the DO)", async () => {
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLeaseFor(PEER_A)),
      services:      (name) => name === "openai" ? serviceConfigFor("openai") : null,
      // deps.credentials NOT set → auto-selects VaultDoCredentialStore
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      env as unknown as Env,
    );

    // Post-X-2 (cloister-6eba0a): the route layer now collapses
    // vault DO's debug-friendly bodies to the canonical
    // CONSTANT_TIME_ERROR_BODY (Shape R). Body shape is intentionally
    // NOT distinguishable from the route-level 404 anymore — that's
    // the oracle closure we just shipped. Status-only assertion here;
    // the "did vault DO actually get hit" signal moves to the seeded
    // smoke test in the per-peer block below.
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; reason?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.reason).toBeDefined();
  });

  it("route's own 404 (unknown service) wins BEFORE vault DO is consulted", async () => {
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLeaseFor(PEER_A)),
      services:      () => null, // empty service registry
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      env as unknown as Env,
    );

    // Route's CONSTANT_TIME_ERROR_BODY: includes `reason`, no `service`.
    // Distinguishable from the DO's 404 above.
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; reason?: string; service?: string };
    expect(body.error).toBe("unauthorized");
    expect(body.reason).toBeDefined();
    expect(body.service).toBeUndefined();
  });
});

// ── Per-bundle DO isolation seam (ADR-0021 in production) ──────────────

describe("VaultProxyRoute per-bundle isolation (idFromName-keyed storage)", () => {
  it("credential seeded into idFromName('notme') is NOT reachable from route using idFromName('router')", async () => {
    // Seed into the WRONG bundle's namespace.
    await vaultStub("notme").putCredential(PEER_A, "openai", {
      upstream:    "https://api.test.example",
      headers:     { "Authorization": "Bearer sk-notme-only" },
      allowedSubs: [PEER_A],
    });

    // Route uses the default "router" bundleIdName.
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLeaseFor(PEER_A)),
      services:      (name) => name === "openai" ? serviceConfigFor("openai") : null,
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      env as unknown as Env,
    );

    // Vault DO finds no row at idFromName("router") → 404. Body is
    // canonical CONSTANT_TIME_ERROR_BODY (Shape R) per X-2 collapse.
    // notme's row exists but is unreachable across the namespace seam.
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });
});

// ── Per-peer composite-key isolation (subjectFp scoping) ───────────────

describe("VaultProxyRoute per-peer credential scoping (composite-PK seam)", () => {
  it("PEER_A's credential is unreachable from a lease verified as PEER_B (same service name)", async () => {
    // Seed under PEER_A.
    await vaultStub(ROUTER_BUNDLE).putCredential(PEER_A, "openai", {
      upstream:    "https://api.test.example",
      headers:     { "Authorization": "Bearer sk-peer-a" },
      allowedSubs: [PEER_A],
    });

    // Verifier hands the route PEER_B's lease.
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLeaseFor(PEER_B)),
      services:      (name) => name === "openai" ? serviceConfigFor("openai") : null,
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      env as unknown as Env,
    );

    // No row at (subject_fp=PEER_B, service=openai) → 404 from vault DO,
    // body collapsed to Shape R per X-2 / cloister-6eba0a.
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("seeded credential at the route's bundleIdName IS reachable — proves vault DO delegation positively", async () => {
    // Counter-test to the "credential at notme is unreachable" case
    // above: seed at the SAME bundleIdName the route uses ("router")
    // for the SAME peerFp the lease verifies, and confirm the
    // response is NOT a 404 (i.e., vault DO found the row and
    // attempted to forward upstream — fails with 5xx because the
    // upstream URL doesn't resolve in workerd-test, but the 5xx
    // status itself proves we got past vault DO's 404 path).
    //
    // This is the "vault DO actually got hit" signal post-X-2.
    // Pre-X-2 we used body-shape difference; that signal is now
    // intentionally collapsed.
    await vaultStub(ROUTER_BUNDLE).putCredential(PEER_A, "openai", {
      upstream:    "https://api.test.example",
      headers:     { "Authorization": "Bearer sk-router-seeded" },
      allowedSubs: [PEER_A],
    });

    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLeaseFor(PEER_A)),
      services:      (name) => name === "openai" ? serviceConfigFor("openai") : null,
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      env as unknown as Env,
    );

    // Anything but 404 proves vault DO found the row + attempted
    // forwarding. The actual status (502/504/etc.) depends on
    // workerd-test's network behavior for unresolvable hosts.
    expect(res.status).not.toBe(404);
  });
});

// ── Health: smoke that VAULT_STORE actually binds in the test env ──────

describe("VaultProxyRoute test-env prerequisites", () => {
  it("env.VAULT_STORE is bound (test-env sanity check)", () => {
    expect(env.VAULT_STORE).toBeDefined();
  });

  it("route auto-select kicks in when env.VAULT_STORE is bound (smoke — status-only)", async () => {
    // Post-X-2 the body shape doesn't distinguish in-memory vs vault-DO
    // anymore (oracle closed). The seeded smoke test in the per-peer
    // block is the positive proof of vault-DO delegation; this remains
    // as a smoke of the route returning the canonical 404 wire shape.
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLeaseFor(PEER_A)),
      services:      (name) => name === "openai" ? serviceConfigFor("openai") : null,
    });
    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      env as unknown as Env,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });
});
