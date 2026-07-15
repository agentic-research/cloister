// SPDX-License-Identifier: AGPL-3.0-or-later
//
// verifyBundleToken (ADR-0047 / threat-model §20) — the vault's per-call auth for
// in-cluster tool bundles. Each case is a §20 failure mode; the token is minted
// with a test Ed25519 key in the same `at+jwt` shape notme's mintAccessToken emits.

import { describe, it, expect } from "vitest";
import { verifyBundleToken } from "../../src/routes/bundle-token-verify.js";

const enc = new TextEncoder();
const ISS = "https://auth.notme.bot";
const AUD = "cloister-vault";
const NOW = 1_800_000_000;

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uJson(o: unknown): string {
  return b64u(enc.encode(JSON.stringify(o)));
}

async function keypair(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub };
}

async function mint(
  priv: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { typ: "at+jwt", alg: "EdDSA", kid: "k1" },
): Promise<string> {
  const h = b64uJson(header);
  const p = b64uJson(claims);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64u(sig)}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "bundle:mache",
    iss: ISS,
    aud: AUD,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 300,
    jti: "j1",
    scope: "vault:proxy:openai",
    cnf: { jkt: "thumbprint-abc" },
    ...over,
  };
}

const OPTS = { audience: AUD, requiredScope: "vault:proxy:openai", now: NOW, issuer: ISS };

describe("verifyBundleToken — ADR-0047 §20", () => {
  it("accepts a valid token; subjectFp derived from the VERIFIED sub, jkt surfaced", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims()), pub, OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.sub).toBe("bundle:mache");
    expect(r.token.subjectFp).toMatch(/^sha256:[0-9a-f]{24}$/);
    expect(r.token.jkt).toBe("thumbprint-abc");
  });

  it("20.1 rejects a forged signature (verified against the wrong key)", async () => {
    const { priv } = await keypair();
    const { pub: otherPub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims()), otherPub, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("signature");
  });

  it("20.3 rejects a token minted for another audience", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims({ aud: "other-rs" })), pub, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("audience");
  });

  it("20.4 rejects a scope that does not cover the request", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims({ scope: "vault:proxy:anthropic" })), pub, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("scope");
  });

  it("accepts a wildcard-suffix scope that covers the request", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims({ scope: "vault:proxy:*" })), pub, OPTS);
    expect(r.ok).toBe(true);
  });

  it("20.5 rejects an expired token", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims({ exp: NOW - 1000 })), pub, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("expired");
  });

  it("rejects a not-yet-valid token", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims({ nbf: NOW + 1000 })), pub, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not yet valid");
  });

  it("20.6 rejects a wrong typ (Bearer/ID token replayed as at+jwt)", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(
      await mint(priv, claims(), { typ: "JWT", alg: "EdDSA", kid: "k1" }),
      pub,
      OPTS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("wrong typ");
  });

  it("rejects a wrong issuer", async () => {
    const { priv, pub } = await keypair();
    const r = await verifyBundleToken(await mint(priv, claims({ iss: "https://evil.example" })), pub, OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("issuer");
  });

  it("rejects a malformed jwt", async () => {
    const { pub } = await keypair();
    const r = await verifyBundleToken("not.a", pub, OPTS);
    expect(r.ok).toBe(false);
  });
});
