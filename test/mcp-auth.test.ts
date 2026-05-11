/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { McpEdgeRoute } from "../src/routes/mcp.js";
import type { Env } from "../src/types.js";
import { MASTER_PUBKEY_B64_STD, NOT_BEFORE } from "./wire/fixtures/cert-chain.js";
import { signedMcpRequest, DEFAULT_NOW_MS } from "./helpers/signed-request.js";
import { _resetCache } from "../src/storage/ca-bundle-cache.js";
import { bundleCanonical } from "../src/storage/bundle-canonical.js";

// ── Lease enforcement integration: mcp.ts pipeline end-to-end ──────────
//
// These tests bypass SELF.fetch and call McpEdgeRoute.handle directly.
// Reason: SELF uses the project's `env` (no INTERLACE_ROOT_PUBKEY set),
// so the lease gate is skipped. To exercise the gate we need an env
// where the binding IS set, AND a service-binding stub for NOTME that
// serves a valid signed bundle.

beforeEach(async () => {
  // Reset TrustStore tables AND module-level CA bundle cache so each
  // test starts from a clean slate. Without the cache reset, a notme
  // stub that returned a valid bundle in test N would still be cached
  // in test N+1's getCABundle call, masking the "notme unreachable"
  // failure-mode test.
  _resetCache();
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
});

// ── Helpers ────────────────────────────────────────────────────────────

async function makeRootKey(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  const bytes = new Uint8Array(raw);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return { privateKey: kp.privateKey, publicKeyB64: btoa(bin) };
}

async function makeBundleResponder(root: CryptoKey) {
  // notme-side: serve a signed bundle whose `active` key is the same
  // master that the gen-fixture script used to mint CERT_FULL_B64.
  const base = {
    epoch:    7,
    seqno:    1,
    keys:     { active: MASTER_PUBKEY_B64_STD },
    keyId:    "active",
    issuedAt: 1_700_000_050,
  };
  const sig = new Uint8Array(
    (await crypto.subtle.sign(
      "Ed25519", root,
      bundleCanonical({ ...base, signature: "" }) as BufferSource,
    )) as ArrayBuffer,
  );
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]!);
  return { ...base, signature: btoa(bin) };
}

function envWith(over: Partial<Env>, notmeResponder?: (req: Request) => Promise<Response>): Env {
  return Object.assign({}, env, {
    NOTME: notmeResponder
      ? { fetch: notmeResponder } as unknown as Env["NOTME"]
      : env.NOTME,
    ...over,
  }) as Env;
}

const TIME_NEAR_NOW = DEFAULT_NOW_MS;  // Inside cert validity window.

// ── Skip path: INTERLACE_ROOT_PUBKEY unset → lease check disabled ──────

describe("McpEdgeRoute.handlePost — lease gate (INTERLACE_ROOT_PUBKEY unset)", () => {
  it("processes unauth POST /mcp normally when root pubkey is unset (dev/test mode)", async () => {
    const route = new McpEdgeRoute([]);
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await route.handle(req, envWith({}));  // no INTERLACE_ROOT_PUBKEY
    expect(res.status).toBe(200);
    const body = await res.json() as { result: unknown };
    expect(body.result).toEqual({});
  });
});

// ── Enforce path: gate-on → reject unauth, accept signed envelopes ─────

