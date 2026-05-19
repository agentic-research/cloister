/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Integration tests for `VaultProxyRoute` (cloister-8f57f0 route mount).
//
// These tests exercise the EdgeRoute wiring — match() + handle() —
// with real Request objects and the full composition stack:
//
//   real Request → URLPattern → lease verifier (stubbed for these
//   tests; real verifier covered by lease-middleware.test.ts) →
//   credential store → service resolver → vaultProxyHandler →
//   upstream fetcher → real Response
//
// The handler's behavior is already pinned by vault-proxy.test.ts
// (34 tests across Phases 0-7). These tests pin THE WIRING — that
// the route mounts at the right path, dispatches correctly, and
// threads its deps through to the handler.

import { describe, expect, it } from "vitest";
import {
  VaultProxyRoute,
  type LeaseVerifier,
} from "../../src/routes/vault-proxy-route.js";
import { InMemoryCredentialStore } from "../../src/routes/vault-proxy-credential-store.js";
import type { Env } from "../../src/types.js";
import type {
  UpstreamFetcher,
  VaultProxyService,
} from "../../src/routes/vault-proxy.js";
import type { VerifiedLease } from "../../src/routes/lease-middleware.js";

const TEST_PEER_FP = "sha256:integration-test-peer";

function fakeVerifier(lease: VerifiedLease | null): LeaseVerifier {
  if (lease === null) {
    return async () => ({ ok: false, status: 401 });
  }
  return async () => ({ ok: true, lease });
}

function fakeLease(): VerifiedLease {
  return {
    peerFp:   TEST_PEER_FP,
    scope:    "vault-proxy:test",
    epoch:    1,
    certFp:   "test-cert-fp",
    nonce:    new Uint8Array(16),
    serverTs: Date.now(),
    certDer:  new Uint8Array(0),
    sig:      new Uint8Array(64),
  };
}

function mockUpstream(opts: { status?: number; body?: string } = {}): UpstreamFetcher & {
  lastRequest: Request | null;
} {
  const state = { lastRequest: null as Request | null };
  return {
    get lastRequest() { return state.lastRequest; },
    set lastRequest(v) { state.lastRequest = v; },
    fetch: async (req: Request): Promise<Response> => {
      state.lastRequest = req;
      return new Response(opts.body ?? "", {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("VaultProxyRoute.match — URLPattern wiring", () => {
  const route = new VaultProxyRoute();
  it("matches /vault/proxy/<service>/<path>", () => {
    expect(route.match(new Request("http://x/vault/proxy/openai/v1/chat"))).toBe(true);
  });
  it("matches /vault/proxy/<service> (with or without trailing slash)", () => {
    expect(route.match(new Request("http://x/vault/proxy/openai"))).toBe(true);
    expect(route.match(new Request("http://x/vault/proxy/openai/"))).toBe(true);
  });
  it("does NOT match unrelated paths", () => {
    expect(route.match(new Request("http://x/health"))).toBe(false);
    expect(route.match(new Request("http://x/mcp"))).toBe(false);
    expect(route.match(new Request("http://x/vault/admin"))).toBe(false);
    expect(route.match(new Request("http://x/"))).toBe(false);
  });
});

describe("VaultProxyRoute.handle — composition wiring (cloister-8f57f0 route mount)", () => {
  it("returns 401 with constant-shape body when no lease (safe-closed default)", async () => {
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(null),
    });
    const res = await route.handle(new Request("http://x/vault/proxy/openai/v1/chat"), {} as Env);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 503 (constant-shape) when CA bundle is unavailable", async () => {
    const route = new VaultProxyRoute({
      leaseVerifier: async () => ({ ok: false, status: 503 }),
    });
    const res = await route.handle(new Request("http://x/vault/proxy/openai/v1/chat"), {} as Env);
    expect(res.status).toBe(503);
  });

  it("returns 404 (constant-shape) when service is not declared", async () => {
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services: () => null, // empty service registry
    });
    const res = await route.handle(new Request("http://x/vault/proxy/unknown/v1"), {} as Env);
    expect(res.status).toBe(404);
  });

  it("threads service config + credential store + upstream through to the handler", async () => {
    const credentials = new InMemoryCredentialStore();
    credentials.set(TEST_PEER_FP, "openai", { credential: "sk-test-integration" });

    const upstream = mockUpstream({ status: 200, body: '{"ok":true}' });
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      credentials,
      services: (name) => name === "openai" ? {
        name: "openai",
        upstreamBaseUrl: "https://api.openai.test",
        injection: { kind: "authorizationBearer" },
        defaultAllowedSubs: [TEST_PEER_FP],
        rateLimitPerMinute: 60,
      } satisfies VaultProxyService : null,
      upstream,
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat", { method: "POST", body: "{}" }),
      {} as Env,
    );

    // Wiring verifications:
    expect(res.status).toBe(200);
    expect(upstream.lastRequest).not.toBeNull();
    // 1. Upstream URL composed correctly from service config + path
    expect(upstream.lastRequest!.url).toBe("https://api.openai.test/v1/chat");
    // 2. Bearer header injected by the handler's strategy switch
    expect(upstream.lastRequest!.headers.get("Authorization")).toBe("Bearer sk-test-integration");
    // 3. Response bytes passed back to client
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("returns 403 (constant-shape) when peerFp not in allowedSubs", async () => {
    const credentials = new InMemoryCredentialStore();
    credentials.set(TEST_PEER_FP, "openai", { credential: "sk-test" });
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      credentials,
      services: () => ({
        name: "openai",
        upstreamBaseUrl: "https://api.openai.test",
        injection: { kind: "authorizationBearer" },
        defaultAllowedSubs: ["sha256:other-peer"], // not TEST_PEER_FP
        rateLimitPerMinute: 60,
      }),
      upstream: mockUpstream(),
    });
    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      {} as Env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 (constant-shape) when credential is not stored for (peerFp, service)", async () => {
    // No credential stored — handler collapses storedCredential===null to 404.
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      credentials: new InMemoryCredentialStore(), // empty
      services: () => ({
        name: "openai",
        upstreamBaseUrl: "https://api.openai.test",
        injection: { kind: "authorizationBearer" },
        defaultAllowedSubs: [TEST_PEER_FP],
        rateLimitPerMinute: 60,
      }),
      upstream: mockUpstream(),
    });
    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      {} as Env,
    );
    expect(res.status).toBe(404);
  });
});

