// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lease middleware (cloister-bd7770).
//
// Wraps `POST /mcp` so every authenticated call passes through:
//
//   1. Header parsing      — Authorization: Signet <cert>, X-Signet-Sig,
//                            X-Signet-Ts, X-Signet-Nonce.
//   2. Cert chain verify   — wasm32 leyline-sign verifies the cert is
//                            signed by the cluster master (active key,
//                            falling back to prev key during a rotation
//                            window per the CA bundle).
//   3. Claims required     — Interlace certs MUST carry epoch + peer_fp +
//                            scope; Phase 1 fails closed if any is missing.
//   4. Epoch check         — `cert.epoch` ∈ {bundle.epoch, bundle.epoch-1
//                            during rotation}; older = revoked.
//   5. Validity window     — server clock ∈ [not_before, not_after].
//   6. Request signature   — Ed25519(claims.ephemeral_pubkey, sig,
//                            canonical-bytes(method,url,ts,nonce,body)).
//   7. Scope check         — cert.scope ⊇ requested-tool scope.
//   8. Replay + chain      — TrustStore.verifyLeaseAndAdvanceChain
//                            (cloister-ee51b8): single RPC, atomic
//                            seen_nonces INSERT-OR-FAIL + lease counter
//                            UPSERT inside one transactionSync. Replaces
//                            the legacy two-RPC pair (e1d54e + c5c846).
//   9. Dispatch            — caller passes through to McpEdgeRoute.
//
// Per ADR-0007: NO INTERLACE_DEV_BYPASS escape hatch. Always-on auth.

import type { Env } from "../types.js";
import { errResponse, type JsonRpcId } from "../types.js";
import { CaUnavailableError, isCertEpochCurrent, type CABundle } from "../storage/ca-bundle-cache.js";
import { resolveCABundle } from "../storage/ca-bundle-source.js";
import { leaseEnforced } from "./lease-gate.js";
import { verifyCertChain, type CertClaims } from "../wire/signet-verify.js";

// ── Error codes ──────────────────────────────────────────────────────────
//
// JSON-RPC 2.0 error codes outside the reserved -32700..-32099 range.
// Cloister-specific. Stable for clients to switch on.

export const ERR_UNAUTHENTICATED = -32001;
export const ERR_SCOPE_DENIED    = -32002;
export const ERR_BAD_REQUEST_SIG = -32003;
export const ERR_REPLAY          = -32004;
export const ERR_CA_UNAVAILABLE  = -32005;
export const ERR_EPOCH_MISMATCH  = -32006;
export const ERR_CLOCK_SKEW      = -32008;

export type LeaseErrorCode =
  | typeof ERR_UNAUTHENTICATED
  | typeof ERR_SCOPE_DENIED
  | typeof ERR_BAD_REQUEST_SIG
  | typeof ERR_REPLAY
  | typeof ERR_CA_UNAVAILABLE
  | typeof ERR_EPOCH_MISMATCH
  | typeof ERR_CLOCK_SKEW;

/**
 * Maximum tolerated divergence between caller-claimed `X-Signet-Ts`
 * and server clock. Rejects requests with `ts` more than ±60s from
 * `nowMs` (cloister-c7e3e3 / threat-model §6.2.7).
 *
 * Why 60s: matches notme's typical cert-mint clock-skew tolerance and
 * is well inside the 5-minute cert TTL. Tighter than this risks legitimate
 * NTP skew on dev machines; looser opens a longer replay-window before
 * cert expiry (defense-in-depth — the seen_nonces ledger handles
 * exact replays, this bounds time-shifted replays).
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

// ── Header parsing ───────────────────────────────────────────────────────

export interface ParsedAuthHeaders {
  certDer: Uint8Array;
  sig:     Uint8Array;
  ts:      number;       // unix-ms
  nonce:   Uint8Array;   // raw bytes
}

export type AuthHeaderError =
  | { kind: "missing_authorization" }
  | { kind: "wrong_scheme";        scheme: string }
  | { kind: "missing_signature" }
  | { kind: "missing_timestamp" }
  | { kind: "missing_nonce" }
  | { kind: "bad_base64";          field: string };

/**
 * Pull the four lease headers off a Request. Returns a typed error if
 * any required header is missing or malformed. Doesn't VERIFY anything;
 * just decodes.
 *
 * Wire shape:
 *   Authorization: Signet <base64-cert-DER>
 *   X-Signet-Sig:  <base64-Ed25519-signature>
 *   X-Signet-Ts:   <unix-ms-as-decimal>
 *   X-Signet-Nonce: <base64-random-bytes-≥16>
 */
