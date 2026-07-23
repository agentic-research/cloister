// SPDX-License-Identifier: AGPL-3.0-or-later
//
// authenticateBundleRequest (ADR-0047 §20) — tested against REAL notme wire
// format: an EdDSA at+jwt token + an ES256 EC DPoP proof + an EC cnf.jkt
// (cloister-0ae913). The crypto verify itself is the vendored notme SDK (tested
// upstream in notme); these tests exercise CLOISTER's composition — the
// audience/issuer/scope pins and the §20.9 token-or-deny + §20.10 sub cross-check.

import { describe, it, expect, beforeAll } from "vitest";
import { authenticateBundleRequest, type BundleAuthContext } from "../../src/routes/bundle-auth.js";
import { scopeGrants, deriveSubjectFp } from "../../src/routes/bundle-token-verify.js";
import { generateEd25519, generateP256, rawEd25519Pub, jktOf, mintToken, buildProof } from "./dpop-fixtures.js";

const SUB = "rosary";
const AUD = "cloister";
const ISS = "https://auth.notme.bot";
const SCOPE = "vault:proxy:anthropic";
const HTM = "POST";
const HTU = "https://cloister.example/vault/anthropic";

let edKp: CryptoKeyPair; // notme token-signing key
let notmePub: Uint8Array;
let ec: { keyPair: CryptoKeyPair; jwk: JsonWebKey }; // client DPoP key
let jkt: string;

beforeAll(async () => {
  edKp = await generateEd25519();
  notmePub = await rawEd25519Pub(edKp);
  ec = await generateP256();
  jkt = await jktOf(ec.jwk);
});

function baseCtx(over: Partial<BundleAuthContext>): BundleAuthContext {
  return {
    token: null,
    proof: null,
    notmePub,
    resolvedKid: "9408457aefd071cec127c1f985399308", // the fixture mints with kid "9408457aefd071cec127c1f985399308" (dpop-fixtures.ts)
    expectedSub: SUB,
    audience: AUD,
    requiredScope: SCOPE,
    issuer: ISS,
    htm: HTM,
    htu: HTU,
    seenJti: () => false,
    isRevoked: () => false,
    ...over,
  };
}

const validToken = (over = {}) =>
  mintToken({ signingKey: edKp.privateKey, sub: SUB, jkt, scope: SCOPE, audience: AUD, issuer: ISS, ...over });
const validProof = (over = {}) => buildProof({ keyPair: ec.keyPair, jwk: ec.jwk, htm: HTM, htu: HTU, ...over });

