/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Gap-2 proof (cloister-caab2d / ADR-0040 named risk).
//
// Everything else in the vault-proxy suite stubs the lease verifier
// (`fakeVerifier`). This file drives the REAL `verifyAndUpsertLease` pipeline
// through `VaultProxyRoute` — real cert-chain verify, real Web Crypto Ed25519
// signature check, real scope + replay, real workerd TRUST_STORE DO. Only the
// CA-bundle *fetch* is replaced with an injected test bundle (bundle fetching
// is covered separately in ca-bundle tests); the crypto that gates the proxy
// is not stubbed.
//
// Critically, the request is signed by `src/harness-shim/lease-signer.ts` —
// the SAME signer the harness shim uses in production. So this test proves the
// signer↔gate contract end-to-end: a shim-signed request passes the live gate
// and the vaulted credential is injected upstream; a tampered signature is
// rejected 401.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { VaultProxyRoute, type LeaseVerifier } from "../../src/routes/vault-proxy-route.js";
import { verifyAndUpsertLease } from "../../src/routes/lease-middleware.js";
import { InMemoryCredentialStore } from "../../src/routes/vault-proxy-credential-store.js";
import type { UpstreamFetcher, VaultProxyService } from "../../src/routes/vault-proxy.js";
import type { CABundle } from "../../src/storage/ca-bundle-cache.js";
import type { Env } from "../../src/types.js";
import { signLeaseHeaders, type EphemeralIdentity } from "../../src/harness-shim/lease-signer.js";
import {
  CERT_ADMIN_B64,
  EPHEMERAL_PRIV_SEED_B64,
  EPHEMERAL_PUBKEY_B64,
  MASTER_PUBKEY_B64_STD,
  NOT_BEFORE,
} from "../wire/fixtures/cert-chain.js";

// The admin fixture cert: peer_fp = sha256:abc123def456, scope = "*", epoch 7.
// Scope "*" is required because the vault proxy derives scope
// `unknown:vaultProxy` (its route isn't JSON-RPC-shaped), which only an admin
// wildcard cert grants. The fixture comments flag it as "used only by local
// proof harnesses" — exactly this.
const ADMIN_IDENTITY: EphemeralIdentity = {
  certB64:     CERT_ADMIN_B64,
  privSeedB64: EPHEMERAL_PRIV_SEED_B64,
  pubKeyB64:   EPHEMERAL_PUBKEY_B64,
};
const ADMIN_PEER_FP = "sha256:abc123def456";

// A URL already in normalized form so `new Request(url).url === url` — the
// signature binds the exact URL the server observes.
const CLOISTER_URL = "https://cloister.test/vault/proxy/openai/v1/chat/completions";
const HAPPY_NOW_MS = (NOT_BEFORE + 100) * 1000;
const VAULTED_KEY = "sk-vaulted-openai-secret";

function fixedNonce(seed: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (seed + i * 31) & 0xff;
  return out;
}

function openaiService(): VaultProxyService {
  return {
    name:               "openai",
    upstreamBaseUrl:    "https://api.openai.com",
    injection:          { kind: "authorizationBearer" },
    defaultAllowedSubs: [ADMIN_PEER_FP],
    rateLimitPerMinute: 0,
  };
}

// Real verifier, bundle injected + clock pinned. This is `defaultLeaseVerifier`
// with the CA-bundle fetch swapped for `makeBundle()` and `nowMs` fixed so the
// fixture cert's validity window + signature line up deterministically.
function realVerifier(): LeaseVerifier {
  const bundle: CABundle = {
    epoch:     7,
    seqno:     1,
    keys:      { active: MASTER_PUBKEY_B64_STD },
    keyId:     "active",
    issuedAt:  1_700_000_050,
    signature: "",
  };
  return async (request, verifierEnv, parsed) => {
    const body = request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.clone().text();
    const verdict = await verifyAndUpsertLease({
      req: request, body, id: 0, method: "vaultProxy",
      params: parsed ?? {}, env: verifierEnv, bundle, nowMs: HAPPY_NOW_MS,
    });
    if ("code" in verdict) return { ok: false, status: 401 };
    return { ok: true, lease: verdict };
  };
}

function buildRoute(upstream: UpstreamFetcher): VaultProxyRoute {
  const credentials = new InMemoryCredentialStore();
  credentials.set(ADMIN_PEER_FP, "openai", { credential: VAULTED_KEY });
  return new VaultProxyRoute({
    credentials,
    services:      (name) => (name === "openai" ? openaiService() : null),
    upstream,
    leaseVerifier: realVerifier(),
  });
}

// Same replay-state reset the lease-middleware integration test uses — the
// seen_nonces ledger is durable across tests within the DO.
beforeEach(async () => {
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
});

describe("vault proxy — real lease gate (shim-signed)", () => {
  it("shim-signed request passes the live gate and the vaulted key is injected upstream", async () => {
    const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const headers = await signLeaseHeaders({
      method: "POST", url: CLOISTER_URL, body,
      identity: ADMIN_IDENTITY, tsMs: HAPPY_NOW_MS, nonce: fixedNonce(1),
    });

    let capturedAuth: string | null = null;
    const upstream: UpstreamFetcher = {
      fetch: async (r) => {
        capturedAuth = r.headers.get("authorization");
        return new Response("data: ok\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    };

    const req = new Request(CLOISTER_URL, {
      method: "POST", headers: new Headers(Object.entries(headers)), body,
    });
    const res = await buildRoute(upstream).handle(req, env as unknown as Env);

    expect(res.status).toBe(200);
    // The harness's request carried NO OpenAI key; the gate injected the
    // vaulted one on the way upstream. That is the credential isolation.
    expect(capturedAuth).toBe(`Bearer ${VAULTED_KEY}`);
  });

  it("tampered signature is rejected 401 (gate is real)", async () => {
    const body = JSON.stringify({ model: "gpt-4o", messages: [] });
    const headers = await signLeaseHeaders({
      method: "POST", url: CLOISTER_URL, body,
      identity: ADMIN_IDENTITY, tsMs: HAPPY_NOW_MS, nonce: fixedNonce(2),
    });
    // Flip the last base64url char of the signature — still well-formed, but
    // no longer verifies against the canonical bytes.
    const sig = headers["x-signet-sig"];
    headers["x-signet-sig"] = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");

    let upstreamCalled = false;
    const upstream: UpstreamFetcher = {
      fetch: async () => { upstreamCalled = true; return new Response("nope", { status: 200 }); },
    };

    const req = new Request(CLOISTER_URL, {
      method: "POST", headers: new Headers(Object.entries(headers)), body,
    });
    const res = await buildRoute(upstream).handle(req, env as unknown as Env);

    expect(res.status).toBe(401);
    expect(upstreamCalled).toBe(false);
  });

  it("bare request with no lease headers (stock harness) is rejected 401", async () => {
    const body = JSON.stringify({ model: "gpt-4o", messages: [] });
    let upstreamCalled = false;
    const upstream: UpstreamFetcher = {
      fetch: async () => { upstreamCalled = true; return new Response("nope", { status: 200 }); },
    };

    const req = new Request(CLOISTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await buildRoute(upstream).handle(req, env as unknown as Env);

    expect(res.status).toBe(401);
    expect(upstreamCalled).toBe(false);
  });
});
