// SPDX-License-Identifier: MIT
//
// VENDORED — do not hand-edit. Canonical source: notme `gen/ts/dpop.ts`
// (github.com/agentic-research/notme), pinned at commit 501a335. Re-vendor by
// copying that file verbatim and re-adding this header; keeping cloister's DPoP
// verify byte-identical to the notme issuer's is the whole point (cloister-0ae913
// — the prior hand-rolled verify drifted Ed25519-only while notme mints ES256/EC).
// notme licenses gen/ts under MIT (see notme NOTICE); cloister consumes it as the
// single source of truth for RFC 9449 + RFC 7638, and composes ADR-0047's
// §20.9/§20.10 checks OVER it in src/routes/bundle-auth.ts.
/**
 * dpop.ts — Shared DPoP utilities and verifier SDK.
 *
 * Provides:
 *   - computeJwkThumbprint() — RFC 7638 JWK Thumbprint
 *   - verifyDPoPToken()      — Full DPoP-bound access token verification
 *   - verifyAccessToken()    — Token-only verification (redirect flows, no DPoP proof)
 *
 * Used by notme (issuer), rig (verifier), and any Cloudflare Worker
 * that needs to verify tokens from auth.notme.bot.
 *
 * Pure Web Crypto — no npm dependencies.
 */

// ── Public types ────────────────────────────────────────────────────────────

/** Minimal KV interface — compatible with CF KV but not coupled to it. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** Options for verifyAccessToken() — token-only verification without DPoP proof. */
export interface VerifyAccessTokenOptions {
  /** The access_token JWT (EdDSA-signed by auth.notme.bot). */
  token: string;
  /** JWKS endpoint URL (e.g. "https://auth.notme.bot/.well-known/jwks.json"). */
  jwksUrl: string;
  /** Optional KV store for caching the JWKS (1-hour TTL). Falls back to fetch-only. */
  kv?: KVLike;
  /** Provide the Ed25519 public key directly — skips JWKS fetch entirely. */
  publicKey?: CryptoKey;
  /**
   * Expected audience — string or array. REQUIRED. Resource servers MUST
   * set this to their own URL to prevent confused-deputy: a token minted
   * for a different resource server (same notme issuer, same public key)
   * would otherwise pass this verifier.
   *
   * The worker side made `expectedAudience` required at the type level
   * for verifyOIDC/verifyProof; the SDK now mirrors that for symmetry.
   * If a caller genuinely doesn't want audience pinning (test fixtures,
   * a future federated-issuer setup), pass an empty array `[]` and the
   * caller takes ownership of any failure mode that creates.
   */
  audience: string | string[];
  /**
   * Expected issuer — when set, rejects tokens whose `iss` claim doesn't
   * match. Defaults to no check so the SDK works with self-hosted notme
   * deployments under different domains; notme-internal callers should
   * pass `"https://auth.notme.bot"`.
   */
  issuer?: string;
}

/** Options for verifyDPoPToken(). */
export interface VerifyDPoPTokenOptions {
  /** The access_token JWT (EdDSA-signed by auth.notme.bot). */
  token: string;
  /** The DPoP proof JWT (ES256-signed by the client). */
  proof: string;
  /** Expected HTTP method (e.g. "GET", "POST"). */
  method: string;
  /** Expected request URL — exact match per RFC 9449 Section 4.3. */
  url: string;
  /** JWKS endpoint URL (e.g. "https://auth.notme.bot/.well-known/jwks.json"). */
  jwksUrl: string;
  /** Optional KV store for caching the JWKS (1-hour TTL). Falls back to fetch-only. */
  kv?: KVLike;
  /**
   * Provide the Ed25519 public key directly — skips JWKS fetch entirely.
   * Useful for tests or environments where the key is already known.
   */
  publicKey?: CryptoKey;
}

