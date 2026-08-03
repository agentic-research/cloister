// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lease-signer — the client half of the Interlace lease protocol.
//
// Given an ephemeral identity (cert + Ed25519 keypair) and the request a
// harness wants to make, produce the four Signet headers cloister's lease
// gate (`src/routes/lease-middleware.ts`) verifies:
//
//   Authorization:  Signet <base64url-cert-DER>
//   X-Signet-Sig:   <base64url Ed25519 sig over canonical bytes>
//   X-Signet-Ts:    <unix-ms>
//   X-Signet-Nonce: <base64url random ≥16 bytes>
//
// The signature is RAW Ed25519 over the canonical bytes — NOT ley-line-sign's
// CMS/PKCS#7 envelope. ley-line-sign verifies the *cert chain* server-side;
// this signs each *request*. Canonical-byte shape is byte-identical to
// `lease-middleware.ts:canonicalRequestBytes`:
//
//   <method>\n<full-url>\n<unix-ms-ts>\n<nonce-b64url-no-pad>\n<body>
//
// Pure Web Crypto (`globalThis.crypto.subtle`) so it runs unchanged in Node
// 20+ (the shim) and in workerd (the vitest proof). No Node built-ins here —
// keep it importable from `test/`. Per cloister-caab2d / ADR-0040.

/**
 * An ephemeral lease identity: the X.509 cert the cluster master minted, plus
 * the Ed25519 keypair whose public half is embedded in that cert. The private
 * seed signs each request; the cert travels in the Authorization header so the
 * server can extract the ephemeral pubkey and verify the signature.
 *
 * All three are base64url (no padding), matching the on-wire encoding the
 * lease middleware expects and the JWK `d`/`x` fields Web Crypto imports.
 */
export interface EphemeralIdentity {
  /** base64url DER of the X.509 lease cert. */
  certB64: string;
  /** base64url 32-byte Ed25519 private seed (JWK `d`). */
  privSeedB64: string;
  /** base64url 32-byte Ed25519 public key (JWK `x`). */
  pubKeyB64: string;
}

/**
 * The four headers to attach to the outbound request. Keys are lowercase so
 * they merge cleanly into a `Headers` / a Node header object without case
 * collisions.
 */
export interface SignetHeaders {
  authorization: string;
  "x-signet-sig": string;
  "x-signet-ts": string;
  "x-signet-nonce": string;
}

/**
 * Build the four Signet headers for one request.
 *
 * `url` MUST be the URL the *server* will observe (i.e. the cloister URL the
 * shim forwards to), because the signature binds it — signing the localhost
 * URL and forwarding to cloister would fail verification.
 *
 * `body` is the raw request body as a string (`""` for GET/HEAD — the server
 * canonicalizes those with an empty body).
 *
 * `tsMs` / `nonce` are injectable for deterministic tests; production omits
 * both (wall clock + a fresh 16-byte random nonce).
 */
export async function signLeaseHeaders(args: {
  method: string;
  url: string;
  body: string;
  identity: EphemeralIdentity;
  tsMs?: number;
  nonce?: Uint8Array;
}): Promise<SignetHeaders> {
  const tsMs = args.tsMs ?? Date.now();
  const nonce = args.nonce ?? randomNonce();
  const nonceB64 = b64uEncode(nonce);

  const canonical = new TextEncoder().encode(
    `${args.method}\n${args.url}\n${tsMs}\n${nonceB64}\n${args.body}`,
  );

  const key = await importSigningKey(args.identity);
  const sig = new Uint8Array(
    (await crypto.subtle.sign("Ed25519", key, canonical as BufferSource)) as ArrayBuffer,
  );

  return {
    authorization:    `Signet ${args.identity.certB64}`,
    "x-signet-sig":   b64uEncode(sig),
    "x-signet-ts":    String(tsMs),
    "x-signet-nonce": nonceB64,
  };
}

/**
 * Import the ephemeral Ed25519 private key from its JWK seed. Cached per
 * identity so a long-lived shim doesn't re-import on every request.
 */
const keyCache = new WeakMap<EphemeralIdentity, Promise<CryptoKey>>();

function importSigningKey(identity: EphemeralIdentity): Promise<CryptoKey> {
  let cached = keyCache.get(identity);
  if (cached === undefined) {
    const jwk: JsonWebKey = {
      kty: "OKP",
      crv: "Ed25519",
      d:   identity.privSeedB64,
      x:   identity.pubKeyB64,
    };
    cached = crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
    keyCache.set(identity, cached);
  }
  return cached;
}

function randomNonce(): Uint8Array {
  const out = new Uint8Array(16);
  crypto.getRandomValues(out);
  return out;
}

/** base64url encode (no padding) — matches the lease middleware's decoder. */
export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
