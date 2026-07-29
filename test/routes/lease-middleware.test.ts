/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ERR_BAD_REQUEST_SIG,
  ERR_CA_UNAVAILABLE,
  ERR_EPOCH_MISMATCH,
  ERR_SCOPE_DENIED,
  ERR_UNAUTHENTICATED,
  canonicalRequestBytes,
  certFingerprint,
  deriveRequestScope,
  leaseErrorResponse,
  parseAuthHeaders,
  scopeAllows,
  verifyAndUpsertLease,
} from "../../src/routes/lease-middleware.js";
import type { CABundle } from "../../src/storage/ca-bundle-cache.js";
import {
  CERT_FULL_B64,
  CERT_MINIMAL_B64,
  CERT_WRONG_MASTER_B64,
  MASTER_PUBKEY_B64_STD,
  NOT_AFTER,
  NOT_BEFORE,
  SAMPLE_BODY_JSON,
  SAMPLE_METHOD,
  SAMPLE_NEAR_NA_NONCE_B64,
  SAMPLE_NEAR_NA_SIG_B64,
  SAMPLE_NEAR_NA_TS_MS,
  SAMPLE_NEAR_NB_NONCE_B64,
  SAMPLE_NEAR_NB_SIG_B64,
  SAMPLE_NEAR_NB_TS_MS,
  SAMPLE_NONCE_B64,
  SAMPLE_SIG_B64,
  SAMPLE_TS_MS,
  SAMPLE_URL,
} from "../wire/fixtures/cert-chain.js";

// ── Fixture helpers ──────────────────────────────────────────────────────

