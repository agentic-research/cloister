// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-auth — the composed bundle→vault auth decision (ADR-0047, threat-model
// §20). The CRYPTOGRAPHIC verify (token EdDSA sig + ES256 DPoP proof + RFC 9449
// htm/htu + RFC 7638 cnf.jkt binding) is delegated to the vendored notme SDK
// (`@agentic-research/dpop::verifyDPoPToken`) so cloister's verify is byte-
// identical to the notme issuer's — the prior hand-rolled path was Ed25519-only
// and could not verify notme's ES256/EC-minted tokens (cloister-0ae913).
//
// notme-dffc5c (re-vendored): audience-confusion defense, issuer pin,
// access-token `typ` pin, and replay (proof `jti`) are now checked BY THE SDK
// itself — this file used to hand-roll all four as app-layer checks over an
// issuer-agnostic verifier; that duplicated the same hardening logic cloister
// and canonical-hours were each independently re-deriving, so it moved
// upstream into notme's own SDK instead (consolidation, not new scope).
// `audience`/`issuer`/`checkAndRecordJti` are now passed straight into the
// `verifyDPoPToken` call below. What's left here is genuinely cloister-
// specific policy the SDK has no business enforcing: scope-grant + the
// wildcard/admin-scope rejection (cloister's own trust decision, not an
// SDK-level rule), kid-based revocation, and the two HIGH constraints the
// 2026-07-14 foundational review demanded:
//   #1 (§20.9) token-or-deny — no positional-subjectFp fallthrough on the bundle path.
//   #2 (§20.10) the verified `sub` must equal the DO's pinned expected bundle.
//
// The SDK's thrown error messages are pattern-matched back to cloister's own
// internal reason codes below — NOT because the SDK's checks moved, but
// because cloister's own audit design (§9/§20) wants distinguishable
// INTERNAL reasons even though the bundle-facing entrypoint collapses every
// denial to one constant-shape EXTERNAL response. Losing that granularity
// silently would be a real regression, not a simplification.

import {
  verifyDPoPToken,
  base64urlDecode,
  DPoPVerificationError,
  type VerifyErrorCode,
  type VerifiedTokenClaims,
} from "@agentic-research/dpop";
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
    // lint-allow-silent: parse guard — null = malformed JWS part (not JSON)
    return null;
  }
}

/**
 * Maps a `verifyDPoPToken` failure to one of the INTERNAL reason codes this
 * file used to compute itself, before those checks moved into the SDK
 * (notme-dffc5c) — preserving DO-side audit granularity (§9/§20) without
 * re-deriving the checks locally.
 *
 * Keyed on `DPoPVerificationError.code`, which is the SDK's stable contract
 * (notme-3bc238). This previously matched on the SDK's thrown message
 * SUBSTRINGS, which are not an API: rewording any message upstream silently
 * collapsed the mapping to "dpop-verify" and lost exactly the audit
 * granularity the function exists to preserve. The codes removed that
 * coupling — cloister asked for them and notme shipped them.
 *
 * Unmapped codes fall through to the pre-existing generic "dpop-verify"
 * (signature / malformed / htm-htu / cnf.jkt / missing-jti). That is
 * deliberate: no finer internal code ever existed for those, and inventing
 * one here would put reason strings in the audit log that no §20 rule refers
 * to.
 */
const REASON_BY_CODE: Partial<Record<VerifyErrorCode, string>> = {
  TOKEN_TYP_INVALID: "typ",
  CLAIM_AUD_MISMATCH: "audience",
  CLAIM_AUD_MISSING: "audience",
  CLAIM_ISS_MISMATCH: "issuer",
  CLAIM_ISS_MISSING: "issuer",
  CLAIM_NBF_NOT_YET_VALID: "not yet valid",
  PROOF_REPLAY: "replay (jti seen)",
  PROOF_ATH_MISSING: "ath missing",
  PROOF_ATH_MISMATCH: "ath mismatch",
};

function mapVerifyFailureReason(err: unknown): string {
  if (err instanceof DPoPVerificationError) {
    return REASON_BY_CODE[err.code] ?? "dpop-verify";
  }
  return "dpop-verify";
}

export interface BundleAuthContext {
  /** The access token, or null. Null → deny (no positional-subjectFp fallthrough). */
  token: string | null;
  /** The DPoP proof, or null. */
  proof: string | null;
  /** notme authority raw Ed25519 pubkey, resolved by the token's `kid` (caller's job). */
  notmePub: Uint8Array;
  /**
   * The `kid` the caller resolved `notmePub` FROM. The token header's `kid` must
   * equal this — binding the revocation-lookup identity to the key that actually
   * verified the signature (cloister-9fbec8). Otherwise a compromised-key holder
   * could sign with the verifying key yet point revocation at a different,
   * non-revoked `kid`. The caller MUST set this to the JWKS `kid` it selected.
   */
  resolvedKid: string;
  /** The DO's pinned expected bundle identity (from idFromName/manifest). §20.10. */
  expectedSub: string;
  audience: string;
  requiredScope: string;
  issuer: string;
  htm: string;
  htu: string;
  /**
   * Atomic replay ledger boundary. Return true if this proof `jti` was
   * already present; otherwise record it and return false. A read followed by
   * a separate write is not sufficient under concurrent requests.
   */
  checkAndRecordJti: (jti: string) => boolean | Promise<boolean>;
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

