// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

/**
 * Pre-auth budget: per-source-IP burst limit that runs BEFORE
 * `verifyAndUpsertLease` (the heavy auth path — wasm32 cert chain
 * verify + Web Crypto sig + TrustStore DO RPC for seen-nonces).
 *
 * Closes the DoS amplification gap cloister-1d2e89 / notme-693d63:
 * without a pre-auth limit, an attacker with a compromised cert can
 * mint distinct nonces and pump them at the gateway; every well-formed
 * request consumes ~1 DO RPC + wasm verify + Ed25519 sig verify BEFORE
 * the per-tenant rate-bucket in vault DO would slow them down.
 *
 * Per-IP buckets live in-memory in the worker isolate (module-scope
 * Map). They reset on isolate eviction (~minutes); that's acceptable
 * for a coarse pre-auth gate because:
 *
 *   1. The per-tenant rate-bucket inside vault DO is the durable
 *      second line of defense.
 *   2. An attacker waiting for isolate rotation is also paying for
 *      that idle time; the cost/benefit doesn't favor them.
 *   3. Cross-isolate coordination requires a DO RPC, which is exactly
 *      the cost we're trying to avoid for pre-auth.
 *
 * Cardinality is bounded by `PRE_AUTH_MAX_KEYS` with insertion-order
 * eviction — prevents memory exhaustion via IP rotation.
 */

import type { BucketState } from "../../vault/src/rate-bucket.js";

/**
 * Tuning constants. Higher capacity than the vault DO's per-tenant
 * bucket because pre-auth budget runs at IP granularity — a single IP
 * may legitimately carry traffic for many tenants (corporate NAT,
 * institutional egress). Refill rate matches: 10/sec sustained is
 * generous for non-attack traffic but back-pressures a flood within
 * ~30 sec of burst exhaustion.
 *
 * Cost per request is 1 (vs vault's 1-5) because pre-auth doesn't
 * know what the request will cost downstream; treat all pre-auth
 * attempts as unit cost.
 */
export const PRE_AUTH_LIMITS = {
  CAPACITY:        300,
  REFILL_PER_SEC:  10,
  COST_PER_REQUEST: 1,
  /**
   * Bucket-map capacity cap. Insertion-order eviction at this point
   * frees the oldest 10% to bound memory under IP-rotation. Sized for
   * ~10k unique IPs per isolate — enough for any realistic workload,
   * tight enough that an attacker can't sink the worker on memory.
   */
  MAX_KEYS:        10_000,
} as const;

/**
 * Module-scope per-IP bucket map. Insertion-order iteration is
 * guaranteed by Map; we rely on that for LRU-ish eviction (the
 * eldest-by-insertion entries get dropped first, which approximates
 * LRU since the bucket is touched on every access).
 *
 * For tests: `_resetPreAuthBuckets()` clears the map between
 * scenarios. Production code never calls it.
 */
const PRE_AUTH_BUCKETS = new Map<string, BucketState>();

export type PreAuthVerdict =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

/**
 * Consume one pre-auth token for the request's source IP. Returns
 * `{ok: true}` on success or `{ok: false, retryAfterSec}` when the
 * bucket is exhausted.
 *
 * `opts.nowMs` is testing-only — production callers omit it and the
 * function reads `Date.now()`. Pass when deterministic time is
 * required (e.g. exhausting a bucket then advancing the clock to
 * prove refill happens).
 */
