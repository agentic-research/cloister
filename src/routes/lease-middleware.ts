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
//   8. Lease counter       — TrustStore.upsertLeaseCounter (e1d54e).
//   9. Dispatch            — caller passes through to McpEdgeRoute.
//
// Per ADR-0007: NO INTERLACE_DEV_BYPASS escape hatch. Always-on auth.

import type { Env } from "../types.js";
import { errResponse, type JsonRpcId } from "../types.js";
import { isCertEpochCurrent, type CABundle } from "../storage/ca-bundle-cache.js";
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

export type LeaseErrorCode =
  | typeof ERR_UNAUTHENTICATED
  | typeof ERR_SCOPE_DENIED
  | typeof ERR_BAD_REQUEST_SIG
  | typeof ERR_REPLAY
  | typeof ERR_CA_UNAVAILABLE
  | typeof ERR_EPOCH_MISMATCH;

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
}): Promise<VerifiedLease | VerifyError> {
  // 1. Header parse.
  const headers = parseAuthHeaders(args.req);
  if ("kind" in headers) {
    return {
      code: ERR_UNAUTHENTICATED,
      message: `lease auth header malformed: ${headers.kind}`,
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
  let chain = await verifyCertChain(headers.certDer, active);
  if (!chain.ok && prev !== undefined) {
    chain = await verifyCertChain(headers.certDer, prev);
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
  const requestedScope = deriveRequestScope(args.method, args.params);
  if (!scopeAllows(claims.scope, requestedScope)) {
    return {
      code: ERR_SCOPE_DENIED,
      message: `cert scope '${claims.scope}' does not allow '${requestedScope}'`,
    };
  }

  // 8. Lease counter UPSERT. ADR-0007 §13.2 — every authenticated call
  // is recorded so silence is evidence (a missing counter means traffic
  // never landed). Done last so a verify failure doesn't rewrite the
  // chain. Cross-DO RPC; TrustStore is a singleton per cluster.
  const certFp = await certFingerprint(headers.certDer);
  const nonceB64 = b64encode(headers.nonce);
  const trustStore = trustStoreStub(args.env) as DurableObjectStub & TrustStoreRpc;
  await trustStore.upsertLeaseCounter(claims.peerFp, certFp, nonceB64, args.nowMs);

  return {
    peerFp:   claims.peerFp,
    scope:    claims.scope,
    epoch:    claims.epoch,
    certFp,
    nonce:    headers.nonce,
    serverTs: args.nowMs,
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