describe("McpEdgeRoute.handlePost — lease gate (INTERLACE_ROOT_PUBKEY set)", () => {
  it("rejects POST /mcp with no auth headers → ERR_UNAUTHENTICATED (401)", async () => {
    const root = await makeRootKey();
    const bundle = await makeBundleResponder(root.privateKey);
    const route = new McpEdgeRoute([]);

    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    const res = await route.handle(req, envWith(
      { INTERLACE_ROOT_PUBKEY: root.publicKeyB64 },
      async () => Response.json(bundle),
    ));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32001);  // ERR_UNAUTHENTICATED
  });

  it("rejects POST with malformed auth (bad cert) → ERR_UNAUTHENTICATED", async () => {
    const root = await makeRootKey();
    const bundle = await makeBundleResponder(root.privateKey);
    const route = new McpEdgeRoute([]);
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: {
        "content-type":   "application/json",
        "authorization":  "Signet not_a_real_cert_just_some_bytes",
        "x-signet-sig":   "AAAA",
        "x-signet-ts":    String(TIME_NEAR_NOW),
        "x-signet-nonce": "AAAA",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await route.handle(req, envWith(
      { INTERLACE_ROOT_PUBKEY: root.publicKeyB64 },
      async () => Response.json(bundle),
    ));
    expect(res.status).toBe(401);
  });

  it("returns 503 ERR_CA_UNAVAILABLE when notme is unreachable", async () => {
    const root = await makeRootKey();  // we DO have a pubkey
    const route = new McpEdgeRoute([]);

    const { request } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
    });

    // notme stub returns 503 — fetcher returns null → CaUnavailableError.
    const res = await route.handle(request, envWith(
      { INTERLACE_ROOT_PUBKEY: root.publicKeyB64 },
      async () => new Response("nope", { status: 503 }),
    ));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32005);  // ERR_CA_UNAVAILABLE
  });

  it("happy path: signed envelope with real Date.now() passes the full pipeline", async () => {
    // cloister-2197d8 fix made this possible: cert validity now runs
    // through 2049-12-31, so wall-clock Date.now() falls inside the
    // window. signedMcpRequest signs canonical bytes with the fixture's
    // ephemeral key at `tsMs: Date.now()`, so clock-skew passes too.
    //
    // 2026-05-10 cloister-492c08: this test previously expected -32601
    // ("unknown tool") because McpEdgeRoute had no backends registered
    // and `bead_create` fell through to the post-gate dispatch error.
    // The cross-DO orchestrator interceptor now handles `bead_create`
    // INSIDE McpEdgeRoute (regardless of backends), so the call now
    // succeeds end-to-end: BlobStore.put → BeadStore.bead_create →
    // TrustStore.applyAttestation. The new "lease gate passed" signal
    // is "HTTP 200 with a successful bead-create result body".
    _resetCache();
    const root = await makeRootKey();
    const bundle = await makeBundleResponder(root.privateKey);
    const route = new McpEdgeRoute([]);

    const { request } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      tsMs: Date.now(),  // real wall-clock — works because cert.not_after = 2049
    });

    const res = await route.handle(request, envWith(
      { INTERLACE_ROOT_PUBKEY: root.publicKeyB64 },
      async () => Response.json(bundle),
    ));

    // The orchestrator ran end-to-end. HTTP 200 + a success body with
    // the bead id and content_hash. Had the lease gate REJECTED we'd
    // see a 4xx with a lease-error code (-32001/3/5).
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { content?: { type: string; text: string }[] }; error?: { code: number } };
    expect(body.error).toBeUndefined();
    expect(body.result?.content?.[0]?.type).toBe("text");
    const orchestratorResult = JSON.parse(body.result!.content![0]!.text) as {
      id: string;
      content_hash: string;
      state: string;
    };
    expect(orchestratorResult.id).toMatch(/^[0-9a-f]{8}$/);
    expect(orchestratorResult.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(orchestratorResult.state).toBe("open");
  });

  it("CORS Access-Control-Allow-Origin is set on lease-error responses", async () => {
    const root = await makeRootKey();
    const bundle = await makeBundleResponder(root.privateKey);
    const route = new McpEdgeRoute([]);

    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: {
        "content-type":   "application/json",
        "origin":         "https://example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await route.handle(req, envWith(
      { INTERLACE_ROOT_PUBKEY: root.publicKeyB64, ALLOWED_ORIGINS: "https://example.com" },
      async () => Response.json(bundle),
    ));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });
});
