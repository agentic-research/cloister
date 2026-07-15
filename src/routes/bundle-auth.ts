// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-auth — the composed bundle→vault auth decision (ADR-0047, threat-model
// §20). The CRYPTOGRAPHIC verify (token EdDSA sig + ES256 DPoP proof + RFC 9449
// htm/htu + RFC 7638 cnf.jkt binding) is delegated to the vendored notme SDK
// (`../vendor/notme-dpop.ts::verifyDPoPToken`) so cloister's verify is byte-
// identical to the notme issuer's — the prior hand-rolled path was Ed25519-only
// and could not verify notme's ES256/EC-minted tokens (cloister-0ae913).
//
// Over that verify, this file layers the checks the SDK deliberately does NOT do
// (it is issuer-agnostic): audience-confusion defense, issuer pin, scope-grant,
// and the two HIGH constraints the 2026-07-14 foundational review demanded:
//   #1 (§20.9) token-or-deny — no positional-subjectFp fallthrough on the bundle path.
//   #2 (§20.10) the verified `sub` must equal the DO's pinned expected bundle.
// Replay (proof `jti`) + revocation (`kid`) are injected callbacks the DO owns.

import { verifyDPoPToken, base64urlDecode } from "../vendor/notme-dpop.js";
import { scopeGrants, deriveSubjectFp } from "./bundle-token-verify.js";

// Vestigial for cloister (we always pass `publicKey`, resolved from env.NOTME by
// kid), but the SDK's option type requires it; the notme default is harmless.
const NOTME_JWKS_URL = "https://auth.notme.bot/.well-known/jwks.json";

/** Decode a compact-JWS part (0=header, 1=payload) to an object, or null. */
function jwtPart(jwt: string, index: 0 | 1): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[index]!)));
  } catch {
    return null;
  }
}

export interface BundleAuthContext {
  /** The access token, or null. Null → deny (no positional-subjectFp fallthrough). */
  token: string | null;
  /** The DPoP proof, or null. */
  proof: string | null;
  /** notme authority raw Ed25519 pubkey, resolved by the token's `kid` (caller's job). */
  notmePub: Uint8Array;
  /** The DO's pinned expected bundle identity (from idFromName/manifest). §20.10. */
  expectedSub: string;
  audience: string;
  requiredScope: string;
  issuer: string;
  htm: string;
  htu: string;
  /** Replay ledger: returns true if this proof `jti` has been seen (the DO's seen-jti store). */
  seenJti: (jti: string) => boolean | Promise<boolean>;
  /** Revocation: returns true if the token's signing key is revoked (notme RevocationAuthority). */
  isRevoked: (kid: string) => boolean | Promise<boolean>;
}

export type BundleAuthResult = { ok: true; subjectFp: string; sub: string } | { ok: false; reason: string };

/**
 * The full bundle→vault auth decision. Fail-closed; on success returns a
 * `subjectFp` derived from the *verified* token — the vault never trusts a
 * passed identity. This is the function the vault DO's bundle-facing entrypoint
 * calls (token-or-deny — there is no positional-subjectFp branch here, §20.9).
 */