export function parseAuthHeaders(req: Request): ParsedAuthHeaders | AuthHeaderError {
  const authz = req.headers.get("authorization");
  if (!authz) return { kind: "missing_authorization" };

  const space = authz.indexOf(" ");
  if (space < 0) return { kind: "wrong_scheme", scheme: authz };
  const scheme = authz.slice(0, space);
  if (scheme !== "Signet") return { kind: "wrong_scheme", scheme };

  const certB64 = authz.slice(space + 1).trim();
  let certDer: Uint8Array;
  try { certDer = b64decode(certB64); }
  catch { return { kind: "bad_base64", field: "Authorization" }; }

  const sigB64 = req.headers.get("x-signet-sig");
  if (!sigB64) return { kind: "missing_signature" };
  let sig: Uint8Array;
  try { sig = b64decode(sigB64); }
  catch { return { kind: "bad_base64", field: "X-Signet-Sig" }; }

  const tsRaw = req.headers.get("x-signet-ts");
  if (!tsRaw) return { kind: "missing_timestamp" };
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts) || ts <= 0) return { kind: "missing_timestamp" };

  const nonceB64 = req.headers.get("x-signet-nonce");
  if (!nonceB64) return { kind: "missing_nonce" };
  let nonce: Uint8Array;
  try { nonce = b64decode(nonceB64); }
  catch { return { kind: "bad_base64", field: "X-Signet-Nonce" }; }

  return { certDer, sig, ts, nonce };
}

// ── Canonical request bytes ──────────────────────────────────────────────

/**
 * Build the canonical bytes the caller should have signed. Deterministic
 * and byte-stable: same inputs → same bytes, on any host. The caller
 * computes these the same way and signs with their ephemeral key; we
 * recompute and verify the signature.
 *
 * Format (newline-separated; LF only, no CRLF):
 *
 *   <method>\n<full-url>\n<unix-ms-ts>\n<nonce-b64-no-padding>\n<body>
 *
 * Why this shape: each field has a defined separator and the order is
 * lexicographically obvious. body is the raw JSON-RPC payload (already
 * canonicalized by the JSON-RPC layer — clients are expected to send
 * stable JSON; renormalization on the server side is out of scope).
 *
 * No length prefixes — order + LF separators are sufficient because no
 * field can contain a literal LF except `body`, and the body is the
 * trailing field. (If body legitimately contains LFs, that's still
 * fine: the LFs are at the end, after all the fixed-position fields.)
 */
export function canonicalRequestBytes(
  method: string,
  url:    string,
  ts:     number,
  nonce:  Uint8Array,
  body:   string,
): Uint8Array {
  const nonceB64 = b64encode(nonce);
  const text = `${method}\n${url}\n${ts}\n${nonceB64}\n${body}`;
  return new TextEncoder().encode(text);
}

// ── Scope grammar + glob match ───────────────────────────────────────────

/**
 * Derive the scope string for a JSON-RPC tools/call. Per ADR-0007:
 *
 *   tools/list                          → "tools:list"
 *   tools/call name=X (no args)         → "X:*"
 *   tools/call name=X args.repo=R       → "X:R"
 *
 * The grammar is intentionally simple. Per-tool scope refinement (e.g.
 * mache_search needing finer granularity) lives in the tool's own
 * implementation, not in the scope grammar.
 */