describe("authenticateBundleRequest — real notme format (ES256 proof + EdDSA token)", () => {
  it("valid token + proof → ok, subjectFp derived from the verified sub", async () => {
    const r = await authenticateBundleRequest(baseCtx({ token: await validToken(), proof: await validProof() }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sub).toBe(SUB);
      expect(r.subjectFp).toBe(await deriveSubjectFp(SUB));
    }
  });

  it("§20.9 — no token denies (token-or-deny, no positional fallthrough)", async () => {
    const r = await authenticateBundleRequest(baseCtx({ token: null, proof: await validProof() }));
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("token-or-deny") });
  });

  it("no dpop proof denies", async () => {
    const r = await authenticateBundleRequest(baseCtx({ token: await validToken(), proof: null }));
    expect(r).toEqual({ ok: false, reason: "no dpop proof" });
  });

  it("§20.10 — token.sub != expectedSub denies (cross-bundle substitution)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ sub: "mache" }), proof: await validProof(), expectedSub: SUB }),
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("sub mismatch") });
  });

  it("accepts a space-delimited multi-scope token that contains the required scope", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ scope: "vault:read vault:proxy:anthropic openid" }), proof: await validProof() }),
    );
    expect(r.ok).toBe(true);
  });

  it("nbf in the future denies (not-yet-valid)", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ nbfOverride: future }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "not yet valid" });
  });

  it("wrong token typ denies (cross-token-type confusion)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ headerOverrides: { typ: "JWT" } }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "typ" });
  });

  it("missing kid denies (revocation must not no-op on undefined)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ omitKid: true }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "kid" });
  });

  it("header kid != the kid that resolved notmePub denies (cloister-9fbec8 revocation binding)", async () => {
    // Attacker signs with the verifying key but points the header kid at a
    // different (non-revoked) kid. Both are valid-shape 128-bit kids, so the
    // denial is the parity check, not the shape guard.
    const r = await authenticateBundleRequest(
      baseCtx({
        token: await validToken({ headerOverrides: { kid: "ffffffffffffffffffffffffffffffff" } }),
        proof: await validProof(),
        resolvedKid: "9408457aefd071cec127c1f985399308",
      }),
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("kid mismatch") });
  });

  it("malformed kid shape denies (ADR-012 R4 — not a jkt / full hash / case-variant)", async () => {
    // A kid must be lowercase hex, 16 or 32 chars. A base64url jkt, an
    // uppercased value, or arbitrary text is rejected BEFORE the parity check
    // so it can never be smuggled into a kid-keyed comparison.
    for (const bad of ["other-kid", "9408457AEFD071CEC127C1F985399308", "not_hex_at_all!!", "abc"]) {
      const r = await authenticateBundleRequest(
        baseCtx({
          token: await validToken({ headerOverrides: { kid: bad } }),
          proof: await validProof(),
          resolvedKid: bad,
        }),
      );
      expect(r).toEqual({ ok: false, reason: expect.stringContaining("kid shape") });
    }
  });

  it("legacy 64-bit (16-hex) kid passes the shape guard during migration", async () => {
    // A 16-hex kid is accepted at the shape gate (it reaches the parity check
    // and fails THAT, not the shape guard) — proving the 64→128 transition
    // isn't broken. signet-3723b6 tightens this to 32-only at the flag-day.
    const r = await authenticateBundleRequest(
      baseCtx({
        token: await validToken({ headerOverrides: { kid: "9408457aefd071ce" } }),
        proof: await validProof(),
        resolvedKid: "ffffffffffffffff",
      }),
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("kid mismatch") });
  });

  it("audience mismatch denies (confused-deputy defense)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ audience: "someone-else" }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "audience" });
  });

  it("multi-audience token denies even when it CONTAINS the expected aud", async () => {
    // cloister is deliberately stricter than the vendored SDK here. RFC 7519
    // (and `validateClaims`) accept an `aud` array if ANY element matches; a
    // token minted for cloister AND another resource server is precisely the
    // confused-deputy shape the bundle path exists to reject. Pinning it means
    // a future re-vendor cannot silently relax it back to SDK semantics.
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ audience: [AUD, "someone-else"] }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "audience" });
  });

  it("nbf inside the clock-skew window is ACCEPTED (60s tolerance restored)", async () => {
    // This test previously asserted the opposite. The notme-dffc5c re-vendor
    // moved the nbf check into the SDK, which defaults to zero tolerance, and
    // silently dropped the `nbf > now + 60` allowance this file used to carry.
    // notme mints `nbf: iat` on EVERY access token, so any negative clock skew
    // between issuer and verifier denied a legitimate token — fail-closed, but
    // a real availability regression.
    //
    // notme-18450e exposed `clockTolerance` on VerifyDPoPOptions; bundle-auth
    // passes 60. The assertion flip IS the fix landing: a test that pinned a
    // known-wrong behavior is only useful if it fails when the behavior is
    // corrected.
    const skewed = Math.floor(Date.now() / 1000) + 30;
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ nbfOverride: skewed }), proof: await validProof() }),
    );
    expect(r.ok).toBe(true);
  });

  it("nbf beyond the tolerance window still denies", async () => {
    // The tolerance is bounded, not disabled — an hour into the future is
    // still not-yet-valid.
    const far = Math.floor(Date.now() / 1000) + 3600;
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ nbfOverride: far }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "not yet valid" });
  });

  it("issuer mismatch denies", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ issuer: "https://evil.example" }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "issuer" });
  });

  it("insufficient scope denies", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken(), proof: await validProof(), requiredScope: "vault:proxy:openai" }),
    );
    expect(r).toEqual({ ok: false, reason: "scope" });
  });

  it("wildcard '*' admin scope on a bundle token denies (specific guard, not generic scope-miss)", async () => {
    // Asserts the dedicated admin-forbid branch fires — a bare ok:false here would
    // also pass if the guard were deleted (scopeGrants('*',req) already returns false).
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ scope: "vault:read *" }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("wildcard/admin") });
  });

  it("replayed proof jti denies", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken(), proof: await validProof(), seenJti: () => true }),
    );
    expect(r).toEqual({ ok: false, reason: "replay (jti seen)" });
  });

  it("revoked signing key denies", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken(), proof: await validProof(), isRevoked: () => true }),
    );
    expect(r).toEqual({ ok: false, reason: "revoked" });
  });

  it("proof key not bound to the token's cnf.jkt denies (§20.2 proof-of-possession)", async () => {
    const other = await generateP256(); // a different proof key than the token's jkt
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken(), proof: await buildProof({ keyPair: other.keyPair, jwk: other.jwk, htm: HTM, htu: HTU }) }),
    );
    expect(r.ok).toBe(false);
  });

  it("htu mismatch denies (RFC 9449 request binding)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken(), proof: await validProof({ htu: "https://cloister.example/vault/evil" }) }),
    );
    expect(r.ok).toBe(false);
  });

  it("expired token denies", async () => {
    const past = Math.floor(Date.now() / 1000) - 1000;
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ expOverride: past, iatOverride: past - 300 }), proof: await validProof() }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("policy helpers", () => {
  it("scopeGrants: exact + :* prefix, nothing wider", () => {
    expect(scopeGrants("vault:proxy:anthropic", "vault:proxy:anthropic")).toBe(true);
    expect(scopeGrants("vault:proxy:*", "vault:proxy:anthropic")).toBe(true);
    expect(scopeGrants("vault:proxy:anthropic", "vault:proxy:openai")).toBe(false);
    expect(scopeGrants("vault:*", "vault:proxy:anthropic")).toBe(true);
  });

  it("deriveSubjectFp is sha256:<12-hex> and stable", async () => {
    const fp = await deriveSubjectFp("rosary");
    expect(fp).toMatch(/^sha256:[0-9a-f]{24}$/);
    expect(await deriveSubjectFp("rosary")).toBe(fp);
  });
});
