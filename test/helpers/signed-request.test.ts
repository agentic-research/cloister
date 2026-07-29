/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAndUpsertLease } from "../../src/routes/lease-middleware.js";
import { MASTER_PUBKEY_B64_STD } from "../wire/fixtures/cert-chain.js";
import { CERT_ADMIN_B64, DEFAULT_NOW_MS, signedMcpRequest } from "./signed-request.js";

// Smoke test for the signing helper itself: a request minted by
// signedMcpRequest must pass through verifyAndUpsertLease cleanly.
// If this test fails, every mcp.test.ts integration that uses the
// helper will fail downstream — so this is the gate.

beforeEach(async () => {
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
});

const BUNDLE = {
  epoch:    7,
  seqno:    1,
  keys:     { active: MASTER_PUBKEY_B64_STD },
  keyId:    "active",
  issuedAt: 1_700_000_050,
  signature: "",
};

describe("signedMcpRequest helper", () => {
  it("mints a request that passes verifyAndUpsertLease end-to-end", async () => {
    const { request, body } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
    });

    const result = await verifyAndUpsertLease({
      req: request,
      body,
      id: 1,
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      env,
      bundle: BUNDLE,
      nowMs: DEFAULT_NOW_MS,
    });

    if ("code" in result) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    expect(result.peerFp).toBe("sha256:abc123def456");
    expect(result.scope).toBe("bead_create:/repos/foo");
  });

  it("uses fresh nonces across calls so the second pass also verifies", async () => {
    const r1 = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
    });
    const r2 = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
    });

    const args = (sr: { request: Request; body: string }) => ({
      req: sr.request,
      body: sr.body,
      id: 1,
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      env, bundle: BUNDLE, nowMs: DEFAULT_NOW_MS,
    });

    const v1 = await verifyAndUpsertLease(args(r1));
    const v2 = await verifyAndUpsertLease(args(r2));
    if ("code" in v1) throw new Error(`first failed: ${v1.message}`);
    if ("code" in v2) throw new Error(`second failed: ${v2.message}`);
  });

  it("respects an explicit tsMs override", async () => {
    // Fixture cert grants `bead_create:/repos/foo`; this test exercises
    // the ts override, not the scope grammar.
    const customTs = (1_700_000_000 + 50) * 1000;  // 50s into validity
    const { request, body } = await signedMcpRequest({
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      tsMs: customTs,
    });
    expect(request.headers.get("x-signet-ts")).toBe(String(customTs));

    const result = await verifyAndUpsertLease({
      req: request, body, id: 1,
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/foo" } },
      env, bundle: BUNDLE,
      nowMs: customTs,
    });
    if ("code" in result) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  });

  it("can sign with an explicit admin proof cert", async () => {
    const { request, body } = await signedMcpRequest({
      method: "tools/list",
      certB64: CERT_ADMIN_B64,
    });

    const result = await verifyAndUpsertLease({
      req: request,
      body,
      id: 1,
      method: "tools/list",
      params: undefined,
      env,
      bundle: BUNDLE,
      nowMs: DEFAULT_NOW_MS,
    });

    if ("code" in result) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    expect(result.scope).toBe("*");
  });

  // ── MRTR retry semantics (SEP-2322 / cloister-db14c3) ───────────────────
  //
  // MRTR: the server returns input_required; the client RETRIES THE ORIGINAL
  // REQUEST with inputResponses attached. Replay protection and MRTR compose
  // by construction — the retry body differs, so it is freshly signed with a
  // fresh nonce and seen_nonces never sees a duplicate.
  //
  // Pinned as a PAIR so neither half can pass vacuously: a properly re-signed
  // retry must PASS (proving the harness can produce a valid retry at all),
  // and a retry reusing the original nonce must FAIL. Without the first, the
  // second proves only that something rejected something.
  describe("MRTR retry", () => {
    const ORIGINAL = { name: "bead_create", arguments: { repo: "/repos/foo" } };
    const RETRY    = { ...ORIGINAL, inputResponses: [{ requestId: "r1", value: "yes" }] };
    const verify = (r: { request: Request; body: string }, params: unknown) =>
      verifyAndUpsertLease({
        req: r.request, body: r.body, id: 1, method: "tools/call", params,
        env, bundle: BUNDLE, nowMs: DEFAULT_NOW_MS,
      });

    it("a properly re-signed retry (fresh nonce) passes", async () => {
      const first = await signedMcpRequest({ method: "tools/call", params: ORIGINAL });
      expect("code" in (await verify(first, ORIGINAL))).toBe(false);

      const retry = await signedMcpRequest({ method: "tools/call", params: RETRY });
      const result = await verify(retry, RETRY);
      if ("code" in result) throw new Error(`retry should pass, got ${result.code}: ${result.message}`);
      expect(result.scope).toBe("bead_create:/repos/foo");
    });

    it("a retry reusing the original nonce is rejected", async () => {
      const nonce = new Uint8Array(16).fill(9);
      const first = await signedMcpRequest({ method: "tools/call", params: ORIGINAL, nonce });
      expect("code" in (await verify(first, ORIGINAL))).toBe(false);

      // Same nonce, new body — what an implementation produces if it treats
      // the retry as "the same request continued" rather than a new one.
      const retry = await signedMcpRequest({ method: "tools/call", params: RETRY, nonce });
      const result = await verify(retry, RETRY);
      expect("code" in result).toBe(true);
      if (!("code" in result)) return;
      expect(result.code).toBe(-32004);  // ERR_REPLAY
    });
  });
});