export function deriveRequestScope(method: string, params: unknown): string {
  if (method === "tools/list") return "tools:list";
  if (method !== "tools/call") return `unknown:${method}`;

  const p = params as { name?: string; arguments?: { repo?: string } } | undefined;
  if (!p?.name) return "tools:call:no_name";
  const repo = p.arguments?.repo;
  return repo ? `${p.name}:${repo}` : `${p.name}:*`;
}

/**
 * Returns true iff the cert's scope grants the requested scope. Glob
 * semantics:
 *
 *   "X:*"  matches ANY "X:something"
 *   "X:R"  matches only "X:R"
 *   "*"    matches anything (admin certs only — should never be
 *          minted in production)
 *
 * No multi-component wildcards (e.g. "X:R/*") in v1; revisit when a
 * use case appears.
 */
export function scopeAllows(certScope: string, requested: string): boolean {
  if (certScope === "*") return true;
  if (certScope === requested) return true;

  // Trailing :* — match prefix before the colon.
  if (certScope.endsWith(":*")) {
    const prefix = certScope.slice(0, -1);  // includes the colon
    return requested.startsWith(prefix);
  }

  return false;
}

// ── JSON-RPC error response builders ─────────────────────────────────────

export function leaseErrorResponse(
  id: JsonRpcId,
  code: LeaseErrorCode,
  message: string,
): Response {
  // 401 for cert-related, 403 for scope, 503 for ca_unavailable, etc.
  const httpStatus =
    code === ERR_SCOPE_DENIED                                  ? 403 :
    code === ERR_CA_UNAVAILABLE || code === ERR_EPOCH_MISMATCH ? 503 :
    code === ERR_CLOCK_SKEW                                    ? 401 :
                                                                 401 ;

  return Response.json(errResponse(id, code, message), { status: httpStatus });
}

// ── Lease counter integration with TrustStore ───────────────────────────

/**
 * Compute a fingerprint for a cert (sha256-hex of its DER). Used as the
 * `last_cert_fp` value in the lease counter row, and as the input to
 * the chain hash.
 */
