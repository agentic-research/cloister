/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_REFRESH_MS,
  CaUnavailableError,
  type CABundle,
  _resetCache,
  getCABundle,
  isCertEpochCurrent,
} from "../../src/storage/ca-bundle-cache.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeBundle(overrides: Partial<CABundle> = {}): CABundle {
  return {
    epoch:     7,
    seqno:     42,
    keys:      { kid_a: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    keyId:     "kid_a",
    issuedAt:  1_700_000_000,
    signature: "sig-base64-placeholder",
    ...overrides,
  };
}

afterEach(() => _resetCache());

// ── Caching ───────────────────────────────────────────────────────────────

describe("getCABundle", () => {
  it("populates cache on first call", async () => {
    const bundle = makeBundle();
    const fetcher = async () => bundle;
    const got = await getCABundle(fetcher, 0);
    expect(got).toBe(bundle);
  });

  it("returns cached bundle inside refresh window without re-fetching", async () => {
    const bundle = makeBundle({ epoch: 1 });
    let fetchCalls = 0;
    const fetcher = async () => { fetchCalls++; return bundle; };

    await getCABundle(fetcher, 0);
    await getCABundle(fetcher, 1_000);                         // 1s later
    await getCABundle(fetcher, BUNDLE_REFRESH_MS - 1);          // just inside window

    expect(fetchCalls).toBe(1);
  });

  it("re-fetches when refresh window expires", async () => {
    const v1 = makeBundle({ epoch: 1 });
    const v2 = makeBundle({ epoch: 2 });
    let next = v1;
    let fetchCalls = 0;
    const fetcher = async () => { fetchCalls++; return next; };

    const a = await getCABundle(fetcher, 0);
    next = v2;
    const b = await getCABundle(fetcher, BUNDLE_REFRESH_MS + 1);

    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(2);
    expect(fetchCalls).toBe(2);
  });

  it("throws CaUnavailableError when fetcher returns null and cache empty", async () => {
    const fetcher = async () => null;
    await expect(getCABundle(fetcher, 0)).rejects.toBeInstanceOf(CaUnavailableError);
  });

  it("throws CaUnavailableError when fetcher returns null and cache is stale", async () => {
    const bundle = makeBundle();
    let next: CABundle | null = bundle;
    const fetcher = async () => next;

    await getCABundle(fetcher, 0);                             // populates cache
    next = null;                                               // notme goes down
    await expect(
      getCABundle(fetcher, BUNDLE_REFRESH_MS + 1),             // window expired
    ).rejects.toBeInstanceOf(CaUnavailableError);
  });

  it("throws CaUnavailableError when fetcher itself throws", async () => {
    const fetcher = async () => { throw new Error("network"); };
    await expect(getCABundle(fetcher, 0)).rejects.toBeInstanceOf(CaUnavailableError);
  });

  it("respects custom refresh window", async () => {
    const bundle = makeBundle();
    let fetchCalls = 0;
    const fetcher = async () => { fetchCalls++; return bundle; };

    await getCABundle(fetcher, 0,    1_000);                   // refresh = 1s
    await getCABundle(fetcher, 500,  1_000);                   // still cached
    await getCABundle(fetcher, 1_500, 1_000);                   // window passed

    expect(fetchCalls).toBe(2);
  });
});

// ── Epoch comparison ─────────────────────────────────────────────────────

describe("isCertEpochCurrent", () => {
  it("accepts cert.epoch === bundle.epoch", () => {
    const b = makeBundle({ epoch: 5 });
    expect(isCertEpochCurrent(5, b)).toBe(true);
  });

  it("rejects cert.epoch > bundle.epoch (cert claims newer than reality)", () => {
    const b = makeBundle({ epoch: 5 });
    expect(isCertEpochCurrent(6, b)).toBe(false);
  });

  it("rejects cert.epoch far behind bundle (cert revoked)", () => {
    const b = makeBundle({ epoch: 5 });
    expect(isCertEpochCurrent(1, b)).toBe(false);
    expect(isCertEpochCurrent(3, b)).toBe(false);
  });

  it("accepts cert.epoch === bundle.epoch - 1 ONLY when prevKeyId set (rotation window)", () => {
    const inWindow  = makeBundle({ epoch: 5, prevKeyId: "kid_old" });
    const noWindow  = makeBundle({ epoch: 5 });
    expect(isCertEpochCurrent(4, inWindow)).toBe(true);
    expect(isCertEpochCurrent(4, noWindow)).toBe(false);
  });

  it("rejects cert.epoch === bundle.epoch - 2 even with prevKeyId", () => {
    const inWindow = makeBundle({ epoch: 5, prevKeyId: "kid_old" });
    expect(isCertEpochCurrent(3, inWindow)).toBe(false);
  });
});