function b64(bytes: number[] | Uint8Array): string {
  const arr = Array.isArray(bytes) ? new Uint8Array(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeReq(headers: Record<string, string> = {}, options: RequestInit = {}): Request {
  return new Request("http://x/mcp", { method: "POST", headers, ...options });
}

const VALID_CERT_B64  = b64(new Uint8Array(64).fill(0xAB));
const VALID_SIG_B64   = b64(new Uint8Array(64).fill(0xCD));
const VALID_NONCE_B64 = b64(new Uint8Array(16).fill(0xEF));

function validHeaders(): Record<string, string> {
  return {
    "authorization":  `Signet ${VALID_CERT_B64}`,
    "x-signet-sig":   VALID_SIG_B64,
    "x-signet-ts":    "1700000000000",
    "x-signet-nonce": VALID_NONCE_B64,
  };
}

// ── parseAuthHeaders ─────────────────────────────────────────────────────

describe("parseAuthHeaders", () => {
  it("parses all four headers when present and well-formed", () => {
    const req = makeReq(validHeaders());
    const result = parseAuthHeaders(req);
    if ("kind" in result) throw new Error(`expected ParsedAuthHeaders, got ${result.kind}`);
    expect(result.certDer.length).toBe(64);
    expect(result.sig.length).toBe(64);
    expect(result.ts).toBe(1_700_000_000_000);
    expect(result.nonce.length).toBe(16);
  });

  it("rejects missing Authorization header", () => {
    const h = validHeaders();
    delete h["authorization"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_authorization" });
  });

  it("rejects wrong scheme (Bearer instead of Signet)", () => {
    const h = validHeaders();
    h["authorization"] = `Bearer ${VALID_CERT_B64}`;
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "wrong_scheme", scheme: "Bearer" });
  });

  it("rejects Authorization with no space (no scheme)", () => {
    const h = validHeaders();
    h["authorization"] = VALID_CERT_B64;
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "wrong_scheme", scheme: VALID_CERT_B64 });
  });

  it("rejects bad base64 in Authorization", () => {
    const h = validHeaders();
    h["authorization"] = "Signet not!valid!base64!@#";
    const result = parseAuthHeaders(makeReq(h));
    if (!("kind" in result)) throw new Error("expected error");
    expect(result.kind).toBe("bad_base64");
  });

  it("rejects missing X-Signet-Sig", () => {
    const h = validHeaders();
    delete h["x-signet-sig"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_signature" });
  });

  it("rejects missing X-Signet-Ts", () => {
    const h = validHeaders();
    delete h["x-signet-ts"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_timestamp" });
  });

  it("rejects non-numeric X-Signet-Ts", () => {
    const h = validHeaders();
    h["x-signet-ts"] = "yesterday";
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_timestamp" });
  });

  it("rejects negative or zero X-Signet-Ts", () => {
    const h = validHeaders();
    h["x-signet-ts"] = "0";
    expect(parseAuthHeaders(makeReq(h))).toEqual({ kind: "missing_timestamp" });
    h["x-signet-ts"] = "-100";
    expect(parseAuthHeaders(makeReq(h))).toEqual({ kind: "missing_timestamp" });
  });

  it("rejects missing X-Signet-Nonce", () => {
    const h = validHeaders();
    delete h["x-signet-nonce"];
    const result = parseAuthHeaders(makeReq(h));
    expect(result).toEqual({ kind: "missing_nonce" });
  });
});

// ── canonicalRequestBytes ────────────────────────────────────────────────

describe("canonicalRequestBytes", () => {
  it("produces deterministic bytes for the same inputs", () => {
    const nonce = new Uint8Array(16).fill(0xAB);
    const a = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":1}');
    const b = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":1}');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("changes when any input changes", () => {
    const nonce = new Uint8Array(16).fill(0xAB);
    const base       = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":1}');
    const diffMethod = canonicalRequestBytes("GET",  "http://x/mcp", 1000, nonce, '{"a":1}');
    const diffUrl    = canonicalRequestBytes("POST", "http://x/health", 1000, nonce, '{"a":1}');
    const diffTs     = canonicalRequestBytes("POST", "http://x/mcp", 1001, nonce, '{"a":1}');
    const diffNonce  = canonicalRequestBytes("POST", "http://x/mcp", 1000, new Uint8Array(16).fill(0xCD), '{"a":1}');
    const diffBody   = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, '{"a":2}');

    const baseStr = new TextDecoder().decode(base);
    expect(new TextDecoder().decode(diffMethod)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffUrl)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffTs)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffNonce)).not.toBe(baseStr);
    expect(new TextDecoder().decode(diffBody)).not.toBe(baseStr);
  });

  it("uses LF separators in the documented order", () => {
    const nonce = new Uint8Array(3).fill(0x00);  // base64-encodes to "AAAA" (no padding)
    const bytes = canonicalRequestBytes("POST", "http://x/mcp", 1000, nonce, "BODY");
    const text  = new TextDecoder().decode(bytes);
    expect(text).toBe("POST\nhttp://x/mcp\n1000\nAAAA\nBODY");
  });
});

// ── deriveRequestScope ──────────────────────────────────────────────────