export async function certFingerprint(certDer: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", certDer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Get the per-cluster TrustStore stub. Cluster is singleton today;
 * idFromName("cluster") gives us the one-and-only.
 */
export function trustStoreStub(env: Env): DurableObjectStub {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
}

// ── Verify orchestrator ──────────────────────────────────────────────────

export interface VerifiedLease {
  /** Peer fingerprint claimed by the cert. */
  peerFp: string;
  /** Cert's scope claim. */
  scope:  string;
  /** Cert's epoch (matches CA bundle). */
  epoch:  number;
  /** sha256-hex of the cert DER, used as last_cert_fp. */
  certFp: string;
  /** Nonce from the request (anti-replay). */
  nonce:  Uint8Array;
  /** Server-side timestamp at verify time. */
  serverTs: number;
  /**
   * Cert DER bytes (raw). Pass-through from `parseAuthHeaders.certDer` so
   * downstream orchestrators (e.g. cross-DO `bead_create`, cloister-492c08)
   * can put the cert in a `peer_attestations` row without re-decoding.
   * Always populated when verify succeeds.
   */
  certDer: Uint8Array;
  /**
   * Ed25519 signature bytes the caller produced over the canonical
   * request bytes. Pass-through from `parseAuthHeaders.sig`. Used by
   * the same downstream orchestrators as `certDer`. Always populated
   * when verify succeeds.
   */
  sig:    Uint8Array;
  /**
   * The 32-byte confinementDigest committed in the cert's Interlace
   * identity (cloister/confinement/v1 §7, OID …1.7), when present. Undefined
   * for certs minted before LLO v0.7.6 or without a confinement commitment.
   * Surfaced here so a future runner (ADR-0044) can cross-check it against
   * the bundle's enforced ConfinementManifest, and so attestation rows can
   * record which confinement identity authorized the call. Per cloister-c80953.
   */
  confinementDigest?: Uint8Array;
}

export type VerifyError = {
  code: LeaseErrorCode;
  message: string;
};

/** TrustStore stub method shape — RPC over the DO binding. */
interface TrustStoreRpc {
  upsertLeaseCounter(
    peerFp: string,
    certFp: string,
    nonce: string,
    ts: number,
  ): Promise<{ seq: number; last_chain_hash: string }>;
  recordSeenNonce(
    certFp: string,
    nonce: string,
    tsMs: number,
  ): Promise<{ fresh: boolean }>;
  /**
   * Atomic replay-check + chain advance (cloister-ee51b8). Replaces the
   * back-to-back `recordSeenNonce` + `upsertLeaseCounter` pair on the
   * hot path: one cross-DO RPC instead of two, and the two writes
   * commit in one `transactionSync` so a crash between them can't
   * leave the nonce consumed but the chain un-advanced.
   */
  verifyLeaseAndAdvanceChain(args: {
    peerFp: string;
    certFp: string;
    nonce:  string;
    ts:     number;
  }): Promise<
    | { replayed: true }
    | { replayed: false; seq: number; last_chain_hash: string }
  >;
}

/**
 * Resolve the master pubkey to verify a cert against. Returns the active
 * key first; if `prevKeyId` is set we may need to retry the verify with
 * the previous key (rotation window). Caller does the retry.
 */
function bundleMasterPubkeys(bundle: CABundle): { active: Uint8Array; prev?: Uint8Array } {
  const active = b64StdDecode(bundle.keys[bundle.keyId] ?? "");
  if (bundle.prevKeyId !== undefined) {
    const prev = bundle.keys[bundle.prevKeyId];
    if (prev !== undefined) return { active, prev: b64StdDecode(prev) };
  }
  return { active };
}

/**
 * Verify the request signature: Ed25519(claims.ephemeralPubkey, sig,
 * canonical-bytes). Uses Web Crypto's raw-key import, which workerd
 * supports for Ed25519. A throw from the crypto layer surfaces as
 * `ok: false` so callers don't have to try/catch.
 */
async function verifyRequestSignature(
  ephemeralPubkey: Uint8Array,
  sig:             Uint8Array,
  canonical:       Uint8Array,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      ephemeralPubkey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "Ed25519",
      key,
      sig as BufferSource,
      canonical as BufferSource,
    );
    return { ok };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "crypto failed" };
  }
}

/**
 * Run the full lease verification pipeline. Returns a `VerifiedLease` on
 * success or a typed `VerifyError` on any failure. Always fails closed.
 *
 * Inputs the caller must provide:
 *   - `req` — the inbound Request
 *   - `body` — the raw request body (already read; rebuilding from req
 *     would consume it again)
 *   - `id`, `method`, `params` — already-parsed JSON-RPC fields
 *   - `env` — for TrustStore access
 *   - `bundle` — current CA bundle (caller fetches via the cache module
 *     so the cache lifecycle is centralized; we're given the bundle
 *     ready-to-use). Master pubkey is `bundle.keys[bundle.keyId]`.
 *   - `nowMs` — server clock at verify time, for validity-window check.
 */
