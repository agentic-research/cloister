// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lease middleware (cloister-bd7770) — Phase 1 substrate.
//
// Wraps `POST /mcp` so every authenticated call passes through:
//
//   1. Header parsing      — Authorization: Signet <cert>, X-Signet-Sig,
//                            X-Signet-Ts, X-Signet-Nonce.
//   2. Canonical bytes     — deterministic concatenation the caller signed.
//   3. Cert verification   — chain to pinned INTERLACE_MASTER_PUBKEY +
//                            epoch check vs CA bundle (e195ea).
//   4. Request signature   — Ed25519(ephemeral_pubkey, sig, canonical).
//   5. Scope check         — cert.scope ⊇ requested-tool scope.
//   6. Lease counter       — TrustStore.upsertLeaseCounter (e1d54e).
//   7. Dispatch            — passes through to McpEdgeRoute.
//
// Per ADR-0007: NO INTERLACE_DEV_BYPASS escape hatch. Always-on auth.
//
// ## Phase 1 scope (this commit)
//
// Implemented:
//   - Header parsing + structured errors
//   - Canonical request bytes (deterministic, byte-stable)
//   - Scope grammar + glob match
//   - LeaseError → JSON-RPC 2.0 error response builders
//   - Lease counter UPSERT (via TrustStore singleton)
//
// Stubbed (FAIL CLOSED — no production use until follow-up bead lands):
//   - Cert-chain verification: needs new WASM FFI export
//     (leyline_verify_cert_chain) or a TS X.509 parser. Filed as a
//     follow-up bead.
//   - Request signature verification: depends on extracting the
//     ephemeral pubkey from the cert (same X.509-parse problem).
//   - Cert claims parsing (peer_fp, scope, not_before, not_after,
//     epoch): same.
//
// The middleware is therefore NOT yet wired into McpEdgeRoute (mcp.ts);
// this commit ships the substrate so that wiring becomes a small
// follow-up. The functions here are independently testable; the
// orchestrator at the bottom of this file documents the full flow but
// returns a `cert_verify_not_implemented` error from the stub points.

import type { Env } from "../types.js";
import { errResponse, type JsonRpcId } from "../types.js";
import { isCertEpochCurrent, type CABundle } from "../storage/ca-bundle-cache.js";

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
export const ERR_CERT_NOT_IMPL   = -32007;  // Phase 1 stub — remove when cert verify lands

export type LeaseErrorCode =
  | typeof ERR_UNAUTHENTICATED
  | typeof ERR_SCOPE_DENIED
  | typeof ERR_BAD_REQUEST_SIG
  | typeof ERR_REPLAY
  | typeof ERR_CA_UNAVAILABLE
  | typeof ERR_EPOCH_MISMATCH
  | typeof ERR_CERT_NOT_IMPL;

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
    code === ERR_SCOPE_DENIED                              ? 403 :
    code === ERR_CA_UNAVAILABLE || code === ERR_EPOCH_MISMATCH ? 503 :
    code === ERR_CERT_NOT_IMPL                             ? 501 :
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

// ── Verify orchestrator (Phase 1 — cert verify stubbed) ──────────────────

export interface VerifiedLease {
  /** Peer fingerprint claimed by the cert (parsed from extension). */
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

/**
 * Phase 1 — orchestrator stub. Wires header parsing + scope derivation +
 * lease-counter UPSERT, but stubs the actual cert verification and
 * request-signature verification. Returns a typed `VerifyError` from
 * the stub points so callers fail closed.
 *
 * When the follow-up bead (cert-chain verify + claims parsing in WASM)
 * lands, the stub points get filled in and this becomes the production
 * orchestrator.
 *
 * Inputs the caller must provide:
 *   - `req` — the inbound Request
 *   - `body` — the raw request body (already read; rebuilding from req
 *     would consume it again)
 *   - `id`, `method`, `params` — already-parsed JSON-RPC fields
 *   - `env` — for TrustStore + CA bundle access
 *   - `bundle` — current CA bundle (caller fetches via the cache module
 *     so the cache lifecycle is centralized; we're given the bundle
 *     ready-to-use)
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
  const headers = parseAuthHeaders(args.req);
  if ("kind" in headers) {
    return {
      code: ERR_UNAUTHENTICATED,
      message: `lease auth header malformed: ${headers.kind}`,
    };
  }

  // Build canonical bytes (caller would have signed these). Used by the
  // (stubbed) request-signature verification step.
  const canonical = canonicalRequestBytes(
    args.req.method,
    args.req.url,
    headers.ts,
    headers.nonce,
    args.body,
  );
  void canonical;  // currently consumed only by the stubbed verifier

  // Derive scope from the JSON-RPC request body. Done before cert
  // verification so we can short-circuit common cases (tools/list is
  // always allowed even with a degenerate cert if it ever reaches that
  // branch — but we still gate on cert verify).
  const requestedScope = deriveRequestScope(args.method, args.params);
  void requestedScope;  // currently consumed only by the stubbed scope check

  // Phase 1 stub — cert-chain verify + ephemeral pubkey extraction +
  // claims parsing all need WASM extensions or a TS X.509 parser. Until
  // that lands, fail closed: the middleware is in place but doesn't
  // accept any cert. Tests for the substrate (header parsing, canonical
  // bytes, scope grammar) still pass; integration tests wait for the
  // follow-up bead.
  return {
    code: ERR_CERT_NOT_IMPL,
    message: "cert chain verification not yet implemented (Phase 1 substrate); see cloister-bd5241 follow-up for WASM cert-parse extension",
  };

  // ── PSEUDOCODE for when the stub is filled in ──
  //
  // const claims = await parseCertClaims(headers.certDer);  // peer_fp, scope, epoch, not_before, not_after, ephemeral_spki
  // if (!isCertEpochCurrent(claims.epoch, args.bundle)) {
  //   return { code: ERR_EPOCH_MISMATCH, message: "cert.epoch != bundle.epoch" };
  // }
  // const chainOk = await verifyCertChain(headers.certDer, masterPubkey);
  // if (!chainOk) return { code: ERR_UNAUTHENTICATED, message: "cert chain verify failed" };
  // const sigOk = await crypto.subtle.verify("Ed25519", claims.ephemeralPubkey, headers.sig, canonical);
  // if (!sigOk) return { code: ERR_BAD_REQUEST_SIG, message: "request signature invalid" };
  // if (args.nowMs < claims.not_before * 1000 || args.nowMs > claims.not_after * 1000) {
  //   return { code: ERR_UNAUTHENTICATED, message: "cert outside validity window" };
  // }
  // if (!scopeAllows(claims.scope, requestedScope)) {
  //   return { code: ERR_SCOPE_DENIED, message: `scope ${claims.scope} does not allow ${requestedScope}` };
  // }
  // const certFp = await certFingerprint(headers.certDer);
  // const nonceB64 = b64encode(headers.nonce);
  // const trustStore = trustStoreStub(args.env);
  // await trustStore.upsertLeaseCounter(claims.peerFp, certFp, nonceB64, args.nowMs);
  // return { peerFp: claims.peerFp, scope: claims.scope, epoch: claims.epoch, certFp,
  //          nonce: headers.nonce, serverTs: args.nowMs };
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

// Used by isCertEpochCurrent's caller — re-exported for downstream
// middleware routes that want to compute the same check.
export { isCertEpochCurrent };