// ── Signature verification integration (cloister-c614ae) ─────────────────

import { bundleCanonical } from "../../src/storage/bundle-canonical.js";

async function makeRootKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  let bin = "";
  const bytes = new Uint8Array(raw);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return { privateKey: kp.privateKey, publicKeyB64: btoa(bin) };
}

async function signedBundle(
  base: Omit<CABundle, "signature">,
  key: CryptoKey,
): Promise<CABundle> {
  const sig = new Uint8Array(
    (await crypto.subtle.sign("Ed25519", key, bundleCanonical({ ...base, signature: "" }) as BufferSource)) as ArrayBuffer,
  );
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]!);
  return { ...base, signature: btoa(bin) };
}

describe("getCABundle — signature verification", () => {
  const baseBundle = (): Omit<CABundle, "signature"> => ({
    epoch:    7,
    seqno:    1,
    keys:     { active: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
    keyId:    "active",
    issuedAt: 1_700_000_050,
  });

  it("accepts a properly-signed bundle when rootPubkey is set", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const signed = await signedBundle(baseBundle(), root.privateKey);

    const result = await getCABundle(
      async () => signed,
      Date.now(),
      { rootPubkey: root.publicKeyB64 },
    );
    expect(result.epoch).toBe(7);
  });

  it("rejects a bundle signed by a DIFFERENT root", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const otherRoot = await makeRootKeyPair();
    const signed = await signedBundle(baseBundle(), otherRoot.privateKey);

    await expect(
      getCABundle(async () => signed, Date.now(), { rootPubkey: root.publicKeyB64 }),
    ).rejects.toThrow(CaUnavailableError);
  });

  it("rejects a tampered bundle (epoch swapped post-sign)", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const signed = await signedBundle(baseBundle(), root.privateKey);
    const tampered: CABundle = { ...signed, epoch: 999 };

    await expect(
      getCABundle(async () => tampered, Date.now(), { rootPubkey: root.publicKeyB64 }),
    ).rejects.toThrow(CaUnavailableError);
  });

  it("does NOT cache an unverified bundle (next fetch sees a fresh failure)", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const otherRoot = await makeRootKeyPair();
    const bad = await signedBundle(baseBundle(), otherRoot.privateKey);

    let calls = 0;
    const fetcher = async () => { calls++; return bad; };
    await expect(
      getCABundle(fetcher, Date.now(), { rootPubkey: root.publicKeyB64 }),
    ).rejects.toThrow(CaUnavailableError);
    await expect(
      getCABundle(fetcher, Date.now(), { rootPubkey: root.publicKeyB64 }),
    ).rejects.toThrow(CaUnavailableError);
    expect(calls).toBe(2);  // fetched fresh both times — no poison-cache
  });

  it("skips verification when rootPubkey is undefined (dev mode, opt-in)", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const signed = await signedBundle(baseBundle(), root.privateKey);

    // No rootPubkey → no verification → bundle accepted regardless.
    const result = await getCABundle(async () => signed, Date.now(), {});
    expect(result.epoch).toBe(7);
  });

  it("skips verification when rootPubkey is empty string (dev mode)", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const signed = await signedBundle(baseBundle(), root.privateKey);

    const result = await getCABundle(async () => signed, Date.now(), { rootPubkey: "" });
    expect(result.epoch).toBe(7);
  });

  it("backwards-compat: third arg as bare refreshMs number still works", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const signed = await signedBundle(baseBundle(), root.privateKey);

    const result = await getCABundle(async () => signed, Date.now(), 60_000);
    expect(result.epoch).toBe(7);
  });
});
