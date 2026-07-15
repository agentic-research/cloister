// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-token-verify — the vault's per-call authentication for in-cluster tool
// bundles (ADR-0047, threat-model §20). A bundle presents a scoped notme DPoP
// access token; the vault VERIFIES it and derives `subjectFp` from the *verified*
// `sub` — it never trusts a passed identity. This closes the "the DO trusts what's
// passed" open question (vault-store.ts §"Open: in-cluster bundle identity
// propagation") for the first tool-bundle caller.
//
// The token is a standard `at+jwt` EdDSA JWT (notme worker/src/auth/token.ts):
//   header  { typ: "at+jwt", alg: "EdDSA", kid }
//   payload { sub, iss, aud, iat, nbf, exp, jti, scope, cnf: { jkt } }
//   sig     Ed25519 over `b64url(header).b64url(payload)`
//
// This module verifies the JWT core (sig + typ/alg + iss/aud/scope/exp/nbf).
// Fail-closed: any failure returns { ok: false }. Follow-on increments (per §20):
// the DPoP proof-of-possession (cnf.jkt), replay ledger (jti), revocation
// (notme RevocationAuthority), and JWK-by-kid fetch/cache.

const ED25519 = { name: "Ed25519" } as const;

/** The verified identity derived from a bundle token — never a passed argument. */
export interface VerifiedBundleToken {
  /** The token's verified subject (the bundle identity). */
  sub: string;
  /** The token's granted scope. */
  scope: string;
  /** `sha256:<12-byte-hex>` of `sub` — same shape as a router VerifiedLease.peerFp. */
  subjectFp: string;
  /** DPoP proof-key thumbprint (cnf.jkt), if bound. Consumed by the DPoP-proof step. */
  jkt?: string;
}

export type BundleTokenResult =
  | { ok: true; token: VerifiedBundleToken }
  | { ok: false; reason: string };

/** base64url (no pad) decode. Inlined per lease-middleware convention. */
function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Scope grant check — mirrors lease-middleware's `scopeAllows` grammar: `*`
 * grants all, exact match, and `prefix:*` grants `prefix:<anything>`.
 */
function scopeGrants(granted: string, requested: string): boolean {
  if (granted === "*") return true;
  if (granted === requested) return true;
  if (granted.endsWith(":*")) return requested.startsWith(granted.slice(0, -1));
  return false;
}

/** `sha256:<first-12-bytes-hex>` of the verified sub — the vault's subject_fp shape. */
async function deriveSubjectFp(sub: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub)));
  const hex = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/**
 * Verify a notme `at+jwt` EdDSA access token. Fail-closed: any error returns
 * `{ ok: false, reason }`. On success `subjectFp` is derived from the verified
 * `sub`, so the vault authenticates the caller instead of trusting it.
 *
 * @param jwt      the compact JWS `b64url(header).b64url(payload).b64url(sig)`
 * @param notmePub notme authority raw 32-byte Ed25519 public key (selected by `kid`)
 * @param opts.audience     required `aud`
 * @param opts.requiredScope the `vault:proxy:<service>` scope the call needs
 * @param opts.now          current epoch seconds
 * @param opts.issuer       required `iss`
 * @param opts.skewSec      allowed clock skew (default 60)
 */
export async function verifyBundleToken(
  jwt: string,
  notmePub: Uint8Array,
  opts: { audience: string; requiredScope: string; now: number; issuer: string; skewSec?: number },
): Promise<BundleTokenResult> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed jwt" };
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
  } catch {
    return { ok: false, reason: "bad json" };
  }

  if (header.typ !== "at+jwt") return { ok: false, reason: "wrong typ" };
  if (header.alg !== "EdDSA") return { ok: false, reason: "wrong alg" };

  // Verify the Ed25519 signature over `header.payload`.
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", notmePub as BufferSource, ED25519, false, ["verify"]);
  } catch {
    return { ok: false, reason: "bad key" };
  }
  const sigOk = await crypto.subtle.verify(
    ED25519,
    key,
    b64uDecode(s) as BufferSource,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!sigOk) return { ok: false, reason: "signature" };

  // Claims.
  const skew = opts.skewSec ?? 60;
  if (payload.iss !== opts.issuer) return { ok: false, reason: "issuer" };
  if (payload.aud !== opts.audience) return { ok: false, reason: "audience" };
  if (typeof payload.exp !== "number" || payload.exp + skew < opts.now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf - skew > opts.now) {
    return { ok: false, reason: "not yet valid" };
  }
  if (typeof payload.sub !== "string" || payload.sub === "") return { ok: false, reason: "no sub" };
  if (typeof payload.scope !== "string") return { ok: false, reason: "no scope" };
  // A bundle token must be narrowly scoped. `"*"` is admin (lease-middleware
  // documents it as "admin certs only — never minted in production"); an
  // incoming `"*"` on a bundle token is evidence of a mint bug, not a grant.
  // Reject it (math-friend review 2026-07-14, finding #7).
  if (payload.scope === "*") return { ok: false, reason: "wildcard/admin scope forbidden on bundle token" };
  if (!scopeGrants(payload.scope, opts.requiredScope)) return { ok: false, reason: "scope" };

  const cnf = payload.cnf as { jkt?: unknown } | undefined;
  const jkt = typeof cnf?.jkt === "string" ? cnf.jkt : undefined;

  return {
    ok: true,
    token: { sub: payload.sub, scope: payload.scope, subjectFp: await deriveSubjectFp(payload.sub), jkt },
  };
}