/** Claims returned on successful verification. */
export interface VerifiedTokenClaims {
  /** Subject (user/principal identifier). */
  sub: string;
  /** Space-separated scope string. */
  scope: string;
  /** Audience. */
  aud: string;
  /** Expiry (Unix seconds). */
  exp: number;
  /** JWT ID. */
  jti: string;
}

// ── JWK Thumbprint (RFC 7638) ───────────────────────────────────────────────

/**
 * Compute a JWK Thumbprint per RFC 7638.
 *
 * 1. Extract only the required members for the key type (lexicographically sorted).
 *    - EC (kty "EC"): crv, kty, x, y
 *    - (RSA/OKP could be added later if needed)
 * 2. JSON.stringify with no whitespace.
 * 3. SHA-256 hash via crypto.subtle.digest.
 * 4. Base64url encode (no padding).
 */
export async function computeJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = buildCanonicalJson(jwk);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64urlEncode(new Uint8Array(hash));
}

// ── DPoP Token Verifier ─────────────────────────────────────────────────────

const JWKS_CACHE_KEY = "__notme_jwks";
const JWKS_TTL = 3600; // 1 hour

/**
 * Verify a DPoP-bound access token from auth.notme.bot.
 *
 * Performs all four verification steps:
 *   1. Fetch the Ed25519 signing key from JWKS (with optional KV caching)
 *   2. Verify the access token's EdDSA signature and validate claims
 *   3. Verify the DPoP proof's ES256 signature and validate htm/htu (exact match)
 *   4. Verify cnf.jkt binding — proof key thumbprint must match token claim
 *
 * @returns Verified token claims on success.
 * @throws Error with a descriptive message on any validation failure.
 */
