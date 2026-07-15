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
  now: number;
  /** Replay ledger: returns true if this proof `jti` has been seen (the DO's seen-jti store). */
  seenJti: (jti: string) => boolean | Promise<boolean>;
  /** Revocation: returns true if the token's signing key is revoked (notme RevocationAuthority). */
  isRevoked: (kid: string | undefined) => boolean | Promise<boolean>;
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
  } catch (e) {
    return { ok: false, reason: `dpop-verify: ${e instanceof Error ? e.message : "failed"}` };
  }

  // ── cloister-layered checks the issuer-agnostic SDK does not do ──

  // Audience-confusion defense: a token minted for a different resource server
  // (same notme issuer + key) must not pass here.
  if (claims.aud !== ctx.audience) return { ok: false, reason: "audience" };

  // Issuer pin (the SDK verifies the signature, not the `iss` string).
  const tokenPayload = jwtPart(ctx.token, 1);
  if (!tokenPayload || tokenPayload.iss !== ctx.issuer) return { ok: false, reason: "issuer" };

  // Scope: a bundle token must be narrowly scoped. `"*"` (admin) is forbidden.
  if (claims.scope === "*") return { ok: false, reason: "wildcard/admin scope forbidden on bundle token" };
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

  // Revocation (notme RevocationAuthority, by the token's kid).
  const tokenHeader = jwtPart(ctx.token, 0);
  const kid = tokenHeader && typeof tokenHeader.kid === "string" ? tokenHeader.kid : undefined;
  if (await ctx.isRevoked(kid)) return { ok: false, reason: "revoked" };

  return { ok: true, subjectFp: await deriveSubjectFp(claims.sub), sub: claims.sub };
}