export async function verifyAndUpsertLease(args: {
  req:    Request;
  body:   string;
  id:     JsonRpcId;
  method: string;
  params: unknown;
  env:    Env;
  bundle: CABundle;
  nowMs:  number;
  /**
   * Override the scope derived from (method, params) — used by routes
   * whose scope grammar doesn't fit JSON-RPC (e.g. GET /interlace/peers/{fp}
   * needs scope `disclosure:<fp>`, which has no JSON-RPC equivalent).
   * When unset, the orchestrator calls `deriveRequestScope(method, params)`.
   */
  requestedScope?: string;
}): Promise<VerifiedLease | VerifyError> {
  // 1. Header parse.
  const headers = parseAuthHeaders(args.req);
  if ("kind" in headers) {
    return {
      code: ERR_UNAUTHENTICATED,
      message: `lease auth header malformed: ${headers.kind}`,
    };
  }

  // 1b. Clock-skew bound. The signature already binds `headers.ts` to
  // the canonical bytes, so a tampered ts fails the sig check; this
  // catches a *legitimate* envelope replayed long after the wall-clock
  // moved past the cert TTL gap (defense-in-depth alongside the
  // seen_nonces ledger). Per cloister-c7e3e3 / threat model §6.2.7.
  const skewMs = Math.abs(args.nowMs - headers.ts);
  if (skewMs > MAX_CLOCK_SKEW_MS) {
    return {
      code: ERR_CLOCK_SKEW,
      message: `client timestamp skew ${skewMs}ms exceeds tolerance (±${MAX_CLOCK_SKEW_MS}ms)`,
    };
  }

  // 2. Cert chain verify against the cluster master. Try active first;
  // fall back to prev during a rotation window. The bundle's keyId rolls
  // forward; certs minted just before the roll point are still valid for
  // one window.
  const { active, prev } = bundleMasterPubkeys(args.bundle);
  if (active.length === 0) {
    return { code: ERR_CA_UNAVAILABLE, message: "CA bundle missing active master pubkey" };
  }
  let chain = verifyCertChain(headers.certDer, active);
  if (!chain.ok && prev !== undefined) {
    chain = verifyCertChain(headers.certDer, prev);
  }
  if (!chain.ok) {
    return {
      code: ERR_UNAUTHENTICATED,
      message: `cert chain verify failed: ${chain.reason}`,
    };
  }
  const claims: CertClaims = chain.claims;

  // 3. Required Interlace claims. Phase 1 mandates all three; admin /
  // bootstrap certs that elide them are out of scope.
  if (claims.epoch === undefined || claims.peerFp === undefined || claims.scope === undefined) {
    return {
      code: ERR_UNAUTHENTICATED,
      message: "cert missing required Interlace claims (epoch, peer_fp, scope)",
    };
  }

  // 4. Epoch currency. `isCertEpochCurrent` accepts current + (rotation
  // window) prev. Same window the master-pubkey fallback above honors.
  if (!isCertEpochCurrent(claims.epoch, args.bundle)) {
    return {
      code: ERR_EPOCH_MISMATCH,
      message: `cert.epoch=${claims.epoch} not current (bundle.epoch=${args.bundle.epoch})`,
    };
  }

  // 5. Validity window. Server clock is the truth; client-claimed `ts`
  // is checked against canonical-bytes via the signature, not directly.
  const nowSec = Math.floor(args.nowMs / 1000);
  if (nowSec < claims.notBefore || nowSec > claims.notAfter) {
    return {
      code: ERR_UNAUTHENTICATED,
      message: `cert outside validity window (now=${nowSec}, [${claims.notBefore},${claims.notAfter}])`,
    };
  }

  // 6. Request signature. Caller signed the canonical bytes with the
  // cert's ephemeral private key; verify against the SPKI we just
  // extracted from the cert.
  const canonical = canonicalRequestBytes(
    args.req.method,
    args.req.url,
    headers.ts,
    headers.nonce,
    args.body,
  );
  const sigCheck = await verifyRequestSignature(claims.ephemeralPubkey, headers.sig, canonical);
  if (!sigCheck.ok) {
    return {
      code: ERR_BAD_REQUEST_SIG,
      message: sigCheck.reason ? `request signature invalid: ${sigCheck.reason}` : "request signature invalid",
    };
  }

  // 7. Scope check. Cert says what the holder may do; request derives
  // what was actually attempted. scopeAllows enforces glob containment.
  // Caller may override the derived scope (GET disclosure routes do this
  // because their scope isn't JSON-RPC-shaped).
  const requestedScope = args.requestedScope ?? deriveRequestScope(args.method, args.params);
  if (!scopeAllows(claims.scope, requestedScope)) {
    return {
      code: ERR_SCOPE_DENIED,
      message: `cert scope '${claims.scope}' does not allow '${requestedScope}'`,
    };
  }

  // 8 + 9. Replay defense + lease counter UPSERT, batched into ONE
  // cross-DO RPC (cloister-ee51b8). Replaces what used to be two
  // sequential RPCs (`recordSeenNonce` + `upsertLeaseCounter`):
  //
  //   - Perf: the two RPCs together accounted for ~85% of the lease
  //     pipeline cost. Coalescing halves the cross-DO overhead.
  //   - Atomicity: the previous shape committed `seen_nonces` before
  //     `peer_lease_counters`, with no shared transaction. A crash
  //     between the two left the nonce consumed but the chain
  //     un-advanced — a §13.2 off-by-one signal even though the cluster
  //     did nothing wrong. The new RPC wraps both writes in one
  //     `transactionSync` on the DO so either both land or neither does.
  //
  // Semantics preserved: a duplicate (cert_fp, nonce) short-circuits to
  // ERR_REPLAY BEFORE the counter advances (the chain never records
  // replay attempts as legitimate calls). Per cloister-c5c846 / threat-
  // model §6.2.3 + §6.2.8.
  const certFp = await certFingerprint(headers.certDer);
  const nonceB64 = b64encode(headers.nonce);
  const trustStore = trustStoreStub(args.env) as DurableObjectStub & TrustStoreRpc;

  const result = await trustStore.verifyLeaseAndAdvanceChain({
    peerFp: claims.peerFp,
    certFp,
    nonce:  nonceB64,
    ts:     args.nowMs,
  });
  if (result.replayed) {
    return {
      code: ERR_REPLAY,
      message: "request envelope replayed (cert_fp, nonce) tuple already seen",
    };
  }

  return {
    peerFp:   claims.peerFp,
    scope:    claims.scope,
    epoch:    claims.epoch,
    certFp,
    nonce:    headers.nonce,
    serverTs: args.nowMs,
    certDer:  headers.certDer,
    sig:      headers.sig,
    confinementDigest: claims.confinementDigest,
  };
}

