/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  NOTME_BUNDLE_PATH,
  notmeBundleFetcher,
} from "../../src/storage/notme-bundle-fetcher.js";
import type { CABundle } from "../../src/storage/ca-bundle-cache.js";
import type { Env } from "../../src/types.js";

// ── Fake NOTME service binding ──────────────────────────────────────────
//
// The vitest config stubs NOTME globally as a 503-responder. For these
// tests we want to exercise different responses per test, so we build
// custom Env objects with our own NOTME stub. workerd's Fetcher
// interface is shaped like `{ fetch: (req) => Promise<Response> }` —
// any object matching that works in place of the real binding.

type FetchResponder = (req: Request) => Promise<Response> | Response;

function envWithNotme(responder: FetchResponder): Env {
  return Object.assign({}, env, {
    NOTME: { fetch: responder } as unknown as Env["NOTME"],
  }) as Env;
}

const SAMPLE_BUNDLE: CABundle = {
  epoch:    7,
  seqno:    1,
  keys:     { active: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
  keyId:    "active",
  issuedAt: 1_700_000_050,
  signature: "AAECAwQFBgcICQoLDA0ODw==",
};

// ── Happy path ──────────────────────────────────────────────────────────

describe("notmeBundleFetcher — happy path", () => {
  it("calls the NOTME binding at NOTME_BUNDLE_PATH and returns the parsed JSON", async () => {
    let receivedUrl = "";
    let receivedMethod = "";
    const e = envWithNotme(async (req) => {
      const u = new URL(req.url);
      receivedUrl = u.pathname;
      receivedMethod = req.method;
      return Response.json(SAMPLE_BUNDLE);
    });

    const fetcher = notmeBundleFetcher(e);
    const result = await fetcher();
    expect(receivedUrl).toBe(NOTME_BUNDLE_PATH);
    expect(receivedMethod).toBe("GET");
    expect(result).toEqual(SAMPLE_BUNDLE);
  });

  it("preserves all CABundle fields including optional prevKeyId", async () => {
    const withPrev: CABundle = { ...SAMPLE_BUNDLE, prevKeyId: "kid_old" };
    const e = envWithNotme(async () => Response.json(withPrev));
    const result = await notmeBundleFetcher(e)();
    expect(result?.prevKeyId).toBe("kid_old");
  });
});

// ── Failure paths: return null silently ─────────────────────────────────

describe("notmeBundleFetcher — failures return null (no exceptions leak)", () => {
  it("returns null when notme returns 5xx", async () => {
    const e = envWithNotme(async () => new Response("server error", { status: 503 }));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when notme returns 4xx", async () => {
    const e = envWithNotme(async () => new Response("not found", { status: 404 }));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when the response body isn't valid JSON", async () => {
    const e = envWithNotme(async () => new Response("not-json{", { status: 200 }));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when the JSON has the wrong shape (missing epoch)", async () => {
    const broken = { seqno: 1, keys: {}, keyId: "x", issuedAt: 1, signature: "" };
    const e = envWithNotme(async () => Response.json(broken));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when the JSON has the wrong shape (keys not Record<string, string>)", async () => {
    const broken = { ...SAMPLE_BUNDLE, keys: { active: 12345 } };
    const e = envWithNotme(async () => Response.json(broken));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when the JSON has the wrong shape (signature not a string)", async () => {
    const broken = { ...SAMPLE_BUNDLE, signature: 12345 };
    const e = envWithNotme(async () => Response.json(broken));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when prevKeyId has a wrong type (number instead of string)", async () => {
    const broken = { ...SAMPLE_BUNDLE, prevKeyId: 99 };
    const e = envWithNotme(async () => Response.json(broken));
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when fetch throws (network error simulated)", async () => {
    const e = envWithNotme(() => { throw new Error("EHOSTUNREACH"); });
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });

  it("returns null when fetch returns a rejected promise", async () => {
    const e = envWithNotme(async () => { throw new Error("network down"); });
    expect(await notmeBundleFetcher(e)()).toBeNull();
  });
});

// ── Trust-isolation: this module never verifies signatures ──────────────

describe("notmeBundleFetcher — trust-isolation contract", () => {
  it("returns the bundle UNVERIFIED — signature checking is the cache layer's job", async () => {
    // The fetcher must not try to verify the signature; that's
    // getCABundle's job (via verifyBundleSignature). Here we hand a
    // bundle with an obviously-bogus signature and confirm the fetcher
    // returns it as-is. Any unverified data leaks would surface as a
    // mismatch with this test.
    const bogus: CABundle = { ...SAMPLE_BUNDLE, signature: "obviously_not_a_real_sig" };
    const e = envWithNotme(async () => Response.json(bogus));
    const result = await notmeBundleFetcher(e)();
    expect(result).toEqual(bogus);
  });
});

// ── End-to-end: fetcher → getCABundle → verify ───────────────────────────

import { _resetCache, getCABundle, type BundleFetcher } from "../../src/storage/ca-bundle-cache.js";
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
    (await crypto.subtle.sign(
      "Ed25519",
      key,
      bundleCanonical({ ...base, signature: "" }) as BufferSource,
    )) as ArrayBuffer,
  );
  let bin = "";
  for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]!);
  return { ...base, signature: btoa(bin) };
}

describe("notmeBundleFetcher — end-to-end with getCABundle", () => {
  it("fetches via NOTME, verifies signature, returns the bundle", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const base: Omit<CABundle, "signature"> = {
      epoch: 7, seqno: 1,
      keys: { active: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
      keyId: "active",
      issuedAt: 1_700_000_050,
    };
    const signed = await signedBundle(base, root.privateKey);

    // Wire: fake NOTME → notmeBundleFetcher → getCABundle → verify
    const e = envWithNotme(async () => Response.json(signed));
    const fetcher: BundleFetcher = notmeBundleFetcher(e);
    const result = await getCABundle(fetcher, Date.now(), {
      rootPubkey: root.publicKeyB64,
    });
    expect(result.epoch).toBe(7);
  });

  it("rejects bundle with tampered signature (verification gates the cache)", async () => {
    _resetCache();
    const root = await makeRootKeyPair();
    const otherRoot = await makeRootKeyPair();
    const base: Omit<CABundle, "signature"> = {
      epoch: 7, seqno: 1,
      keys: { active: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" },
      keyId: "active",
      issuedAt: 1_700_000_050,
    };
    // Sign with a DIFFERENT root — should reject under root.publicKeyB64.
    const signed = await signedBundle(base, otherRoot.privateKey);

    const e = envWithNotme(async () => Response.json(signed));
    const fetcher: BundleFetcher = notmeBundleFetcher(e);
    const { CaUnavailableError } = await import("../../src/storage/ca-bundle-cache.js");
    await expect(
      getCABundle(fetcher, Date.now(), { rootPubkey: root.publicKeyB64 }),
    ).rejects.toThrow(CaUnavailableError);
  });
});
