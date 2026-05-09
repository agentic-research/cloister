/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { bundleCanonical, verifyBundleSignature } from "../../src/storage/bundle-canonical.js";
import type { CABundle } from "../../src/storage/ca-bundle-cache.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function b64Std(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function makeRootKey(): Promise<{
  privateKey: CryptoKey;
  publicKeyB64: string;
  publicKeyBytes: Uint8Array;
}> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  const bytes = new Uint8Array(raw);
  return {
    privateKey: kp.privateKey,
    publicKeyB64: b64Std(bytes),
    publicKeyBytes: bytes,
  };
}

async function signBundle(bundle: Omit<CABundle, "signature">, key: CryptoKey): Promise<CABundle> {
  const tmp: CABundle = { ...bundle, signature: "" };
  const canonical = bundleCanonical(tmp);
  const sigBytes = new Uint8Array(
    (await crypto.subtle.sign("Ed25519", key, canonical as BufferSource)) as ArrayBuffer,
  );
  return { ...bundle, signature: b64Std(sigBytes) };
}

const SAMPLE_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 32 bytes
const SAMPLE_KEY2_B64 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8="; // 32 bytes

function fixtureBundle(): Omit<CABundle, "signature"> {
  return {
    epoch:    7,
    seqno:    1,
    keys:     { active: SAMPLE_KEY_B64 },
    keyId:    "active",
    issuedAt: 1_700_000_050,
  };
}

// ── bundleCanonical: byte-stability ──────────────────────────────────────

describe("bundleCanonical", () => {
  it("produces deterministic bytes (same input -> same output)", () => {
    const a = bundleCanonical({ ...fixtureBundle(), signature: "" });
    const b = bundleCanonical({ ...fixtureBundle(), signature: "" });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("excludes the signature field from the canonical bytes", () => {
    const noSig = bundleCanonical({ ...fixtureBundle(), signature: "" });
    const withSig = bundleCanonical({ ...fixtureBundle(), signature: "tampered" });
    expect(Array.from(noSig)).toEqual(Array.from(withSig));
  });

  it("changes when epoch changes", () => {
    const a = bundleCanonical({ ...fixtureBundle(), signature: "" });
    const b = bundleCanonical({ ...fixtureBundle(), epoch: 8, signature: "" });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("changes when keys map changes (different key bytes)", () => {
    const a = bundleCanonical({ ...fixtureBundle(), signature: "" });
    const b = bundleCanonical({
      ...fixtureBundle(),
      keys: { active: SAMPLE_KEY2_B64 },
      signature: "",
    });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("normalizes string-key order in the keys map (RFC 8949 §4.2)", () => {
    // Same set of keys, different insertion order — same canonical bytes.
    const a = bundleCanonical({
      ...fixtureBundle(),
      keys: { aaa: SAMPLE_KEY_B64, bbb: SAMPLE_KEY2_B64 },
      keyId: "aaa",
      signature: "",
    });
    const b = bundleCanonical({
      ...fixtureBundle(),
      keys: { bbb: SAMPLE_KEY2_B64, aaa: SAMPLE_KEY_B64 },
      keyId: "aaa",
      signature: "",
    });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("treats undefined prevKeyId as empty string (matches signet's Go side)", () => {
    const noPrev = bundleCanonical({ ...fixtureBundle(), signature: "" });
    const emptyPrev = bundleCanonical({
      ...fixtureBundle(),
      prevKeyId: "",
      signature: "",
    });
    expect(Array.from(noPrev)).toEqual(Array.from(emptyPrev));
  });
});

// ── verifyBundleSignature: end-to-end ────────────────────────────────────

describe("verifyBundleSignature", () => {
  it("accepts a properly-signed bundle", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    expect(await verifyBundleSignature(signed, root.publicKeyB64)).toBe(true);
  });

  it("accepts a base64url-encoded root pubkey (no padding)", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    const rootUrl = root.publicKeyB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyBundleSignature(signed, rootUrl)).toBe(true);
  });

  it("rejects when the bundle is signed by a DIFFERENT root", async () => {
    const root = await makeRootKey();
    const otherRoot = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    expect(await verifyBundleSignature(signed, otherRoot.publicKeyB64)).toBe(false);
  });

  it("rejects when bundle bytes are tampered (epoch flipped)", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    const tampered: CABundle = { ...signed, epoch: 999 };
    expect(await verifyBundleSignature(tampered, root.publicKeyB64)).toBe(false);
  });

  it("rejects when bundle bytes are tampered (key swap)", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    const tampered: CABundle = {
      ...signed,
      keys: { active: SAMPLE_KEY2_B64 },  // swapped key bytes
    };
    expect(await verifyBundleSignature(tampered, root.publicKeyB64)).toBe(false);
  });

  it("rejects when the signature is tampered", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    const sigBytes = atob(signed.signature);
    const sigArr = new Uint8Array(sigBytes.length);
    for (let i = 0; i < sigBytes.length; i++) sigArr[i] = sigBytes.charCodeAt(i);
    sigArr[0] ^= 0xFF;
    const tampered: CABundle = { ...signed, signature: b64Std(sigArr) };
    expect(await verifyBundleSignature(tampered, root.publicKeyB64)).toBe(false);
  });

  it("rejects when root pubkey is wrong length (not 32 bytes)", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    expect(await verifyBundleSignature(signed, b64Std(new Uint8Array(16)))).toBe(false);
    expect(await verifyBundleSignature(signed, b64Std(new Uint8Array(64)))).toBe(false);
  });

  it("rejects when root pubkey is malformed base64", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    expect(await verifyBundleSignature(signed, "not!valid!@#$%^&*")).toBe(false);
  });

  it("rejects when bundle.signature is malformed base64", async () => {
    const root = await makeRootKey();
    const signed = await signBundle(fixtureBundle(), root.privateKey);
    const tampered: CABundle = { ...signed, signature: "not!valid!@#$%^&*" };
    expect(await verifyBundleSignature(tampered, root.publicKeyB64)).toBe(false);
  });
});
