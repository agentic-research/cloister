// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

// AES-GCM envelope encryption for credential header values.
//
// Architecture:
//   KEK (key encryption key) — derived from Worker secret via HKDF.
//   DEK (data encryption key) — random AES-256-GCM key, generated per-encrypt.
//   Sealed blob = { wrappedDek, iv, ciphertext } — all base64url.
//
// The DEK encrypts the plaintext. The KEK wraps the DEK.
// Rotating the KEK means re-wrapping all DEKs (not re-encrypting data).
//
// Pure Web Crypto — no npm dependencies.

/** Sealed envelope: stored in DO SQLite instead of plaintext headers. */
export interface SealedCredential {
  /** AES-256-GCM DEK wrapped by the KEK (base64url). */
  wrappedDek: string;
  /** 96-bit IV for the AES-GCM encryption (base64url). */
  iv: string;
  /** AES-GCM ciphertext of JSON-serialized headers (base64url). */
  ciphertext: string;
}

// ── KEK derivation ──────────────────────────────────────────────────────────

const HKDF_SALT = new TextEncoder().encode("notme-vault-kek-v1");
const HKDF_INFO = new TextEncoder().encode("credential-encryption");

/**
 * Derive a KEK from a secret string using HKDF-SHA256.
 * Deterministic: same secret → same key.
 */
export async function deriveKEK(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", salt: HKDF_SALT, info: HKDF_INFO, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false, // NOT extractable — key material never leaves Web Crypto
    ["wrapKey", "unwrapKey"],
  );
}

// ── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt credential headers using envelope encryption.
 *
 * 1. Generate a random AES-256-GCM DEK
 * 2. Encrypt the JSON-serialized headers with the DEK
 * 3. Wrap the DEK with the KEK (AES-GCM key wrapping)
 * 4. Return { wrappedDek, iv, ciphertext } — all base64url
 */
export async function encrypt(
  headers: Record<string, string>,
  kek: CryptoKey,
): Promise<SealedCredential> {
  // Generate random DEK. The cast is needed because subtle.generateKey's
  // return type is `CryptoKey | CryptoKeyPair` (depends on the algorithm
  // name, which TS can't narrow on); for symmetric AES-GCM it's always
  // CryptoKey.
  const dek = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable — we need to wrap it
    ["encrypt"],
  )) as CryptoKey;

  // Encrypt plaintext with DEK
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const plaintext = new TextEncoder().encode(JSON.stringify(headers));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dek,
    plaintext,
  );

  // Wrap DEK with KEK
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDekBuf = await crypto.subtle.wrapKey(
    "raw",
    dek,
    kek,
    { name: "AES-GCM", iv: wrapIv },
  );

  // Encode: prefix wrap IV to wrapped DEK so we can unwrap later
  const wrappedWithIv = new Uint8Array(12 + wrappedDekBuf.byteLength);
  wrappedWithIv.set(wrapIv, 0);
  wrappedWithIv.set(new Uint8Array(wrappedDekBuf), 12);

  return {
    wrappedDek: b64url(wrappedWithIv),
    iv: b64url(iv),
    ciphertext: b64url(new Uint8Array(ciphertextBuf)),
  };
}

// ── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypt a sealed credential envelope.
 *
 * 1. Unwrap the DEK using the KEK
 * 2. Decrypt the ciphertext using the DEK + IV
 * 3. Parse the JSON headers
 */
export async function decrypt(
  sealed: SealedCredential,
  kek: CryptoKey,
): Promise<Record<string, string>> {
  // Decode
  const wrappedWithIv = b64decode(sealed.wrappedDek);
  const wrapIv = wrappedWithIv.slice(0, 12);
  const wrappedDekBytes = wrappedWithIv.slice(12);
  const iv = b64decode(sealed.iv);
  const ciphertext = b64decode(sealed.ciphertext);

  // Unwrap DEK
  const dek = await crypto.subtle.unwrapKey(
    "raw",
    wrappedDekBytes,
    kek,
    { name: "AES-GCM", iv: wrapIv },
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Decrypt
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    dek,
    ciphertext,
  );

  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// ── Helpers — base64url no-padding ───────────────────────────────────────────
//
// Inlined here on 2026-05-09 during the cloister-side lift (cloister-9ad9eb).
// Originally imported from notme's gen/ts/dpop module; cloister doesn't
// have a DPoP layer of its own yet (ADR-0010 phases 3+ wire the vault into
// the manifest, at which point identity flows through the lease layer per
// ADR-0007). Until then, vault library functions speak base64url directly
// and don't depend on any identity-shaped notme code.
//
// Equivalent to RFC 4648 §5 (base64url alphabet) without padding (§3.2).
// Pure browser/workerd primitives — no third-party dep.

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