export function preAuthBurstLimit(
  req: Request,
  opts?: { nowMs?: number },
): PreAuthVerdict {
  const key = extractClientIp(req);
  const now = opts?.nowMs ?? Date.now();

  // LRU eviction: when the map hits the cap, drop the oldest 10%
  // (insertion-order — Map preserves it). Doing this BEFORE the
  // refill+consume means a fresh request doesn't trigger eviction
  // of its own bucket. The 10% chunk is a tradeoff: smaller chunks
  // evict more often (constant overhead); larger chunks keep more
  // recent state (fewer cold-start hits).
  if (PRE_AUTH_BUCKETS.size >= PRE_AUTH_LIMITS.MAX_KEYS) {
    const dropCount = Math.floor(PRE_AUTH_LIMITS.MAX_KEYS / 10);
    let dropped = 0;
    for (const k of PRE_AUTH_BUCKETS.keys()) {
      if (dropped >= dropCount) break;
      PRE_AUTH_BUCKETS.delete(k);
      dropped++;
    }
  }

  const prev = PRE_AUTH_BUCKETS.get(key) ?? null;

  // Reuse vault/src/rate-bucket.ts's pure-function primitives — same
  // refill math, same exhaustion semantics. Differences are config
  // (the constants above) and persistence (in-memory vs DO SQL).
  const refilled = refillBucketWithLimits(prev, now);
  const result = consumeWithLimits(refilled, PRE_AUTH_LIMITS.COST_PER_REQUEST);

  // Always persist the refilled state, accept or reject. An attacker
  // hammering a depleted bucket would otherwise "freeze time" — the
  // lastRefillMs wouldn't advance, blocking the progressive refill
  // that lets a legitimate caller back into service after a burst.
  PRE_AUTH_BUCKETS.set(key, result.next);

  if (!result.ok) return { ok: false, retryAfterSec: result.retryAfterSec };
  return { ok: true };
}

/**
 * Wrapper around `refillBucket` from vault/src/rate-bucket.ts that
 * applies the pre-auth-specific CAPACITY + REFILL_PER_SEC. The
 * underlying function uses vault's constants; we need different ones
 * for the pre-auth tier.
 */
function refillBucketWithLimits(prev: BucketState | null, nowMs: number): BucketState {
  if (!prev) return { tokens: PRE_AUTH_LIMITS.CAPACITY, lastRefillMs: nowMs };
  const elapsedSec = Math.max(0, (nowMs - prev.lastRefillMs) / 1000);
  const tokens = Math.min(
    PRE_AUTH_LIMITS.CAPACITY,
    prev.tokens + elapsedSec * PRE_AUTH_LIMITS.REFILL_PER_SEC,
  );
  return { tokens, lastRefillMs: nowMs };
}

function consumeWithLimits(
  refilled: BucketState,
  cost: number,
): { ok: true; next: BucketState } | { ok: false; next: BucketState; retryAfterSec: number } {
  // Math.max(1, ...) floor ensures a non-zero retry hint even when
  // the deficit rounds to zero (e.g. very small refill rates).
  if (refilled.tokens < cost) {
    const deficit = cost - refilled.tokens;
    const retryAfterSec = Math.max(
      1,
      Math.ceil(deficit / PRE_AUTH_LIMITS.REFILL_PER_SEC),
    );
    return { ok: false, next: refilled, retryAfterSec };
  }
  return {
    ok: true,
    next: { tokens: refilled.tokens - cost, lastRefillMs: refilled.lastRefillMs },
  };
}

/**
 * Extract the client IP from a request. Prefers `CF-Connecting-IP`
 * (set by Cloudflare on every edge request; authoritative). Falls
 * back to a synthetic `"anonymous"` key on workerd-local / dev when
 * CF doesn't set the header — bucketing dev traffic together is fine
 * for the loopback-only deploy scenario.
 *
 * NOT trusted: `X-Forwarded-For` or other client-settable headers.
 * An attacker could otherwise spoof distinct IPs to bypass the
 * per-IP gate. CF-Connecting-IP is the only header Cloudflare
 * promises is not client-controllable at the edge.
 */
export function extractClientIp(req: Request): string {
  const cfip = req.headers.get("cf-connecting-ip");
  if (cfip !== null && cfip.length > 0) return cfip;
  return "anonymous";
}

/**
 * Test-only: reset the module-scope bucket map. Production code
 * never calls this. Exported so vitest can isolate test cases.
 */
export function _resetPreAuthBuckets(): void {
  PRE_AUTH_BUCKETS.clear();
}

/**
 * Test-only: inspect the current bucket count. Production code never
 * calls this. Useful for asserting LRU eviction landed.
 */
export function _preAuthBucketCount(): number {
  return PRE_AUTH_BUCKETS.size;
}