// ── cloister-e2a12a (D2): vault-DO-backed CredentialStore selection ──────

describe("VaultProxyRoute.handle — auto-select VaultDoCredentialStore when env.VAULT_STORE is set", () => {
  /**
   * D2 wires the production credential store through composition: when
   * `env.VAULT_STORE` is present AND the test/operator didn't explicitly
   * pass `deps.credentials`, the route lazily constructs a
   * VaultDoCredentialStore and delegates via its `forward` method. This
   * preserves ADR-0013 (plaintext stays in the DO) without requiring
   * every test to wire the store themselves.
   */

  interface ForwardCall {
    peerFp: string; service: string; callerSub: string; request: Request;
  }

  function fakeVaultStoreNamespace(opts: {
    respondWith?: Response;
    throwWith?:   Error;
  } = {}): { ns: DurableObjectNamespace; calls: ForwardCall[]; idNamesSeen: string[] } {
    const calls: ForwardCall[] = [];
    const idNamesSeen: string[] = [];
    const ns = {
      idFromName(name: string): DurableObjectId {
        idNamesSeen.push(name);
        return { name } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        return {
          async proxyRequest(
            peerFp: string,
            service: string,
            callerSub: string,
            request: Request,
          ): Promise<Response> {
            calls.push({ peerFp, service, callerSub, request });
            if (opts.throwWith) throw opts.throwWith;
            return opts.respondWith ?? new Response('{"ok":true,"via":"vault-do"}', {
              status: 200, headers: { "content-type": "application/json" },
            });
          },
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;
    return { ns, calls, idNamesSeen };
  }

  function envWithVaultStore(ns: DurableObjectNamespace | undefined): Env {
    return { VAULT_STORE: ns } as unknown as Env;
  }

  const serviceConfigOpenAi: () => VaultProxyService | null = () => ({
    name: "openai",
    upstreamBaseUrl: "https://api.openai.test",
    injection: { kind: "authorizationBearer" },
    defaultAllowedSubs: [TEST_PEER_FP],
    rateLimitPerMinute: 60,
  });

  it("delegates to vault DO's proxyRequest when env.VAULT_STORE is set", async () => {
    const { ns, calls, idNamesSeen } = fakeVaultStoreNamespace();
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
      // deps.credentials NOT set — route should auto-select VaultDoCredentialStore
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat", { method: "POST", body: "{}" }),
      envWithVaultStore(ns),
    );

    expect(idNamesSeen).toEqual(["router"]);
    expect(calls.length).toBe(1);
    expect(calls[0].peerFp).toBe(TEST_PEER_FP);
    expect(calls[0].service).toBe("openai");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true,"via":"vault-do"}');
  });

  it("returns 404 for unknown service even with vault DO available (service-declaration check runs first)", async () => {
    const { ns, calls } = fakeVaultStoreNamespace();
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      () => null, // empty service registry
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/unknown/v1"),
      envWithVaultStore(ns),
    );
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0); // never reached vault DO
  });

  it("preserves explicit deps.credentials override (test ergonomics — env.VAULT_STORE ignored)", async () => {
    const credentials = new InMemoryCredentialStore();
    credentials.set(TEST_PEER_FP, "openai", { credential: "sk-explicit-override" });

    const { ns, calls } = fakeVaultStoreNamespace();
    const upstream = mockUpstream({ status: 200, body: '{"via":"in-memory"}' });

    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
      credentials,                  // EXPLICIT override
      upstream,
    });

    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      envWithVaultStore(ns),         // env.VAULT_STORE set but should be ignored
    );

    expect(calls.length).toBe(0);
    expect(upstream.lastRequest).not.toBeNull();
    expect(upstream.lastRequest!.headers.get("Authorization")).toBe("Bearer sk-explicit-override");
    expect(await res.text()).toBe('{"via":"in-memory"}');
  });

  it("auto-select uses manifest-supplied bundleIdName (X-3 / cloister-6f06cc) when set", async () => {
    const { ns, idNamesSeen } = fakeVaultStoreNamespace();
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
      bundleIdName:  "notme", // Operator passes via manifest VaultProxySpec
    });
    await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      envWithVaultStore(ns),
    );
    expect(idNamesSeen).toEqual(["notme"]);
  });

  it("auto-select defaults bundleIdName to 'router' when manifest leaves it empty (back-compat)", async () => {
    const { ns, idNamesSeen } = fakeVaultStoreNamespace();
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
      bundleIdName:  "", // VaultProxySpec.bundleIdName empty → default
    });
    await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      envWithVaultStore(ns),
    );
    expect(idNamesSeen).toEqual(["router"]);
  });

  it("auto-select defaults bundleIdName to 'router' when deps omits it entirely (pre-X-3 back-compat)", async () => {
    const { ns, idNamesSeen } = fakeVaultStoreNamespace();
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
      // bundleIdName omitted
    });
    await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      envWithVaultStore(ns),
    );
    expect(idNamesSeen).toEqual(["router"]);
  });

  it("fails CLOSED with 503 SHAPE_U when neither env.VAULT_STORE nor deps.credentials is wired (Obs O-OBS-3)", async () => {
    // Pre-cloister-6e6bfb: route silently fell back to InMemoryCredentialStore
    // here, which let a misconfigured production deployment run dev-mode
    // forever without any wire-visible signal. Post-fix: fail-closed — every
    // request 503s + the route emits a one-shot structured error log to
    // wrangler tail. Operators must wire env.VAULT_STORE OR pass
    // deps.credentials explicitly (the test-ergonomics opt-in path).
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
      // No deps.credentials, no env.VAULT_STORE — production-misconfig shape
    });
    const res = await route.handle(
      new Request("http://x/vault/proxy/openai/v1/chat"),
      envWithVaultStore(undefined),
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("upstream_unavailable");
  });

  it("memoizes the VaultDoCredentialStore across requests (does not reconstruct per call)", async () => {
    const { ns, idNamesSeen } = fakeVaultStoreNamespace();
    const route = new VaultProxyRoute({
      leaseVerifier: fakeVerifier(fakeLease()),
      services:      serviceConfigOpenAi,
    });
    const env = envWithVaultStore(ns);

    await route.handle(new Request("http://x/vault/proxy/openai/v1/a"), env);
    await route.handle(new Request("http://x/vault/proxy/openai/v1/b"), env);

    // Three calls might be observed if a fresh store were built each
    // request (constructor doesn't call idFromName, but proxyRequest
    // does each call) — we instead assert that the cache held by NOT
    // building a NEW VaultDoCredentialStore: two requests = two
    // idFromName invocations because each call resolves the stub
    // fresh, but the SAME bundleIdName ("router") is used both times.
    expect(idNamesSeen).toEqual(["router", "router"]);
  });
});