export async function authenticateBundleRequest(ctx: BundleAuthContext): Promise<BundleAuthResult> {
  // §20.9 — token-or-deny. Absence must not fall through to a trusted path.
  if (!ctx.token) return { ok: false, reason: "no token (bundle path is token-or-deny)" };
  if (!ctx.proof) return { ok: false, reason: "no dpop proof" };

  // Import the notme authority key so the SDK verifies the token signature
  // against it (skips the SDK's JWKS fetch — cloister resolves the key by kid).
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey("raw", ctx.notmePub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { ok: false, reason: "bad notme key" };
  }

  // Crypto verify (canonical notme SDK): token EdDSA sig, exp, proof ES256/EdDSA
  // sig, htm/htu exact match, iat freshness, and the cnf.jkt proof-of-possession
  // binding. Throws on any failure → deny.
  let claims: { sub: string; scope: string; aud: string; exp: number; jti: string };
  try {
    claims = await verifyDPoPToken({
      token: ctx.token,
      proof: ctx.proof,
      method: ctx.htm,
      url: ctx.htu,
      jwksUrl: NOTME_JWKS_URL,
      publicKey,
    });
  } catch {
    // Reason strings are an INTERNAL enum for DO-side audit only — never the raw
    // SDK message (which finely discriminates deny-state), and the bundle-facing
    // entrypoint MUST collapse every denial to one constant-shape response so
    // `reason` can't become an enumeration/validity oracle (threat-model §9/§20).
    return { ok: false, reason: "dpop-verify" };
  }

  // ── cloister-layered checks the issuer-agnostic SDK does not do ──
  const nowSec = Math.floor(Date.now() / 1000);

  // Token header: pin `typ` (the SDK never inspects it — an EdDSA JWT of another
  // `typ` that notme signed with the same key must not be replayed as a bundle
  // token) and REQUIRE `kid` (revocation keys off it; a missing kid → isRevoked
  // no-op → a revoked key still authorizes, so deny outright).
  const tokenHeader = jwtPart(ctx.token, 0);
  if (!tokenHeader || tokenHeader.typ !== "at+jwt") return { ok: false, reason: "typ" };
  const kid = typeof tokenHeader.kid === "string" ? tokenHeader.kid : null;
  if (!kid) return { ok: false, reason: "kid" };

  // Audience-confusion defense: a token minted for a different resource server
  // (same notme issuer + key) must not pass here. Narrow to string — the SDK's
  // return type says `string` but hands back whatever `aud` is (e.g. an array).
  if (typeof claims.aud !== "string" || claims.aud !== ctx.audience) return { ok: false, reason: "audience" };

  // Issuer pin + not-before. The SDK checks neither; the token payload here is
  // authenticated (verifyDPoPToken verified the sig over these exact bytes).
  const tokenPayload = jwtPart(ctx.token, 1);
  if (!tokenPayload || tokenPayload.iss !== ctx.issuer) return { ok: false, reason: "issuer" };
  if (typeof tokenPayload.nbf === "number" && tokenPayload.nbf > nowSec + 60) {
    return { ok: false, reason: "not yet valid" };
  }

  // Scope is SPACE-DELIMITED (OAuth). A bundle token must be narrowly scoped:
  // reject the admin `"*"` in any position, then require the needed scope.
  if (claims.scope.split(/\s+/).includes("*")) {
    return { ok: false, reason: "wildcard/admin scope forbidden on bundle token" };
  }
  if (!scopeGrants(claims.scope, ctx.requiredScope)) return { ok: false, reason: "scope" };

  // §20.10 — the hybrid layers cross-check: the verified sub MUST equal the DO's
  // pinned bundle, so a shared-DO manifest misconfig is caught, not masked.
  if (claims.sub !== ctx.expectedSub) {
    return { ok: false, reason: "sub mismatch (token not for this bundle's DO)" };
  }

  // Replay — the PROOF's jti (single-use), not the token's. The SDK validates
  // jti presence + iat window; the durable single-use ledger is the DO's.
  const proofPayload = jwtPart(ctx.proof, 1);
  const proofJti = proofPayload && typeof proofPayload.jti === "string" ? proofPayload.jti : null;
  if (!proofJti) return { ok: false, reason: "no proof jti" };
  if (await ctx.seenJti(proofJti)) return { ok: false, reason: "replay (jti seen)" };

  // Revocation (notme RevocationAuthority, by the token's kid). NOTE: the kid is
  // not yet cross-checked against the kid that RESOLVED notmePub — that parity
  // check lands with the JWKS-by-kid resolver (cloister-9fbec8 / plan Task 2).
  if (await ctx.isRevoked(kid)) return { ok: false, reason: "revoked" };

  return { ok: true, subjectFp: await deriveSubjectFp(claims.sub), sub: claims.sub };
}