// ── base64url helpers (no padding) ───────────────────────────────────────
//
// Inlined here to avoid an extra import. Same shape as vault/crypto.ts's
// inlined helpers (also added during this session's cross-tree decoupling).

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * base64-STANDARD decode (with `+`/`/` and `=` padding). The CA bundle's
 * `keys` map encodes raw 32-byte Ed25519 pubkeys this way (per
 * notme/worker/src/revocation.ts), so we need a separate decoder from
 * the base64url path used for headers.
 */
function b64StdDecode(s: string): Uint8Array {
  if (s === "") return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Used by isCertEpochCurrent's caller — re-exported for downstream
// middleware routes that want to compute the same check.
export { isCertEpochCurrent };

// ── 0.2.0 URL-canonicalization prototype (cloister-aecd26) ──────────────
//
// SKETCH — not wired into the live verifier path.
//
// This helper demonstrates the path-suffix canonicalization rules defined
// in interlace-spec/0.2.0-draft/URL-CANONICALIZATION.md §3.3 for the
// cross-implementation conformance suite. The PRODUCTION verifier above
// (`verifyAndUpsertLease`) still uses the 0.1.0 full-URL canonical bytes
// (`canonicalRequestBytes`); switching the live path waits for 0.2.0 spec
// ratification + a follow-up bead.
//
// The reference test vectors under
//   interlace-spec/0.2.0-draft/test-vectors/url-canonicalization/*.json
// pin canonical-bytes hex and SHA-256 values that
// `canonicalPathSuffix_0_2_0_prototype` MUST reproduce given the same
// inputs. RECEIPTS.md §2.1 `request_hash` inherits these bytes:
// `SHA-256(canonicalRequestBytesV2(...))`.
//
// DO NOT call this from production code. The receipts spec also pairs
// with this change and lands in the same 0.2.0 cutover (see
// cloister-ae713f).

/**
 * Strip the operator-declared prefix from `path` per
 * URL-CANONICALIZATION.md §3.3.3. Returns the post-strip path, or
 * `undefined` if the path is un-canonicalizable under the prefix
 * (verifier MUST reject as bad_request_sig).
 *
 * Edge cases:
 *   prefix == "" → no-op, return path as-is.
 *   path == prefix → return "/" (root-of-route).
 *   path starts with prefix + "/" → return path[prefix.length:].
 *   otherwise → undefined.
 */
function stripPrefix_0_2_0(path: string, prefix: string): string | undefined {
  if (prefix === "") return path;
  if (path === prefix) return "/";
  if (path.startsWith(prefix + "/")) return path.slice(prefix.length);
  return undefined;
}

/**
 * Normalize a path per URL-CANONICALIZATION.md §3.3.4. Apply rules in
 * the order given by the spec:
 *
 *   1. Empty → "/".
 *   2. Collapse consecutive "/" runs.
 *   3. Resolve "." and ".." segments per RFC 3986 §5.2.4.
 *   4. Strip a single trailing "/" unless path is exactly "/".
 *   5. Uppercase percent-encoded hex; decode RFC 3986 §2.3 unreserved.
 */
function normalizePath_0_2_0(input: string): string {
  // Rule 1.
  if (input === "") return "/";

  // Rule 2: collapse repeated slashes.
  let path = input.replace(/\/+/g, "/");

  // Rule 3: RFC 3986 §5.2.4 dot-segment removal. Implementation per
  // the RFC's pseudocode — operates on a stack of segments.
  const segments = path.split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") {
      // Skip empty (preserves leading/trailing slash context) and ".".
      // We re-emit empty for path boundaries below.
      continue;
    }
    if (seg === "..") {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  // Reassemble with leading slash if input started with "/", and trailing
  // slash if input ended with "/" (rule 4 will strip below).
  const startsWithSlash = path.startsWith("/");
  const endsWithSlash   = path.endsWith("/") && path !== "/";
  path = (startsWithSlash ? "/" : "") + stack.join("/") + (endsWithSlash ? "/" : "");
  if (path === "") path = "/";

  // Rule 4: trim single trailing slash on non-root paths.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Rule 5: percent-encoding normalization.
  path = normalizePctEncoding_0_2_0(path);

  return path;
}

/**
 * Normalize percent-encoded triplets per URL-CANONICALIZATION.md
 * §3.3.4 rule 5 and §3.3.5 rule 4. Uppercase hex; decode unreserved.
 */
function normalizePctEncoding_0_2_0(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const upper = hex.toUpperCase();
    const byte = Number.parseInt(upper, 16);
    // RFC 3986 §2.3 unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~"
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5A) || // A-Z
      (byte >= 0x61 && byte <= 0x7A) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2D || byte === 0x2E || byte === 0x5F || byte === 0x7E;
    return isUnreserved ? String.fromCharCode(byte) : "%" + upper;
  });
}

