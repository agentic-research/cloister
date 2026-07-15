// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bundle-auth (ADR-0047 / §20) — DPoP proof-of-possession + the composed
// bundle→vault auth decision. Covers the review's load-bearing constraints:
// #1 token-or-deny (§20.9), #2 sub cross-check (§20.10), #6 DPoP conjunction (§20.2).

import { describe, it, expect } from "vitest";
import { verifyDpopProof, authenticateBundleRequest } from "../../src/routes/bundle-auth.js";

const enc = new TextEncoder();
const ISS = "https://auth.notme.bot";
const AUD = "cloister-vault";
const NOW = 1_800_000_000;
const HTM = "POST";
const HTU = "https://vault.internal/proxy/openai";
const SUB = "bundle:mache";

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uJson(o: unknown): string {
  return b64u(enc.encode(JSON.stringify(o)));
}
async function ed25519(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: kp.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}
async function thumbprint(pub: Uint8Array): Promise<string> {
  const x = b64u(pub);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)));
  return b64u(d);
}
async function signJwt(priv: CryptoKey, header: unknown, payload: unknown): Promise<string> {
  const h = b64uJson(header);
  const p = b64uJson(payload);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}
async function accessToken(notmePriv: CryptoKey, jkt: string, over: Record<string, unknown> = {}): Promise<string> {
  return signJwt(
    notmePriv,
    { typ: "at+jwt", alg: "EdDSA", kid: "notme-k1" },
    { sub: SUB, iss: ISS, aud: AUD, iat: NOW - 10, nbf: NOW - 10, exp: NOW + 300, jti: "at1", scope: "vault:proxy:openai", cnf: { jkt }, ...over },
  );
}
async function proofJwt(
  dpopPriv: CryptoKey,
  dpopPub: Uint8Array,
  over: Record<string, unknown> = {},
  headerJwkX?: string,
): Promise<string> {
  return signJwt(
    dpopPriv,
    { typ: "dpop+jwt", alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: headerJwkX ?? b64u(dpopPub) } },
    { htm: HTM, htu: HTU, iat: NOW, jti: "proof1", ...over },
  );
}

describe("verifyDpopProof — §20.2 conjunction", () => {
  it("accepts a proof signed by the key whose thumbprint == boundJkt", async () => {
    const { priv, pub } = await ed25519();
    const r = await verifyDpopProof(await proofJwt(priv, pub), await thumbprint(pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jti).toBe("proof1");
  });

  it("rejects proof-key substitution — right thumbprint, wrong signing key (embed victim jwk, sign with own)", async () => {
    const attacker = await ed25519();
    const victim = await ed25519();
    // Attacker signs with their key but embeds the victim's jwk to match boundJkt.
    const forged = await proofJwt(attacker.priv, attacker.pub, {}, b64u(victim.pub));
    const r = await verifyDpopProof(forged, await thumbprint(victim.pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signature"); // caught by conjunction leg (a): sig verified with the embedded jwk
  });

  it("rejects thumbprint mismatch — valid self-signed proof but boundJkt is a different key", async () => {
    const { priv, pub } = await ed25519();
    const other = await ed25519();
    const r = await verifyDpopProof(await proofJwt(priv, pub), await thumbprint(other.pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("jkt mismatch"); // caught by conjunction leg (b)
  });

  it("rejects a wrong htm", async () => {
    const { priv, pub } = await ed25519();
    const r = await verifyDpopProof(await proofJwt(priv, pub, { htm: "GET" }), await thumbprint(pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("htm");
  });

  it("rejects a wrong htu (different path)", async () => {
    const { priv, pub } = await ed25519();
    const r = await verifyDpopProof(await proofJwt(priv, pub, { htu: "https://vault.internal/proxy/anthropic" }), await thumbprint(pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("htu");
  });

  it("ignores htu query/fragment (RFC 9449 normalization)", async () => {
    const { priv, pub } = await ed25519();
    const r = await verifyDpopProof(await proofJwt(priv, pub, { htu: `${HTU}?x=1#frag` }), await thumbprint(pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(true);
  });

  it("rejects a stale proof (iat outside the window)", async () => {
    const { priv, pub } = await ed25519();
    const r = await verifyDpopProof(await proofJwt(priv, pub, { iat: NOW - 10_000 }), await thumbprint(pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("stale proof");
  });

  it("rejects a wrong typ", async () => {
    const { priv, pub } = await ed25519();
    const jwt = await signJwt(priv, { typ: "jwt", alg: "EdDSA", jwk: { kty: "OKP", crv: "Ed25519", x: b64u(pub) } }, { htm: HTM, htu: HTU, iat: NOW, jti: "j" });
    const r = await verifyDpopProof(jwt, await thumbprint(pub), { htm: HTM, htu: HTU, now: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong typ");
  });
});

describe("authenticateBundleRequest — composed decision", () => {
  async function ctx(over: Record<string, unknown> = {}) {
    const notme = await ed25519();
    const dpop = await ed25519();
    const jkt = await thumbprint(dpop.pub);
    return {
      token: await accessToken(notme.priv, jkt),
      proof: await proofJwt(dpop.priv, dpop.pub),
      notmePub: notme.pub,
      expectedSub: SUB,
      audience: AUD,
      requiredScope: "vault:proxy:openai",
      issuer: ISS,
      htm: HTM,
      htu: HTU,
      now: NOW,
      seenJti: () => false,
      isRevoked: () => false,
      ...over,
    };
  }

  it("accepts a valid token + matching proof; subjectFp from the verified sub", async () => {
    const r = await authenticateBundleRequest(await ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sub).toBe(SUB);
    expect(r.subjectFp).toMatch(/^sha256:[0-9a-f]{24}$/);
  });

  it("#1 (§20.9) rejects a missing token — no positional-subjectFp fallthrough", async () => {
    const r = await authenticateBundleRequest(await ctx({ token: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no token/);
  });

  it("rejects a missing DPoP proof", async () => {
    const r = await authenticateBundleRequest(await ctx({ proof: null }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no dpop proof/);
  });

  it("#2 (§20.10) rejects a token whose sub != the DO's expected bundle", async () => {
    const r = await authenticateBundleRequest(await ctx({ expectedSub: "bundle:other" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/sub mismatch/);
  });

  it("rejects a replayed proof (jti already seen)", async () => {
    const r = await authenticateBundleRequest(await ctx({ seenJti: () => true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/replay/);
  });

  it("rejects a revoked signing key", async () => {
    const r = await authenticateBundleRequest(await ctx({ isRevoked: () => true }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("revoked");
  });

  it("rejects when the proof key does not match the token's cnf.jkt", async () => {
    const notme = await ed25519();
    const boundKey = await ed25519();
    const otherKey = await ed25519();
    const r = await authenticateBundleRequest(
      await ctx({
        notmePub: notme.pub,
        token: await accessToken(notme.priv, await thumbprint(boundKey.pub)),
        proof: await proofJwt(otherKey.priv, otherKey.pub), // signed by a key != cnf.jkt
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/dpop:/);
  });
});
