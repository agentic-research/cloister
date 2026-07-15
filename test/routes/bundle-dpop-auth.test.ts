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
    expectedSub: SUB,
    audience: AUD,
    requiredScope: SCOPE,
    issuer: ISS,
    htm: HTM,
    htu: HTU,
    now: Math.floor(Date.now() / 1000),
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
    expect(r.ok).toBe(false);
  });

  it("§20.10 — token.sub != expectedSub denies (cross-bundle substitution)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ sub: "mache" }), proof: await validProof(), expectedSub: SUB }),
    );
    // sub-mismatch is caught; also fails if the token was minted for a different sub.
    expect(r.ok).toBe(false);
  });

  it("audience mismatch denies (confused-deputy defense)", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ audience: "someone-else" }), proof: await validProof() }),
    );
    expect(r).toEqual({ ok: false, reason: "audience" });
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

  it("wildcard '*' admin scope on a bundle token denies", async () => {
    const r = await authenticateBundleRequest(
      baseCtx({ token: await validToken({ scope: "*" }), proof: await validProof() }),
    );
    expect(r.ok).toBe(false);
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