export async function verifyDPoPToken(
  opts: VerifyDPoPTokenOptions,
): Promise<VerifiedTokenClaims> {
  const { token, proof, method, url, jwksUrl, kv, publicKey } = opts;

  // ── 1. Verify access token ──────────────────────────────────────────────

  const tokenParts = token.split(".");
  if (tokenParts.length !== 3) {
    throw new Error("Malformed access token: expected 3 parts");
  }
  const [tHeaderB64, tPayloadB64, tSigB64] = tokenParts;

  // Get the signing key
  const signingKey = publicKey ?? (await fetchSigningKey(jwksUrl, kv));

  // Verify Ed25519 signature
  const tSigInput = new TextEncoder().encode(`${tHeaderB64}.${tPayloadB64}`);
  const tSig = base64urlDecodeBytes(tSigB64);
  const tokenValid = await crypto.subtle.verify(
    { name: "Ed25519" } as any,
    signingKey,
    tSig,
    tSigInput,
  );
  if (!tokenValid) {
    throw new Error("Invalid access token signature");
  }

  // Parse and validate token claims
  const tPayload = jsonParse(base64urlDecodeStr(tPayloadB64), "access token payload");
  const now = Math.floor(Date.now() / 1000);

  if (typeof tPayload.exp !== "number" || tPayload.exp <= now) {
    throw new Error("Access token expired");
  }
  if (typeof tPayload.iat === "number" && tPayload.iat > now + 60) {
    throw new Error("Access token iat is in the future");
  }
  if (!tPayload.sub || typeof tPayload.sub !== "string") {
    throw new Error("Access token missing sub claim");
  }

  // ── 2. Verify DPoP proof ───────────────────────────────────────────────

  const proofParts = proof.split(".");
  if (proofParts.length !== 3) {
    throw new Error("Malformed DPoP proof: expected 3 parts");
  }
  const [pHeaderB64, pPayloadB64, pSigB64] = proofParts;

  const pHeader = jsonParse(base64urlDecodeStr(pHeaderB64), "DPoP proof header");

  if (pHeader.typ !== "dpop+jwt") {
    throw new Error(`DPoP proof typ must be "dpop+jwt", got "${pHeader.typ}"`);
  }
  if (!pHeader.jwk || typeof pHeader.jwk !== "object") {
    throw new Error("DPoP proof header must contain a jwk");
  }

  // Import proof key and verify signature (support ES256 and EdDSA)
  const proofJwk = pHeader.jwk;
  let proofKey: CryptoKey;
  let verifyAlg: { name: string; hash?: string };

  if (proofJwk.kty === "EC") {
    proofKey = await crypto.subtle.importKey(
      "jwk",
      proofJwk,
      { name: "ECDSA", namedCurve: proofJwk.crv || "P-256" },
      true,
      ["verify"],
    );
    verifyAlg = { name: "ECDSA", hash: "SHA-256" };
  } else if (proofJwk.kty === "OKP" && proofJwk.crv === "Ed25519") {
    proofKey = await crypto.subtle.importKey(
      "jwk",
      proofJwk,
      { name: "Ed25519" } as any,
      true,
      ["verify"],
    );
    verifyAlg = { name: "Ed25519" } as any;
  } else {
    throw new Error(`Unsupported DPoP proof key type: ${proofJwk.kty}`);
  }

  const pSigInput = new TextEncoder().encode(`${pHeaderB64}.${pPayloadB64}`);
  const pSig = base64urlDecodeBytes(pSigB64);
  const proofValid = await crypto.subtle.verify(
    verifyAlg,
    proofKey,
    pSig,
    pSigInput,
  );
  if (!proofValid) {
    throw new Error("Invalid DPoP proof signature");
  }

  // Validate proof claims (strict per RFC 9449 Section 4.3)
  const pPayload = jsonParse(base64urlDecodeStr(pPayloadB64), "DPoP proof payload");

  // jti required — without it, replay detection is impossible
  if (!pPayload.jti || typeof pPayload.jti !== "string") {
    throw new Error("DPoP proof missing jti claim");
  }

  // iat required and must be within 60s — prevents replay of intercepted proofs
  if (typeof pPayload.iat !== "number") {
    throw new Error("DPoP proof missing iat claim");
  }
  const proofAge = now - pPayload.iat;
  if (proofAge > 60 || proofAge < -60) {
    throw new Error(
      `DPoP proof iat is too old or in the future (age: ${proofAge}s, max: 60s)`,
    );
  }

  if (pPayload.htm !== method) {
    throw new Error(
      `DPoP proof htm mismatch: expected "${method}", got "${pPayload.htm}"`,
    );
  }
  if (pPayload.htu !== url) {
    throw new Error(
      `DPoP proof htu mismatch: expected "${url}", got "${pPayload.htu}"`,
    );
  }

  // ── 3. Verify cnf.jkt binding ──────────────────────────────────────────

  if (!tPayload.cnf || !tPayload.cnf.jkt) {
    throw new Error("Access token missing cnf.jkt claim");
  }

  const thumbprint = await computeJwkThumbprint(proofJwk);
  if (thumbprint !== tPayload.cnf.jkt) {
    throw new Error("DPoP key binding mismatch: proof key thumbprint does not match cnf.jkt");
  }

  // ── 4. Return verified claims ──────────────────────────────────────────

  return {
    sub: tPayload.sub,
    scope: tPayload.scope ?? "",
    aud: tPayload.aud ?? "",
    exp: tPayload.exp,
    jti: tPayload.jti ?? "",
  };
}

// ── Access Token Verifier (no DPoP proof) ──────────────────────────────────

/**
 * Verify an access token from auth.notme.bot without requiring a DPoP proof.
 *
 * Use this for redirect flows where the DPoP keypair is ephemeral and lost
 * after the browser redirect. The token's EdDSA signature and claims are
 * verified against the JWKS, but DPoP binding (cnf.jkt) is not checked.
 *
 * The token is still trustworthy: notme verified the DPoP binding at mint time,
 * the token is EdDSA-signed, short-lived (5 min), and JTI-unique.
 */
