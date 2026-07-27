// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real notme-format DPoP fixtures — an EdDSA `at+jwt` access token + an ES256
// (EC P-256) DPoP proof + an RFC 7638 EC `cnf.jkt`. Ported from notme
// gen/ts/__tests__/dpop-verifier.test.ts so cloister's ADR-0047 composition is
// tested against the ACTUAL wire format the notme issuer mints — not a self-
// consistent Ed25519 stand-in, which is the bug cloister-0ae913 fixed.

import { computeJwkThumbprint, base64urlEncode } from "@agentic-research/dpop";

const b64urlStr = (s: string): string => base64urlEncode(new TextEncoder().encode(s));

/** notme's token-signing keypair (EdDSA). */
export async function generateEd25519(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" } as unknown as EcKeyGenParams, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

/** The client's DPoP proof keypair (ES256 / EC P-256) — what notme's mint requires. */
export async function generateP256(): Promise<{ keyPair: CryptoKeyPair; jwk: JsonWebKey }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  return { keyPair, jwk };
}

/** The raw 32-byte Ed25519 public key — the shape BundleAuthContext.notmePub wants. */
export async function rawEd25519Pub(kp: CryptoKeyPair): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
}

/** RFC 7638 thumbprint (EC) of a proof public JWK — the token's cnf.jkt. */
export async function jktOf(jwk: JsonWebKey): Promise<string> {
  return computeJwkThumbprint(jwk);
}

/** Mint an EdDSA `at+jwt` access token with cnf.jkt binding (notme's real shape). */
export async function mintToken(opts: {
  signingKey: CryptoKey;
  sub: string;
  jkt: string;
  scope: string;
  /** string | string[] — the array form exists to test cloister's REJECTION of
   *  multi-audience tokens (the SDK's RFC 7519 semantics would accept them). */
  audience: string | string[];
  issuer: string;
  kid?: string;
  expOverride?: number;
  iatOverride?: number;
  nbfOverride?: number;
  omitCnf?: boolean;
  omitKid?: boolean;
  headerOverrides?: Record<string, unknown>;
}): Promise<string> {
  const header: Record<string, unknown> = { typ: "at+jwt", alg: "EdDSA", kid: opts.kid ?? "9408457aefd071cec127c1f985399308" };
  if (opts.headerOverrides) Object.assign(header, opts.headerOverrides);
  if (opts.omitKid) delete header.kid;
  const iat = opts.iatOverride ?? Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: opts.sub,
    iss: opts.issuer,
    aud: opts.audience,
    iat,
    nbf: opts.nbfOverride ?? iat,
    exp: opts.expOverride ?? iat + 300,
    jti: crypto.randomUUID(),
    scope: opts.scope,
    ...(opts.omitCnf ? {} : { cnf: { jkt: opts.jkt } }),
  };
  const headerB64 = b64urlStr(JSON.stringify(header));
  const payloadB64 = b64urlStr(JSON.stringify(payload));
  const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519" as unknown as AlgorithmIdentifier, opts.signingKey, sigInput));
  return `${headerB64}.${payloadB64}.${base64urlEncode(sig)}`;
}

/** Build + sign an ES256 DPoP proof JWT (notme's real proof shape). */
export async function buildProof(opts: {
  /** Exact compact access-token bytes presented with this protected-resource proof. */
  accessToken?: string;
  keyPair: CryptoKeyPair;
  jwk: JsonWebKey;
  htm: string;
  htu: string;
  payloadOverrides?: Record<string, unknown>;
}): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: opts.jwk };
  const payload = {
    jti: crypto.randomUUID(),
    htm: opts.htm,
    htu: opts.htu,
    iat: Math.floor(Date.now() / 1000),
    ...(opts.accessToken
      ? {
          ath: base64urlEncode(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opts.accessToken)),
            ),
          ),
        }
      : {}),
    ...opts.payloadOverrides,
  };
  const headerB64 = b64urlStr(JSON.stringify(header));
  const payloadB64 = b64urlStr(JSON.stringify(payload));
  const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, opts.keyPair.privateKey, sigInput);
  return `${headerB64}.${payloadB64}.${base64urlEncode(new Uint8Array(sig))}`;
}
