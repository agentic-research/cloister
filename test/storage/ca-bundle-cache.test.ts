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