describe("deriveRequestScope", () => {
  it("tools/list → tools:list", () => {
    expect(deriveRequestScope("tools/list", undefined)).toBe("tools:list");
  });

  it("tools/call name=X args.repo=R → X:R", () => {
    expect(deriveRequestScope("tools/call", { name: "bead_create", arguments: { repo: "/r/foo" } }))
      .toBe("bead_create:/r/foo");
  });

  // SEP-2575 methods (cloister-dabbe1). Before these entries existed, both
  // derived "unknown:<method>" — grantable only to a "*" cert, which the
  // grammar's own comment says should never be minted in production. Net:
  // server/discover (a spec MUST, intended as the FIRST call a client makes)
  // was scope-denied for every production cert whenever the gate enforced.
  it("server/discover → server:discover", () => {
    expect(deriveRequestScope("server/discover", undefined)).toBe("server:discover");
  });

  it("subscriptions/listen → subscriptions:listen", () => {
    expect(deriveRequestScope("subscriptions/listen", { subscriptions: ["toolsListChanged"] }))
      .toBe("subscriptions:listen");
  });

  it("a cert scoped server:discover grants exactly the derived discover scope", () => {
    // The grammar entry and the grant compose: this is what makes the spec's
    // MUST reachable by a NON-admin cert. Before, only "*" could pass.
    expect(scopeAllows("server:discover", deriveRequestScope("server/discover", undefined))).toBe(true);
    expect(scopeAllows("subscriptions:listen", deriveRequestScope("subscriptions/listen", undefined))).toBe(true);
    // And it grants nothing else — no accidental widening.
    expect(scopeAllows("server:discover", "tools:list")).toBe(false);
    expect(scopeAllows("server:discover", deriveRequestScope("tools/call", { name: "bead_list" }))).toBe(false);
  });

  it("genuinely unknown methods still derive the ungrantable unknown: scope", () => {
    // Deny-by-default is correct for methods the grammar has never heard of;
    // the fix for SEP-2575 methods must not accidentally open this up.
    expect(deriveRequestScope("some/new-method", undefined)).toBe("unknown:some/new-method");
  });

  it("tools/call name=X without repo → X:*", () => {
    expect(deriveRequestScope("tools/call", { name: "lsp_hover", arguments: { file: "/a.rs" } }))
      .toBe("lsp_hover:*");
    expect(deriveRequestScope("tools/call", { name: "tools/list" }))
      .toBe("tools/list:*");
  });

  it("tools/call without name → tools:call:no_name", () => {
    expect(deriveRequestScope("tools/call", {})).toBe("tools:call:no_name");
    expect(deriveRequestScope("tools/call", undefined)).toBe("tools:call:no_name");
  });

  it("unknown method → unknown:<method>", () => {
    expect(deriveRequestScope("foo/bar", undefined)).toBe("unknown:foo/bar");
  });
});

// ── scopeAllows ──────────────────────────────────────────────────────────

describe("scopeAllows", () => {
  it("admin '*' allows anything", () => {
    expect(scopeAllows("*", "bead_create:/r/foo")).toBe(true);
    expect(scopeAllows("*", "anything:goes")).toBe(true);
  });

  it("exact match allows", () => {
    expect(scopeAllows("bead_create:/r/foo", "bead_create:/r/foo")).toBe(true);
  });

  it("exact non-match rejects", () => {
    expect(scopeAllows("bead_create:/r/foo", "bead_create:/r/bar")).toBe(false);
    expect(scopeAllows("bead_create:/r/foo", "bead_close:/r/foo")).toBe(false);
  });

  it("'X:*' grants any 'X:something'", () => {
    expect(scopeAllows("bead_create:*", "bead_create:/r/foo")).toBe(true);
    expect(scopeAllows("bead_create:*", "bead_create:/r/bar")).toBe(true);
    expect(scopeAllows("bead_create:*", "bead_create:")).toBe(true);
  });

  it("'X:*' does NOT grant 'Y:something'", () => {
    expect(scopeAllows("bead_create:*", "bead_close:/r/foo")).toBe(false);
  });

  it("'X:*' does NOT grant bare 'X' (must include the colon)", () => {
    expect(scopeAllows("bead_create:*", "bead_create")).toBe(false);
  });
});

// ── leaseErrorResponse ──────────────────────────────────────────────────