/**
 * Normalize a query string per URL-CANONICALIZATION.md §3.3.5.
 * Returns the canonical query (no leading "?"); empty string if no
 * canonical query content.
 */
function normalizeQuery_0_2_0(query: string): string {
  if (query === "") return "";

  // Split on "&"; each pair split on the FIRST "=".
  type Pair = { key: string; value: string; origIndex: number };
  const pairs: Pair[] = query.split("&").map((pair, i) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return { key: pair, value: "", origIndex: i };
    return { key: pair.slice(0, eq), value: pair.slice(eq + 1), origIndex: i };
  });

  // Apply percent-encoding normalization to keys and values.
  for (const p of pairs) {
    p.key   = normalizePctEncoding_0_2_0(p.key);
    p.value = normalizePctEncoding_0_2_0(p.value);
  }

  // Stable sort by bytewise-lex on key, preserving original order
  // within equal keys (§3.3.5 rule 4).
  pairs.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return a.origIndex - b.origIndex;
  });

  return pairs.map((p) => `${p.key}=${p.value}`).join("&");
}

/**
 * Compute the 0.2.0 canonical path-suffix for a request URL per
 * URL-CANONICALIZATION.md §3.3.
 *
 * Returns the path-suffix string on success, or `undefined` if the
 * request is un-canonicalizable under the declared prefix. The verifier
 * MUST reject un-canonicalizable requests as `bad_request_sig` BEFORE
 * attempting signature verification.
 *
 * @param rawUrl       The full request URL (P's outgoing URL or A's
 *                     observed `request.url`).
 * @param prefix       The operator-declared prefix from
 *                     `.well-known/interlace/index.json`. Empty string
 *                     means no prefix.
 *
 * SKETCH ONLY — not wired into the live verifier. See module-level
 * banner above.
 */
