// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

/**
 * rate-bucket.test.ts — unit tests for the per-caller token-bucket
 * (cloister-211b68 / dos-friend F1). The math is pure functions over a
 * BucketState value, so we can exhaustively test the gate logic
 * without going through the workerd RPC harness.
 *
 * Integration coverage (the DO's persistence + RPC dispatch shim) lives
 * in test/vault-store.test.ts. Anything timing-sensitive or
 * cardinality-sensitive belongs HERE, not there.
 */

import { describe, expect, it } from "vitest";
import { RATE_LIMITS, refillBucket, tryConsume } from "../rate-bucket";

describe("refillBucket", () => {
  it("a never-seen subject starts with a full bucket", () => {
    const r = refillBucket(null, 1_700_000_000_000);
    expect(r.tokens).toBe(RATE_LIMITS.CAPACITY);
    expect(r.lastRefillMs).toBe(1_700_000_000_000);
  });

  it("refills linearly between calls", () => {
    const prev = { tokens: 0, lastRefillMs: 1_000 };
    // 500ms elapsed at 10 tokens/sec → 5 tokens.
    const r = refillBucket(prev, 1_500);
    expect(r.tokens).toBeCloseTo(5, 5);
    expect(r.lastRefillMs).toBe(1_500);
  });

  it("clamps to CAPACITY (no over-refill)", () => {
    const prev = { tokens: 50, lastRefillMs: 0 };
    // 60s elapsed at 10 tokens/sec = 600 tokens. Capped at CAPACITY (100).
    const r = refillBucket(prev, 60_000);
    expect(r.tokens).toBe(RATE_LIMITS.CAPACITY);
  });

  it("does not negative-elapse on clock skew (now < lastRefill)", () => {
    const prev = { tokens: 50, lastRefillMs: 10_000 };
    // now is 1000ms BEFORE lastRefill — elapsedSec clamped to 0.
    const r = refillBucket(prev, 9_000);
    expect(r.tokens).toBe(50);
    expect(r.lastRefillMs).toBe(9_000);
  });

  it("sub-token refill at sub-second resolution", () => {
    const prev = { tokens: 0, lastRefillMs: 0 };
    // 100ms elapsed → 1 token.
    const r1 = refillBucket(prev, 100);
    expect(r1.tokens).toBeCloseTo(1, 5);
    // 50ms more → 1.5 tokens total.
    const r2 = refillBucket(r1, 150);
    expect(r2.tokens).toBeCloseTo(1.5, 5);
  });
});

describe("tryConsume", () => {
  it("accepts when tokens ≥ cost; subtracts cost", () => {
    const state = { tokens: 5, lastRefillMs: 1000 };
    const r = tryConsume(state, 3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next.tokens).toBe(2);
      expect(r.next.lastRefillMs).toBe(1000);
    }
  });

  it("rejects when tokens < cost; returns retry-after", () => {
    const state = { tokens: 1, lastRefillMs: 1000 };
    const r = tryConsume(state, 5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Deficit 4 / 10 refill-per-sec = 0.4 → ceil → 1, clamped to min 1.
      expect(r.retryAfterSec).toBe(1);
      // State on reject preserves the refilled timestamp.
      expect(r.next.lastRefillMs).toBe(1000);
      expect(r.next.tokens).toBe(1);
    }
  });

  it("retry-after scales with deficit", () => {
    const state = { tokens: 0, lastRefillMs: 0 };
    // Deficit = cost = 100 (full bucket cost). 100/10 = 10s.
    const r = tryConsume(state, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBe(10);
  });

  it("retry-after floors at 1s (never returns 0)", () => {
    const state = { tokens: 0.5, lastRefillMs: 0 };
    // Deficit = 0.5 / 10 = 0.05 → ceil → 1, but clamped to ≥1.
    const r = tryConsume(state, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("exact-tokens-equals-cost accepts and zeroes the bucket", () => {
    const state = { tokens: 5, lastRefillMs: 1000 };
    const r = tryConsume(state, 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next.tokens).toBe(0);
  });
});

describe("RATE_LIMITS — production limits sanity", () => {
  it("read cost < write cost < proxy cost (relative weights make sense)", () => {
    expect(RATE_LIMITS.COST.read).toBeLessThan(RATE_LIMITS.COST.write);
    expect(RATE_LIMITS.COST.write).toBeLessThan(RATE_LIMITS.COST.proxy);
  });

  it("capacity supports realistic burst for each cost class", () => {
    // 10× headroom over realistic single-burst patterns:
    // reads ≤ 10/burst, writes ≤ 3/burst, proxies ≤ 2/burst.
    expect(RATE_LIMITS.CAPACITY / RATE_LIMITS.COST.read).toBeGreaterThanOrEqual(100);
    expect(RATE_LIMITS.CAPACITY / RATE_LIMITS.COST.write).toBeGreaterThanOrEqual(30);
    expect(RATE_LIMITS.CAPACITY / RATE_LIMITS.COST.proxy).toBeGreaterThanOrEqual(20);
  });

  it("refill rate sustains realistic steady-state", () => {
    // ≥1 read per refill-second steady-state.
    expect(RATE_LIMITS.REFILL_PER_SEC / RATE_LIMITS.COST.read).toBeGreaterThanOrEqual(1);
  });

  it("MAX_INFLIGHT is bounded but allows realistic burst", () => {
    expect(RATE_LIMITS.MAX_INFLIGHT).toBeGreaterThan(1);
    expect(RATE_LIMITS.MAX_INFLIGHT).toBeLessThanOrEqual(64);
  });
});

describe("scenario: attacker tight-loop", () => {
  it("100 cost-1 calls deplete a fresh bucket; 101st rejects", () => {
    let state = refillBucket(null, 0);
    let accepted = 0;
    for (let i = 0; i < 101; i++) {
      const r = tryConsume(state, 1);
      if (r.ok) {
        accepted++;
        state = r.next;
      } else {
        state = r.next;
        break;
      }
    }
    expect(accepted).toBe(RATE_LIMITS.CAPACITY); // exactly CAPACITY accepted
  });

  it("after 100 rejections, bucket lastRefillMs advances (no time-freeze)", () => {
    let state = { tokens: 0, lastRefillMs: 1000 };
    for (let t = 1100; t <= 2000; t += 100) {
      state = refillBucket(state, t);
      const r = tryConsume(state, 100); // demand more than tokens; always rejects
      state = r.next;
    }
    // Final lastRefillMs reflects the latest refill, not the seed.
    expect(state.lastRefillMs).toBe(2000);
  });
});