describe("leaseErrorResponse", () => {
  it("returns 401 for unauthenticated codes", async () => {
    expect(leaseErrorResponse(1, ERR_UNAUTHENTICATED, "test").status).toBe(401);
    expect(leaseErrorResponse(1, ERR_BAD_REQUEST_SIG, "test").status).toBe(401);
  });

  it("returns 403 for scope_denied", async () => {
    const res = leaseErrorResponse(1, ERR_SCOPE_DENIED, "scope mismatch");
    expect(res.status).toBe(403);
  });

  it("returns 503 for ca_unavailable / epoch_mismatch", async () => {
    expect(leaseErrorResponse(1, ERR_CA_UNAVAILABLE, "test").status).toBe(503);
    expect(leaseErrorResponse(1, ERR_EPOCH_MISMATCH, "test").status).toBe(503);
  });

  it("body is JSON-RPC error envelope with the right code", async () => {
    const res = leaseErrorResponse("req-123", ERR_SCOPE_DENIED, "scope mismatch");
    const body = await res.json() as { jsonrpc: string; id: string; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("req-123");
    expect(body.error.code).toBe(ERR_SCOPE_DENIED);
    expect(body.error.message).toBe("scope mismatch");
  });
});

// ── certFingerprint ─────────────────────────────────────────────────────

describe("certFingerprint", () => {
  it("produces a 64-char hex digest", async () => {
    const fp = await certFingerprint(new Uint8Array([1, 2, 3]));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const a = await certFingerprint(new Uint8Array([1, 2, 3]));
    const b = await certFingerprint(new Uint8Array([1, 2, 3]));
    expect(a).toBe(b);
  });

  it("changes when input changes", async () => {
    const a = await certFingerprint(new Uint8Array([1, 2, 3]));
    const b = await certFingerprint(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});

// ── verifyAndUpsertLease (full integration) ─────────────────────────────
//
// Exercises the un-stubbed orchestrator end-to-end with a real wasm
// cert-chain verifier, real Web Crypto Ed25519 signature check, real CA
// bundle, and a real workerd TRUST_STORE binding. The fixture
// (test/wire/fixtures/cert-chain.ts) provides a cert + sample request +
// pre-computed Ed25519 signature; same cert + sig used here as the
// happy-path baseline, mutated for unhappy paths.

function makeBundle(overrides: Partial<CABundle> = {}): CABundle {
  return {
    epoch:    7,
    seqno:    1,
    keys:     { active: MASTER_PUBKEY_B64_STD },
    keyId:    "active",
    issuedAt: 1_700_000_050,
    signature: "",  // not verified at this layer
    ...overrides,
  };
}

function happyHeaders(): Record<string, string> {
  return {
    "authorization":  `Signet ${CERT_FULL_B64}`,
    "x-signet-sig":   SAMPLE_SIG_B64,
    "x-signet-ts":    String(SAMPLE_TS_MS),
    "x-signet-nonce": SAMPLE_NONCE_B64,
  };
}

const SAMPLE_PARAMS = {
  name: "bead_create",
  arguments: { repo: "/repos/foo" },
} as const;

// Pick a `nowMs` inside [not_before, not_after] — used by the primary
// "happy" envelope (SAMPLE_TS_MS sits 100s into the validity window).
const HAPPY_NOW_MS = (NOT_BEFORE + 100) * 1000;

// "Edge" envelopes (SAMPLE_NEAR_NB / NA) are signed at the validity
// window boundary, so a `nowMs` 5s outside the validity window is still
// within ±60s of their `ts` — passes clock-skew, fails validity.
const NEAR_NB_HAPPY_NOW_MS = SAMPLE_NEAR_NB_TS_MS;            // inside cert validity
const NEAR_NB_PAST_NOW_MS  = (NOT_BEFORE - 5) * 1000;          // 5s before not_before, 10s skew
const NEAR_NA_HAPPY_NOW_MS = SAMPLE_NEAR_NA_TS_MS;            // inside cert validity
const NEAR_NA_FUTURE_NOW_MS = (NOT_AFTER + 5)  * 1000;         // 5s past not_after, 10s skew

// Reset replay-defense + counter state between tests. The fixture's
// SAMPLE_NONCE_B64 is reused by every happy-path test; without this,
// the first test recording the (cert_fp, nonce) tuple causes every
// subsequent test to be rejected as a replay (correct production
// behavior, hostile to test ergonomics).
beforeEach(async () => {
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
});

describe("verifyAndUpsertLease", () => {
  it("happy path: full cert + valid sig + matching scope → VerifiedLease", async () => {
    const req  = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });
    const body = SAMPLE_BODY_JSON;

    const result = await verifyAndUpsertLease({
      req, body, id: 1,
      method: "tools/call",
      params: SAMPLE_PARAMS,
      env, bundle: makeBundle(),
      nowMs: HAPPY_NOW_MS,
    });

    if ("code" in result) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    expect(result.peerFp).toBe("sha256:abc123def456");
    expect(result.scope).toBe("bead_create:/repos/foo");
    expect(result.epoch).toBe(7);
    expect(result.certFp).toMatch(/^[0-9a-f]{64}$/);
    expect(result.serverTs).toBe(HAPPY_NOW_MS);
  });

  it("rejects missing Authorization header → ERR_UNAUTHENTICATED (401)", async () => {
    const h = happyHeaders();
    delete h["authorization"];
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: h });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_UNAUTHENTICATED });
  });

  it("rejects cert minted by a different master → ERR_UNAUTHENTICATED", async () => {
    const h = happyHeaders();
    h["authorization"] = `Signet ${CERT_WRONG_MASTER_B64}`;
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: h });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_UNAUTHENTICATED });
    if ("code" in result) {
      expect(result.message).toMatch(/cert chain verify failed/i);
    }
  });

  it("rejects cert missing required Interlace claims (peer_fp/scope/epoch)", async () => {
    // CERT_MINIMAL has no Interlace extensions → all three optional fields
    // come back undefined. Phase 1 mandates them.
    const h = happyHeaders();
    h["authorization"] = `Signet ${CERT_MINIMAL_B64}`;
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: h });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_UNAUTHENTICATED });
    if ("code" in result) {
      expect(result.message).toMatch(/missing required Interlace claims/i);
    }
  });

  it("rejects cert with epoch ahead of bundle → ERR_EPOCH_MISMATCH (503)", async () => {
    // Cert claims epoch=7; serve bundle.epoch=5 (cert > bundle = "claims newer than reality").
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle({ epoch: 5 }), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_EPOCH_MISMATCH });
  });

  it("rejects cert revoked (bundle.epoch > cert.epoch by more than rotation window)", async () => {
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    // Bundle two epochs ahead, no prevKeyId → cert.epoch=7 invalid.
    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle({ epoch: 9 }), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_EPOCH_MISMATCH });
  });

  it("accepts cert one epoch behind during rotation window (prevKeyId set)", async () => {
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    // bundle.epoch = 8, but prevKeyId points to the same master that
    // signed our cert at epoch 7. cert.epoch=7 is accepted.
    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle({
        epoch: 8,
        keyId: "next",
        prevKeyId: "active",
        keys: { active: MASTER_PUBKEY_B64_STD, next: "AA".repeat(32) },  // rotated to a new key
      }),
      nowMs: HAPPY_NOW_MS,
    });

    if ("code" in result) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    expect(result.epoch).toBe(7);
  });

  it("rejects when bundle has empty active key → ERR_CA_UNAVAILABLE (503)", async () => {
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle({ keys: {} }),  // active key id present but key missing
      nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_CA_UNAVAILABLE });
  });

  it("rejects request before cert.not_before → ERR_UNAUTHENTICATED", async () => {
    // Use the NEAR_NB edge envelope: ts = (not_before + 5s); nowMs 5s
    // before not_before is 10s skew (inside ±60s clock-skew window) so
    // the validity-window check fires, not clock-skew.
    const headers = {
      "authorization":  `Signet ${CERT_FULL_B64}`,
      "x-signet-sig":   SAMPLE_NEAR_NB_SIG_B64,
      "x-signet-ts":    String(SAMPLE_NEAR_NB_TS_MS),
      "x-signet-nonce": SAMPLE_NEAR_NB_NONCE_B64,
    };
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: NEAR_NB_PAST_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_UNAUTHENTICATED });
    if ("code" in result) expect(result.message).toMatch(/validity window/i);
  });

  it("rejects request after cert.not_after → ERR_UNAUTHENTICATED", async () => {
    // NEAR_NA edge envelope; same defense-in-depth setup as the not_before
    // test, just past the upper end.
    const headers = {
      "authorization":  `Signet ${CERT_FULL_B64}`,
      "x-signet-sig":   SAMPLE_NEAR_NA_SIG_B64,
      "x-signet-ts":    String(SAMPLE_NEAR_NA_TS_MS),
      "x-signet-nonce": SAMPLE_NEAR_NA_NONCE_B64,
    };
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: NEAR_NA_FUTURE_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_UNAUTHENTICATED });
    if ("code" in result) expect(result.message).toMatch(/validity window/i);
  });

  it("accepts request at the edge of validity (NEAR_NB envelope, nowMs inside window)", async () => {
    // Sanity: confirm the edge fixture itself works inside the window.
    // Without this, a regression in clock-skew could pass the
    // "rejects before not_before" test for the wrong reason.
    const headers = {
      "authorization":  `Signet ${CERT_FULL_B64}`,
      "x-signet-sig":   SAMPLE_NEAR_NB_SIG_B64,
      "x-signet-ts":    String(SAMPLE_NEAR_NB_TS_MS),
      "x-signet-nonce": SAMPLE_NEAR_NB_NONCE_B64,
    };
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: NEAR_NB_HAPPY_NOW_MS,
    });

    expect("code" in result).toBe(false);
  });

  it("rejects when canonical bytes don't match (different body) → ERR_BAD_REQUEST_SIG", async () => {
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    // Body differs from what the signature was computed over → sig fails.
    const result = await verifyAndUpsertLease({
      req,
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bead_create","arguments":{"repo":"/repos/BAR"}}}',
      id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_BAD_REQUEST_SIG });
  });

  it("rejects when timestamp header doesn't match the signed canonical → ERR_BAD_REQUEST_SIG", async () => {
    const h = happyHeaders();
    h["x-signet-ts"] = String(SAMPLE_TS_MS + 1);  // off by one ms
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: h });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_BAD_REQUEST_SIG });
  });

  it("rejects scope mismatch — cert grants bead_create:/repos/foo but request hits a different repo → ERR_SCOPE_DENIED (403)", async () => {
    // Re-derive a sig that covers the alternate body (so we get past the
    // sig check and reach the scope check). We can't do that without the
    // ephemeral private key, so instead we keep the signed body but
    // override the parsed `params` (the verifier derives the requested
    // scope from `method` + `params`, not from the body string).
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call",
      params: { name: "bead_create", arguments: { repo: "/repos/BAR" } },
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_SCOPE_DENIED });
    if ("code" in result) expect(result.message).toMatch(/scope/i);
  });

  it("rejects when ephemeral pubkey in cert doesn't match the signing key (tampered cert)", async () => {
    // Flip a byte in the SPKI region of the cert. The cert chain verify
    // will fail (signature over TbsCertificate is broken).
    const certBytes = b64uDecode(CERT_FULL_B64);
    certBytes[40] ^= 0x80;
    const tamperedB64 = b64uEncode(certBytes);
    const h = happyHeaders();
    h["authorization"] = `Signet ${tamperedB64}`;
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: h });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });

    expect(result).toMatchObject({ code: ERR_UNAUTHENTICATED });
  });

  it("happy path writes a lease counter row to TrustStore", async () => {
    // Read the counter before, run verify, read after — seq should bump.
    const trustStub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & {
      getLeaseCounter(peerFp: string): Promise<{ peer_fp: string; seq: number; last_chain_hash: string } | null>;
    };
    const before = await trustStub.getLeaseCounter("sha256:abc123def456");
    const beforeSeq = before?.seq ?? 0;

    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });
    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
    });
    if ("code" in result) throw new Error(`expected ok, got ${result.code}: ${result.message}`);

    const after = await trustStub.getLeaseCounter("sha256:abc123def456");
    expect(after).not.toBeNull();
    expect(after?.seq).toBeGreaterThan(beforeSeq);
  });
});

