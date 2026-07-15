// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-auth — DPoP proof-of-possession + the composed bundle→vault auth
// decision (ADR-0047, threat-model §20). This turns the bearer `verifyBundleToken`
// core into a proof-of-possession-bound verify (RFC 9449 DPoP), and composes it
// with the two HIGH constraints the 2026-07-14 foundational review demanded:
//   #1 (§20.9) token-or-deny — no positional-subjectFp fallthrough on the bundle path.
//   #2 (§20.10) the verified `sub` must equal the DO's pinned expected bundle.
//   #6 (§20.2) the DPoP proof is a CONJUNCTION — the proof is signed by the JWK
//              whose RFC 7638 thumbprint equals the token's `cnf.jkt`.

import { verifyBundleToken } from "./bundle-token-verify.js";

const ED25519 = { name: "Ed25519" } as const;

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
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

/**
 * RFC 7638 JWK thumbprint for an OKP Ed25519 public key: base64url(SHA-256 of the
 * canonical JSON with members in lexicographic order — `crv`, `kty`, `x`). The
 * thumbprint alg is PINNED to SHA-256 (no agility — a downgrade reopens
 * proof-key substitution).
 */
async function jwkThumbprint(x: string): Promise<string> {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return b64uEncode(digest);
}

/** htu comparison per RFC 9449: scheme + host + path, drop query/fragment. */
function normalizeHtu(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return u;
  }
}

export type DpopResult = { ok: true; jti: string } | { ok: false; reason: string };

/**
 * Verify a DPoP proof (RFC 9449) and its binding to `boundJkt` (the access
 * token's `cnf.jkt`). CONJUNCTION: the proof must be signed by the embedded JWK
 * AND that JWK's thumbprint must equal `boundJkt` — either alone is a
 * proof-key-substitution bypass. Fail-closed. Returns the `jti` for the caller's
 * replay ledger.
 */
export async function verifyDpopProof(
  proof: string,
  boundJkt: string,
  opts: { htm: string; htu: string; now: number; windowSec?: number },
): Promise<DpopResult> {
  const parts = proof.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed proof" };
  const [h, p, s] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
  } catch {
    return { ok: false, reason: "bad json" };
  }

  if (header.typ !== "dpop+jwt") return { ok: false, reason: "wrong typ" };
  if (header.alg !== "EdDSA") return { ok: false, reason: "wrong alg" };
  const jwk = header.jwk as { kty?: unknown; crv?: unknown; x?: unknown } | undefined;
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    return { ok: false, reason: "bad jwk" };
  }

  // (a) verify the proof signature WITH the embedded JWK.
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", b64uDecode(jwk.x) as BufferSource, ED25519, false, ["verify"]);
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

  // (b) AND the thumbprint of that same JWK must equal the token's cnf.jkt.
  if ((await jwkThumbprint(jwk.x)) !== boundJkt) return { ok: false, reason: "jkt mismatch" };

  // Bind the proof to this request.
  if (typeof payload.htm !== "string" || (payload.htm as string).toUpperCase() !== opts.htm.toUpperCase()) {
    return { ok: false, reason: "htm" };
  }
  if (typeof payload.htu !== "string" || normalizeHtu(payload.htu as string) !== normalizeHtu(opts.htu)) {
    return { ok: false, reason: "htu" };
  }
  const window = opts.windowSec ?? 120;
  if (typeof payload.iat !== "number" || Math.abs(opts.now - (payload.iat as number)) > window) {
    return { ok: false, reason: "stale proof" };
  }
  if (typeof payload.jti !== "string" || payload.jti === "") return { ok: false, reason: "no jti" };

  return { ok: true, jti: payload.jti as string };
}

export interface BundleAuthContext {
  /** The access token, or null. Null → deny (no positional-subjectFp fallthrough). */
  token: string | null;
  /** The DPoP proof, or null. */
  proof: string | null;
  /** notme authority raw Ed25519 pubkey, resolved by the token's `kid` (caller's job). */
  notmePub: Uint8Array;
  /** The DO's pinned expected bundle identity (from idFromName/manifest). #2. */
  expectedSub: string;
  audience: string;
  requiredScope: string;
  issuer: string;
  htm: string;
  htu: string;
  now: number;
  /** Replay ledger: returns true if this jti has been seen (the DO's seen-jti store). */
  seenJti: (jti: string) => boolean | Promise<boolean>;
  /** Revocation: returns true if the token's signing key is revoked (notme RevocationAuthority). */
  isRevoked: (kid: string | undefined) => boolean | Promise<boolean>;
}

export type BundleAuthResult = { ok: true; subjectFp: string; sub: string } | { ok: false; reason: string };

/**
 * The full bundle→vault auth decision. Fail-closed; on success returns a
 * `subjectFp` derived from the *verified* token — the vault never trusts a
 * passed identity. This is the function the vault DO's bundle-facing entrypoint
 * calls (token-or-deny — there is no positional-subjectFp branch here, #1/§20.9).
 */
export async function authenticateBundleRequest(ctx: BundleAuthContext): Promise<BundleAuthResult> {
  // #1 / §20.9 — token-or-deny. Absence of a token must not fall through to a
  // trusted path; the bundle-facing entrypoint reaches only this function.
  if (!ctx.token) return { ok: false, reason: "no token (bundle path is token-or-deny)" };
  if (!ctx.proof) return { ok: false, reason: "no dpop proof" };

  const t = await verifyBundleToken(ctx.token, ctx.notmePub, {
    audience: ctx.audience,
    requiredScope: ctx.requiredScope,
    now: ctx.now,
    issuer: ctx.issuer,
  });
  if (!t.ok) return { ok: false, reason: `token: ${t.reason}` };

  // #2 / §20.10 — the two hybrid layers cross-check: the verified sub MUST equal
  // the DO's pinned bundle, so a shared-DO manifest misconfig is caught, not masked.
  if (t.token.sub !== ctx.expectedSub) {
    return { ok: false, reason: "sub mismatch (token not for this bundle's DO)" };
  }

  // #6 / §20.2 — DPoP proof-of-possession (conjunction).
  if (!t.token.jkt) return { ok: false, reason: "token not DPoP-bound (no cnf.jkt)" };
  const dp = await verifyDpopProof(ctx.proof, t.token.jkt, { htm: ctx.htm, htu: ctx.htu, now: ctx.now });
  if (!dp.ok) return { ok: false, reason: `dpop: ${dp.reason}` };
  if (await ctx.seenJti(dp.jti)) return { ok: false, reason: "replay (jti seen)" };

  // Revocation (notme RevocationAuthority, by kid).
  if (await ctx.isRevoked(t.token.kid)) return { ok: false, reason: "revoked" };

  return { ok: true, subjectFp: t.token.subjectFp, sub: t.token.sub };
}
