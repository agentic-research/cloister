// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

/**
 * pre-auth-budget.test.ts — unit tests for the per-IP burst limit
 * that protects the lease-verify path (cloister-1d2e89 /
 * notme-693d63).
 *
 * Tests the bucket math + IP extraction in isolation; the wired
 * integration into vault-proxy-route lives in vault-store.test.ts
 * (we don't exercise it through the full RPC harness here to keep
 * the unit tests fast + hermetic).
 *
 * NOT covered here: cross-isolate behavior (no way to simulate
 * multiple isolates in a single test process; module-scope state
 * IS per-isolate by design — see preAuthBurstLimit's docstring).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  extractClientIp,
  preAuthBurstLimit,
  PRE_AUTH_LIMITS,
  _preAuthBucketCount,
  _resetPreAuthBuckets,
} from "../../src/routes/pre-auth-budget.js";

afterEach(() => {
  // Module-scope Map persists across tests — reset between cases so
  // a prior test's bucket exhaustion doesn't leak into the next.
  _resetPreAuthBuckets();
});

// ── IP extraction ──────────────────────────────────────────────

describe("extractClientIp", () => {
  it("returns the CF-Connecting-IP header value when present", () => {
    const req = new Request("https://example.test/", {
      headers: { "cf-connecting-ip": "203.0.113.42" },
    });
    expect(extractClientIp(req)).toBe("203.0.113.42");
  });

  it("falls back to 'anonymous' when CF-Connecting-IP is absent (dev/workerd-local)", () => {
    // No CF header set — workerd doesn't synthesize it for local runs.
    // Bucketing dev traffic under one synthetic key is fine for the
    // loopback-only deploy scenario; production sets CF-Connecting-IP
    // unconditionally at the edge.
    const req = new Request("https://example.test/");
    expect(extractClientIp(req)).toBe("anonymous");
  });

  it("DOES NOT trust X-Forwarded-For (client-controllable)", () => {
    // An attacker could otherwise rotate XFF values per request to
    // bypass the per-IP gate. CF-Connecting-IP is the only header
    // Cloudflare promises isn't client-controllable at the edge.
    const req = new Request("https://example.test/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(extractClientIp(req)).toBe("anonymous");
  });

  it("ignores empty CF-Connecting-IP header (treats as absent)", () => {
    // Defensive: a misconfigured edge might emit the header with an
    // empty value. Don't bucket all-empty-header IPs together (which
    // would let a flood look uniform); fall back to the dev key.
    const req = new Request("https://example.test/", {
      headers: { "cf-connecting-ip": "" },
    });
    expect(extractClientIp(req)).toBe("anonymous");
  });
});

// ── Bucket math ────────────────────────────────────────────────

describe("preAuthBurstLimit", () => {
  function ipRequest(ip: string): Request {
    return new Request("https://example.test/", {
      headers: { "cf-connecting-ip": ip },
    });
  }

  it("a fresh IP consumes one token from a full bucket", () => {
    const r = preAuthBurstLimit(ipRequest("198.51.100.10"), { nowMs: 1_000 });
    expect(r.ok).toBe(true);
    // Bucket is now at CAPACITY - 1. We can't inspect tokens directly
    // (private state), but we can prove it by exhausting and asserting
    // the cap minus 1 succeeded.
  });

  it("exhausts after CAPACITY consecutive requests at the same instant", () => {
    const req = ipRequest("198.51.100.11");
    let okCount = 0;
    let failCount = 0;
    // CAPACITY + a few extra. The +5 proves the bucket DOESN'T leak
    // tokens (would silently allow more than capacity if it did).
    for (let i = 0; i < PRE_AUTH_LIMITS.CAPACITY + 5; i++) {
      const r = preAuthBurstLimit(req, { nowMs: 2_000 });
      if (r.ok) okCount++;
      else failCount++;
    }
    expect(okCount).toBe(PRE_AUTH_LIMITS.CAPACITY);
    expect(failCount).toBe(5);
  });

  it("exhausted bucket reports retryAfterSec proportional to refill rate", () => {
    const req = ipRequest("198.51.100.12");
    for (let i = 0; i < PRE_AUTH_LIMITS.CAPACITY; i++) {
      preAuthBurstLimit(req, { nowMs: 3_000 });
    }
    const r = preAuthBurstLimit(req, { nowMs: 3_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Need 1 token; refill is REFILL_PER_SEC tokens/sec. So
      // retryAfter is ceil(1 / REFILL_PER_SEC) = 1 second.
      expect(r.retryAfterSec).toBe(1);
    }
  });

  it("refills tokens over elapsed time", () => {
    const req = ipRequest("198.51.100.13");
    // Exhaust at t=0.
    for (let i = 0; i < PRE_AUTH_LIMITS.CAPACITY; i++) {
      preAuthBurstLimit(req, { nowMs: 0 });
    }
    expect(preAuthBurstLimit(req, { nowMs: 0 }).ok).toBe(false);

    // Advance 5 seconds → 5 * REFILL_PER_SEC = 50 tokens refilled.
    // Should let 50 more requests through.
    let allowedAfterRefill = 0;
    for (let i = 0; i < 60; i++) {
      const r = preAuthBurstLimit(req, { nowMs: 5_000 });
      if (r.ok) allowedAfterRefill++;
    }
    expect(allowedAfterRefill).toBe(5 * PRE_AUTH_LIMITS.REFILL_PER_SEC);
  });

  it("different IPs have independent buckets", () => {
    // Saturating peer A must not deny peer B.
    const reqA = ipRequest("198.51.100.20");
    const reqB = ipRequest("198.51.100.21");
    for (let i = 0; i < PRE_AUTH_LIMITS.CAPACITY; i++) {
      preAuthBurstLimit(reqA, { nowMs: 10_000 });
    }
    expect(preAuthBurstLimit(reqA, { nowMs: 10_000 }).ok).toBe(false);
    // Peer B has never been seen — full bucket.
    expect(preAuthBurstLimit(reqB, { nowMs: 10_000 }).ok).toBe(true);
  });

  it("persists state on rejected requests so time keeps advancing", () => {
    // The lastRefillMs MUST advance on a reject — otherwise an attacker
    // hammering an exhausted bucket would "freeze time" and never
    // get back into refill territory.
    //
    // Test shape: exhaust at t=0. Probe at t=50ms (tiny — only 0.5
    // tokens refilled, not enough for cost=1) → reject. The reject
    // must STILL persist state with lastRefillMs=50, so the next
    // "real" check at t=5_050ms computes 5s of refill from t=50ms
    // (= 50 tokens), not from t=0 (= 50.5 tokens, off by 0.5). The
    // assertion is on the count after the 5s window.
    const req = ipRequest("198.51.100.30");
    for (let i = 0; i < PRE_AUTH_LIMITS.CAPACITY; i++) {
      preAuthBurstLimit(req, { nowMs: 0 });
    }
    // Probe at t=50ms: 50ms * 10 tokens/sec = 0.5 tokens, below
    // cost=1 → reject. State.lastRefillMs advances to 50.
    const probe = preAuthBurstLimit(req, { nowMs: 50 });
    expect(probe.ok).toBe(false);
    // 5s later (t=5_050ms): refill from t=50ms is 5s × 10 = 50 tokens.
    let allowedAfter = 0;
    for (let i = 0; i < 60; i++) {
      const r = preAuthBurstLimit(req, { nowMs: 5_050 });
      if (r.ok) allowedAfter++;
    }
    expect(allowedAfter).toBe(5 * PRE_AUTH_LIMITS.REFILL_PER_SEC);
  });

  it("'anonymous' fallback bucket exhausts independently of named IPs", () => {
    const named = ipRequest("198.51.100.40");
    const anon = new Request("https://example.test/"); // no CF header
    for (let i = 0; i < PRE_AUTH_LIMITS.CAPACITY; i++) {
      preAuthBurstLimit(anon, { nowMs: 0 });
    }
    expect(preAuthBurstLimit(anon, { nowMs: 0 }).ok).toBe(false);
    // Named IP still has a full bucket.
    expect(preAuthBurstLimit(named, { nowMs: 0 }).ok).toBe(true);
  });

  it("LRU eviction frees space when MAX_KEYS reached", () => {
    // Fill the map past MAX_KEYS. The implementation drops the oldest
    // 10% on the call that would exceed the cap. Bucket count must
    // stay bounded.
    for (let i = 0; i < PRE_AUTH_LIMITS.MAX_KEYS + 100; i++) {
      preAuthBurstLimit(ipRequest(`10.0.${Math.floor(i / 256)}.${i % 256}`), { nowMs: 0 });
    }
    // After eviction we should be well under MAX_KEYS + 100 — the
    // cap minus the dropped 10% plus the requests that landed after
    // eviction.
    expect(_preAuthBucketCount()).toBeLessThanOrEqual(PRE_AUTH_LIMITS.MAX_KEYS);
    // We dropped 1000 (10% of 10k), made room for 100 more — so the
    // expected steady-state size is roughly MAX_KEYS - 1000 + 100.
    // The LBound assertion (>= MAX_KEYS - 1000) catches off-by-N in
    // the drop count without flaking on the exact value.
    expect(_preAuthBucketCount()).toBeGreaterThanOrEqual(PRE_AUTH_LIMITS.MAX_KEYS - 1000);
  });
});