// ── Replay defense (cloister-c5c846 / threat-model §6.2.3) ───────────────

describe("verifyAndUpsertLease — replay defense", () => {
  const baseArgs = () => ({
    body: SAMPLE_BODY_JSON,
    id: 1,
    method: "tools/call",
    params: SAMPLE_PARAMS,
    env, bundle: makeBundle(), nowMs: HAPPY_NOW_MS,
  });

  it("first call with envelope succeeds; identical replay rejected with ERR_REPLAY (-32004 / 401)", async () => {
    const req1 = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });
    const req2 = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const first  = await verifyAndUpsertLease({ ...baseArgs(), req: req1 });
    const second = await verifyAndUpsertLease({ ...baseArgs(), req: req2 });

    expect("code" in first).toBe(false);  // first: clean pass
    if ("code" in first) return;

    expect("code" in second).toBe(true);  // second: replay rejected
    if (!("code" in second)) return;
    expect(second.code).toBe(-32004);  // ERR_REPLAY
    expect(second.message).toMatch(/replayed/i);
  });

  it("replay rejection short-circuits BEFORE the counter UPSERT", async () => {
    // The counter chain must NOT advance on a replay — otherwise an
    // attacker could use replays to spin the counter and corrupt the
    // chain state observable by peers (threat-model §13.2).
    const req1 = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });
    await verifyAndUpsertLease({ ...baseArgs(), req: req1 });

    const trustStub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & {
      getLeaseCounter(peerFp: string): Promise<{ seq: number } | null>;
    };
    const seqBeforeReplay = (await trustStub.getLeaseCounter("sha256:abc123def456"))?.seq ?? 0;
    expect(seqBeforeReplay).toBe(1);

    // Replay attempt
    const req2 = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });
    const replay = await verifyAndUpsertLease({ ...baseArgs(), req: req2 });
    expect("code" in replay).toBe(true);

    const seqAfterReplay = (await trustStub.getLeaseCounter("sha256:abc123def456"))?.seq ?? 0;
    expect(seqAfterReplay).toBe(seqBeforeReplay);  // unchanged
  });
});

