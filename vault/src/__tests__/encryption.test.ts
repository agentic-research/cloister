// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

/**
 * encryption.test.ts — TDD tests for envelope encryption.
 *
 * Credential header values must be AES-GCM encrypted before storage.
 * KEK (key encryption key) from Worker secret. Per-credential DEK
 * (data encryption key) generated and wrapped alongside ciphertext.
 *
 * Threat model: CF holds disk encryption keys. App-level encryption
 * means a CF infrastructure compromise still can't read credentials.
 */

import { describe, expect, it, beforeAll } from "vitest";

async function getCrypto() {
  return import("../crypto");
}

// ── Key derivation ─────────────────────────────────────────────────────────

describe("deriveKEK", () => {
  it("derives a 256-bit AES-GCM key from a secret string", async () => {
    const { deriveKEK } = await getCrypto();
    const kek = await deriveKEK("my-worker-secret-abc123");

    expect(kek.type).toBe("secret");
    expect(kek.algorithm).toMatchObject({ name: "AES-GCM" });
    expect(kek.usages).toContain("wrapKey");
    expect(kek.usages).toContain("unwrapKey");
  });

  it("same secret produces same KEK (deterministic via encrypt/decrypt)", async () => {
    const { deriveKEK, encrypt, decrypt } = await getCrypto();
    const k1 = await deriveKEK("same-secret");
    const k2 = await deriveKEK("same-secret");

    // Encrypt with k1, decrypt with k2 — proves they're the same key
    const headers = { proof: "deterministic" };
    const sealed = await encrypt(headers, k1);
    const opened = await decrypt(sealed, k2);
    expect(opened).toEqual(headers);
  });

  it("different secrets produce different KEKs", async () => {
    const { deriveKEK, encrypt, decrypt } = await getCrypto();
    const k1 = await deriveKEK("secret-a");
    const k2 = await deriveKEK("secret-b");

    // Encrypt with k1, fail to decrypt with k2
    const sealed = await encrypt({ key: "val" }, k1);
    await expect(decrypt(sealed, k2)).rejects.toThrow();
  });
});

// ── Encrypt / decrypt roundtrip ────────────────────────────────────────────

describe("encrypt + decrypt", () => {
  let kek: CryptoKey;

  beforeAll(async () => {
    const { deriveKEK } = await getCrypto();
    kek = await deriveKEK("test-kek-secret");
  });

  it("roundtrips a credential headers object", async () => {
    const { encrypt, decrypt } = await getCrypto();

    const headers = { apiKey: "sk-live-abc123", Authorization: "Bearer gh_token" };
    const sealed = await encrypt(headers, kek);
    const opened = await decrypt(sealed, kek);

    expect(opened).toEqual(headers);
  });

  it("produces different ciphertext each time (unique IV)", async () => {
    const { encrypt } = await getCrypto();

    const headers = { apiKey: "same-value" };
    const s1 = await encrypt(headers, kek);
    const s2 = await encrypt(headers, kek);

    // Sealed blobs must differ (different IV + different DEK)
    expect(s1).not.toEqual(s2);
  });

  it("fails to decrypt with wrong KEK", async () => {
    const { deriveKEK, encrypt, decrypt } = await getCrypto();

    const rightKek = await deriveKEK("right-secret");
    const wrongKek = await deriveKEK("wrong-secret");

    const headers = { apiKey: "secret" };
    const sealed = await encrypt(headers, rightKek);

    await expect(decrypt(sealed, wrongKek)).rejects.toThrow();
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const { encrypt, decrypt } = await getCrypto();

    const headers = { apiKey: "secret" };
    const sealed = await encrypt(headers, kek);

    // Tamper with ciphertext
    const tampered = { ...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + "AAAA" };
    await expect(decrypt(tampered, kek)).rejects.toThrow();
  });

  it("sealed blob contains no plaintext credential values", async () => {
    const { encrypt } = await getCrypto();

    const secret = "sk-live-SUPER-SECRET-KEY-12345";
    const headers = { apiKey: secret };
    const sealed = await encrypt(headers, kek);

    // Stringify the entire sealed object — the secret must not appear
    const json = JSON.stringify(sealed);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("SUPER-SECRET");
  });

  it("handles empty headers", async () => {
    const { encrypt, decrypt } = await getCrypto();

    const sealed = await encrypt({}, kek);
    const opened = await decrypt(sealed, kek);
    expect(opened).toEqual({});
  });

  it("handles headers with special characters", async () => {
    const { encrypt, decrypt } = await getCrypto();

    const headers = {
      key: 'value with "quotes" and \\ backslashes',
      unicode: "emoji: \u{1F680} and \u{1F389}",
    };
    const sealed = await encrypt(headers, kek);
    const opened = await decrypt(sealed, kek);
    expect(opened).toEqual(headers);
  });
});

// ── Sealed blob structure ──────────────────────────────────────────────────

describe("sealed blob structure", () => {
  it("contains wrappedDek, iv, ciphertext — all base64url", async () => {
    const { deriveKEK, encrypt } = await getCrypto();
    const kek = await deriveKEK("test");
    const sealed = await encrypt({ key: "val" }, kek);

    expect(typeof sealed.wrappedDek).toBe("string");
    expect(typeof sealed.iv).toBe("string");
    expect(typeof sealed.ciphertext).toBe("string");

    // All should be base64url (no +, /, or =)
    for (const field of [sealed.wrappedDek, sealed.iv, sealed.ciphertext]) {
      expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