  // Crypto verify (canonical notme SDK): token EdDSA sig + typ, proof ES256/EdDSA
  // sig, exp/nbf/iat/iss/aud/sub (validateClaims), htm/htu exact match, jti
  // replay (via atomic checkAndRecordJti), exact-token ath, and the cnf.jkt
  // proof-of-possession binding — all
  // now the SDK's job (notme-dffc5c). Throws on any failure → deny.
  let claims: VerifiedTokenClaims;
  try {
    claims = await verifyDPoPToken({
      token: ctx.token,
      proof: ctx.proof,
      method: ctx.htm,
      url: ctx.htu,
      jwksUrl: NOTME_JWKS_URL,
      publicKey,
      audience: ctx.audience,
      issuer: ctx.issuer,
      checkAndRecordJti: ctx.checkAndRecordJti,
      // Restores the 60s issuer/verifier skew allowance this file carried as
      // `nbf > now + 60` before the checks moved into the SDK. The SDK
      // defaults to zero tolerance, and notme mints `nbf: iat` on every access
      // token, so without this any negative clock skew denies a legitimate
      // token (notme-18450e). Bounded deliberately: it widens `exp` too.
      clockTolerance: 60,
    });
  } catch (err) {
    // Reason strings are an INTERNAL enum for DO-side audit only — the
    // bundle-facing entrypoint (not this function) is what MUST collapse
    // every denial to one constant-shape EXTERNAL response so `reason`
    // can't become an enumeration/validity oracle (threat-model §9/§20).
    // Pattern-matching the SDK's message back to a stable internal code
    // preserves the audit granularity this file always had for these
    // checks — it moved which code verifies them, not whether cloister's
    // own audit trail can tell them apart.
    return { ok: false, reason: mapVerifyFailureReason(err) };
  }

  // ── cloister-layered checks the SDK correctly leaves to the consumer ──

  // REQUIRE `kid` (revocation keys off it; a missing kid → isRevoked no-op →
  // a revoked key still authorizes, so deny outright). typ is now SDK-checked.
  const tokenHeader = jwtPart(ctx.token, 0);
  const kid = tokenHeader && typeof tokenHeader.kid === "string" ? tokenHeader.kid : null;
  if (!kid) return { ok: false, reason: "kid" };
  // Canonical-kid shape gate (signet ADR-012 §Shape-validation / R4). A `kid`
  // is lowercase hex: canonical 128-bit (32 chars) or, during the 64→128
  // migration, legacy 64-bit (16 chars). Rejecting anything else structurally
  // separates a `kid` from a `jkt` (43 base64url chars), a full-length hash or
  // MachineFingerprint (64 hex), and a case-variant — so none can be smuggled
  // into a kid-keyed comparison. Migration-aware: accepts 16 OR 32 hex until the
  // 64-bit comparators retire (signet-3723b6 tightens this to 32-only at the
  // flag-day). cloister derives no kid itself (pure consumer); root-verify
  // already treats kid as an opaque parity value (the equality gate below),
  // which is the ADR-012 R1 invariant.
  if (!/^[0-9a-f]{16}([0-9a-f]{16})?$/.test(kid)) {
    return { ok: false, reason: "kid shape (not 16/32 lowercase hex)" };
  }
  // cloister-9fbec8 — bind the revocation kid to the key that verified the sig:
  // the header kid MUST equal the kid the caller resolved notmePub from, or the
  // revocation lookup could key off an attacker-chosen, non-revoked kid.
  if (kid !== ctx.resolvedKid) return { ok: false, reason: "kid mismatch (header != resolving key)" };

  // Issuer, not-before, and proof-jti replay are now verified BY THE SDK CALL
  // ABOVE (ctx.audience/ctx.issuer/ctx.checkAndRecordJti passed directly) —
  // notme-dffc5c. A failure on any of them throws inside verifyDPoPToken and
  // is caught by this function's own try/catch, mapped to an internal reason
  // by mapVerifyFailureReason.
  //
  // AUDIENCE IS THE EXCEPTION — cloister is deliberately STRICTER than the SDK.
  // `validateClaims` implements RFC 7519 audience semantics: `aud` may be an
  // array, and it passes if ANY element matches. That is correct for a general
  // issuer-agnostic verifier, but cloister's bundle path has always rejected a
  // multi-audience token outright: a token minted for cloister AND another
  // resource server is exactly the confused-deputy shape this check exists to
  // stop, and accepting it would silently widen the trust surface the SDK
  // consolidation was not supposed to touch.
  //
  // Today this is defense-in-depth rather than a live hole — notme's schema
  // types `aud` as a single Text field (`SetAud(v string)`), so no notme-minted
  // token can currently carry an array. The check pins the invariant against a
  // future issuer change instead of relying on that remaining true.
  if (typeof claims.aud !== "string" || claims.aud !== ctx.audience) {
    return { ok: false, reason: "audience" };
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

  // Revocation (notme RevocationAuthority, by the token's kid). NOTE: the kid is
  // not yet cross-checked against the kid that RESOLVED notmePub — that parity
  // check lands with the JWKS-by-kid resolver (cloister-9fbec8 / plan Task 2).
  if (await ctx.isRevoked(kid)) return { ok: false, reason: "revoked" };

  return { ok: true, subjectFp: await deriveSubjectFp(claims.sub), sub: claims.sub };
}