// ── Clock-skew bound (cloister-c7e3e3 / threat-model §6.2.7) ─────────────

describe("verifyAndUpsertLease — clock-skew bound", () => {
  it("rejects when |nowMs - ts| > MAX_CLOCK_SKEW_MS (60s) → ERR_CLOCK_SKEW", async () => {
    // SAMPLE_TS_MS sits in the middle of validity. nowMs 65s past ts
    // exceeds the 60s tolerance — clock-skew fires before any cert work.
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: SAMPLE_TS_MS + 65_000,
    });

    expect(result).toMatchObject({ code: -32008 });  // ERR_CLOCK_SKEW
    if ("code" in result) expect(result.message).toMatch(/skew/i);
  });

  it("rejects when nowMs is more than 60s in the past relative to ts → ERR_CLOCK_SKEW", async () => {
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: SAMPLE_TS_MS - 65_000,
    });

    expect(result).toMatchObject({ code: -32008 });
  });

  it("accepts skew within tolerance (±60s)", async () => {
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: SAMPLE_TS_MS + 30_000,  // 30s skew
    });

    expect("code" in result).toBe(false);  // happy path even with skew
  });

  it("clock-skew check fires BEFORE any wasm cert work (cheap-fail-fast contract)", async () => {
    // Submit a cert that would FAIL chain verify (CERT_WRONG_MASTER) but
    // with a ts more than 60s skew. Expect ERR_CLOCK_SKEW, not the
    // cert-chain-failure code — proves the clock-skew gate runs first.
    const h = happyHeaders();
    h["authorization"] = `Signet ${CERT_WRONG_MASTER_B64}`;
    const req = new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: h });

    const result = await verifyAndUpsertLease({
      req, body: SAMPLE_BODY_JSON, id: 1,
      method: "tools/call", params: SAMPLE_PARAMS,
      env, bundle: makeBundle(), nowMs: SAMPLE_TS_MS + 200_000,
    });

    expect(result).toMatchObject({ code: -32008 });  // skew, not ERR_UNAUTHENTICATED
  });
});

// ── Local b64url helpers (mirrored from lease-middleware.ts) ─────────────

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