export async function verifyAccessToken(
  opts: VerifyAccessTokenOptions,
): Promise<VerifiedTokenClaims> {
  const { token, jwksUrl, kv, publicKey, audience, issuer } = opts;

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed access token: expected 3 parts");
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // Get the signing key
  const signingKey = publicKey ?? (await fetchSigningKey(jwksUrl, kv));

  // Verify Ed25519 signature
  const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64urlDecodeBytes(sigB64);
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" } as any,
    signingKey,
    sig,
    sigInput,
  );
  if (!valid) {
    throw new Error("Invalid access token signature");
  }

  // Parse and validate claims via the shared validator — covers exp, nbf,
  // iat, iss, aud, sub uniformly so the resource-server path uses the same
  // claim-check logic as the issuer path. Earlier this function inlined a
  // partial check that omitted nbf, iss, and aud (rosary-81353c).
  const payload = jsonParse(base64urlDecodeStr(payloadB64), "access token payload");
  // exp is a hard requirement here — `validateClaims` only checks it when
  // present, but accepting a token without exp would break the short-lived
  // contract (5-min TTL). Pre-check before delegating.
  if (typeof payload.exp !== "number") {
    throw new Error("Access token missing exp claim");
  }
  validateClaims(payload, {
    issuer,
    audience,
    requireSub: true,
  });

  // RFC 9449 Section 3: a DPoP-bound token (has cnf.jkt) MUST NOT be
  // accepted as a plain Bearer token. Rejecting here prevents downgrade
  // attacks where an attacker strips the DPoP header from a stolen token.
  if (payload.cnf) {
    throw new Error(
      "DPoP-bound token cannot be verified as Bearer — use verifyDPoPToken with a proof",
    );
  }

  return {
    sub: payload.sub as string,
    scope: (payload.scope as string | undefined) ?? "",
    aud: (payload.aud as string | undefined) ?? "",
    exp: payload.exp as number,
    jti: (payload.jti as string | undefined) ?? "",
  };
}

// ── JWKS fetching ───────────────────────────────────────────────────────────

/**
 * Fetch the Ed25519 signing key from a JWKS endpoint.
 * If a KV store is provided, the JWKS JSON is cached for 1 hour.
 */
async function fetchSigningKey(
  jwksUrl: string,
  kv?: KVLike,
): Promise<CryptoKey> {
  let jwksJson: string | null = null;

  // Try KV cache first
  if (kv) {
    jwksJson = await kv.get(JWKS_CACHE_KEY);
  }

  // Fetch if not cached
  if (!jwksJson) {
    const res = await fetch(jwksUrl);
    if (!res.ok) {
      throw new Error(`JWKS fetch failed: ${res.status}`);
    }
    jwksJson = await res.text();

    // Cache in KV if available
    if (kv) {
      await kv.put(JWKS_CACHE_KEY, jwksJson, { expirationTtl: JWKS_TTL });
    }
  }

  const jwks = JSON.parse(jwksJson) as {
    keys: Array<{ kty: string; crv: string; x: string; alg?: string; kid?: string }>;
  };
  const jwk = jwks.keys.find(
    (k) => k.kty === "OKP" && k.crv === "Ed25519",
  );
  if (!jwk) {
    throw new Error("No Ed25519 key found in JWKS");
  }

  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: "Ed25519" } as any,
    false,
    ["verify"],
  );
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Build the canonical JSON representation of a JWK per RFC 7638 Section 3.2.
 * Only includes required members for the key type, sorted lexicographically.
 */
function buildCanonicalJson(jwk: JsonWebKey): string {
  switch (jwk.kty) {
    case "EC": {
      // Required members for EC: crv, kty, x, y (alphabetical order)
      const obj = {
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
        y: jwk.y,
      };
      return JSON.stringify(obj);
    }
    case "RSA": {
      // Required members for RSA: e, kty, n (alphabetical order)
      const obj = {
        e: jwk.e,
        kty: jwk.kty,
        n: jwk.n,
      };
      return JSON.stringify(obj);
    }
    case "OKP": {
      // Required members for OKP: crv, kty, x (alphabetical order)
      const obj = {
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
      };
      return JSON.stringify(obj);
    }
    default:
      throw new Error(`Unsupported key type: ${jwk.kty}`);
  }
}