export function canonicalPathSuffix_0_2_0_prototype(
  rawUrl: string,
  prefix: string,
): string | undefined {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return undefined; }

  const stripped = stripPrefix_0_2_0(parsed.pathname, prefix);
  if (stripped === undefined) return undefined;

  const path  = normalizePath_0_2_0(stripped);
  const query = normalizeQuery_0_2_0(parsed.search.startsWith("?")
    ? parsed.search.slice(1)
    : parsed.search);

  return query === "" ? path : `${path}?${query}`;
}

/**
 * Compute the 0.2.0 canonical request bytes — same shape as
 * `canonicalRequestBytes` (the 0.1.0 path) but with `path-suffix`
 * substituted for the full URL field. See URL-CANONICALIZATION.md §3.2.
 *
 * Caller is responsible for computing `pathSuffix` from
 * `canonicalPathSuffix_0_2_0_prototype` and rejecting requests where
 * the function returns `undefined`.
 *
 * SKETCH ONLY — `verifyAndUpsertLease` does NOT call this yet.
 */
export function canonicalRequestBytesV2_prototype(
  method:      string,
  pathSuffix:  string,
  ts:          number,
  nonce:       Uint8Array,
  body:        string,
): Uint8Array {
  const nonceB64 = b64encode(nonce);
  const text = `${method}\n${pathSuffix}\n${ts}\n${nonceB64}\n${body}`;
  return new TextEncoder().encode(text);
}

// ── Gate + verify flow (ADR-0053 / cloister-220c9d) ──────────────────────

/**
 * A lease-gate verdict — the typed result of `gateAndVerify`. Routes map it to
 * their own response shape (JSON-RPC error, OCI DENIED, 401/503, or the
 * disclosure constant-time 404), but never re-implement the flow producing it.
 */
export type GateVerdict =
  | { kind: "off" }                        // gate off — pass-through routes proceed with no lease
  | { kind: "pass"; lease: VerifiedLease } // enforced + verified
  | { kind: "reject"; code: LeaseErrorCode; message: string };

/**
 * The single gate → verify flow for every lease-gated route (ADR-0053). Owns
 * the security-critical ordering so no route re-implements it:
 *   1. resolve the gate (leaseEnforced);
 *   2. when enforcing, resolve the CA bundle — failing CLOSED on
 *      CaUnavailableError (missing anchor / notme unreachable);
 *   3. run verifyAndUpsertLease;
 *   4. return a typed verdict.
 *
 * `denyWhenOff` (default false) turns an off gate into a reject rather than a
 * pass — for routes (e.g. the credential vault) that must deny even under the
 * dev opt-out. Pass-through routes (mcp, oci, disclosure) leave it false and
 * proceed on `{ kind: "off" }`.
 */
export async function gateAndVerify(
  env:   Env,
  nowMs: number,
  verify: {
    req:             Request;
    body:            string;
    id:              JsonRpcId;
    method:          string;
    params:          unknown;
    requestedScope?: string;
  },
  opts: { denyWhenOff?: boolean } = {},
): Promise<GateVerdict> {
  if (!leaseEnforced(env)) {
    return opts.denyWhenOff
      ? { kind: "reject", code: ERR_UNAUTHENTICATED, message: "authentication required" }
      : { kind: "off" };
  }

  let bundle: CABundle;
  try {
    bundle = await resolveCABundle(env, nowMs);
  } catch (err) {
    if (err instanceof CaUnavailableError) {
      return { kind: "reject", code: ERR_CA_UNAVAILABLE, message: "CA bundle unavailable" };
    }
    throw err;
  }

  const verdict = await verifyAndUpsertLease({ ...verify, env, bundle, nowMs });
  if ("code" in verdict) {
    return { kind: "reject", code: verdict.code, message: verdict.message };
  }
  return { kind: "pass", lease: verdict };
}