// ── Exported primitives ─────────────────────────────────────────────────────
// Single implementation for all JWT code. Patterns from jose (MIT, Filip Skokan).

/**
 * Base64url encode bytes (no padding, URL-safe).
 * Chunked at 32KB to prevent stack overflow on large payloads.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Base64url decode to bytes. Handles both URL-safe and standard base64.
 * Throws on malformed input (try/catch around atob).
 */
export function base64urlDecode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Failed to base64url decode: malformed input");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Internal aliases used by existing code — delegates to exported functions.
function base64urlDecodeBytes(s: string): Uint8Array {
  return base64urlDecode(s);
}
function base64urlDecodeStr(s: string): string {
  return new TextDecoder().decode(base64urlDecode(s));
}

/**
 * Parse JSON with labeled error. Rejects non-object results (arrays, primitives, null).
 * jose pattern: JWT Claims Set must be a top-level JSON object.
 */
export function jsonParseSafe(s: string, label: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

// Internal alias for existing code.
function jsonParse(s: string, label: string): Record<string, any> {
  return jsonParseSafe(s, label);
}

/**
 * Validate JWT claims per RFC 7519 + jose patterns.
 *
 * Checks: exp (required unless opts say otherwise), nbf, iat, iss, aud, sub.
 * Type-checks all numeric claims before comparison.
 * Clock tolerance applied to `now`, not claim values.
 */
export interface ValidateClaimsOptions {
  /** Expected issuer — rejects if payload.iss doesn't match. */
  issuer?: string;
  /** Expected audience — string or array. Rejects if no match. */
  audience?: string | string[];
  /** Clock tolerance in seconds (default 0). */
  clockTolerance?: number;
  /** Require sub claim to be present and a string. */
  requireSub?: boolean;
}

export function validateClaims(
  payload: Record<string, unknown>,
  opts: ValidateClaimsOptions,
): void {
  const tolerance = opts.clockTolerance ?? 0;
  const now = Math.floor(Date.now() / 1000);

  // ── exp: type-check, then compare with tolerance ──
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== "number") {
      throw new Error('"exp" claim must be a number');
    }
    if (payload.exp <= now - tolerance) {
      throw new Error('"exp" claim timestamp check failed (token expired)');
    }
  }

  // ── nbf: validate only if present ──
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number") {
      throw new Error('"nbf" claim must be a number');
    }
    if (payload.nbf > now + tolerance) {
      throw new Error('"nbf" claim timestamp check failed (token not yet valid)');
    }
  }

  // ── iat: validate only if present ──
  if (payload.iat !== undefined) {
    if (typeof payload.iat !== "number") {
      throw new Error('"iat" claim must be a number');
    }
    if (payload.iat > now + 60 + tolerance) {
      throw new Error('"iat" claim is too far in the future');
    }
  }

  // ── iss: required when issuer option is set ──
  if (opts.issuer !== undefined) {
    if (payload.iss === undefined) {
      throw new Error('"iss" claim missing (required by issuer option)');
    }
    if (payload.iss !== opts.issuer) {
      throw new Error(`"iss" claim mismatch: expected "${opts.issuer}", got "${payload.iss}"`);
    }
  }

  // ── aud: required when audience option is set (handles string + array) ──
  if (opts.audience !== undefined) {
    if (payload.aud === undefined) {
      throw new Error('"aud" claim missing (required by audience option)');
    }
    const expected = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
    const actual = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const match = actual.some(
      (a: unknown) => typeof a === "string" && expected.includes(a),
    );
    if (!match) {
      throw new Error(`"aud" claim mismatch: expected ${expected.join(",")}, got ${actual.join(",")}`);
    }
  }

  // ── sub: required when requireSub option is set ──
  if (opts.requireSub) {
    if (payload.sub === undefined) {
      throw new Error('"sub" claim missing (required)');
    }
    if (typeof payload.sub !== "string") {
      throw new Error('"sub" claim must be a string');
    }
  }
}
