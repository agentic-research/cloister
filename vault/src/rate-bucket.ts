// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

// Token-bucket rate limiter for the credential vault DO
// (cloister-211b68 / dos-friend F1).
//
// Pure functions over a `BucketState` value. The DO's persistence layer
// is responsible for loading the state from SQL, calling these
// functions, and writing the updated state back. Keeping the math in
// pure form makes it exhaustively testable without going through the
// workerd RPC harness, which surfaces DO-side throws as "errors" in the
// vitest pool reporter.

export const RATE_LIMITS = {
  CAPACITY:        100,
  REFILL_PER_SEC:  10,
  COST: {
    read:  1,   // getCredentialMetadata, listServices, deleteCredential
    write: 3,   // putCredential — encrypt + SQL write
    proxy: 5,   // proxyRequest — encrypt + SQL read + upstream fetch
  },
  MAX_INFLIGHT:    16,   // burst cap; workerd serializes handlers but proxy's await yields
} as const;

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Compute the bucket state after refilling from `prev` to `nowMs`.
 * `prev = null` represents a never-seen subject — returns a full bucket
 * stamped at `nowMs`. Clamps to CAPACITY (no over-refill).
 */
export function refillBucket(prev: BucketState | null, nowMs: number): BucketState {
  if (!prev) return { tokens: RATE_LIMITS.CAPACITY, lastRefillMs: nowMs };
  const elapsedSec = Math.max(0, (nowMs - prev.lastRefillMs) / 1000);
  const tokens = Math.min(
    RATE_LIMITS.CAPACITY,
    prev.tokens + elapsedSec * RATE_LIMITS.REFILL_PER_SEC,
  );
  return { tokens, lastRefillMs: nowMs };
}

export type ConsumeResult =
  | { ok: true;  next: BucketState }
  | { ok: false; next: BucketState; retryAfterSec: number };

/**
 * Attempt to consume `cost` tokens from a refilled bucket. Returns the
 * post-consume state on success; on failure returns the unchanged
 * state and a conservative retry-after ceiling in seconds.
 *
 * The "next" state is returned on both branches so callers persist the
 * refill timestamp even on reject — otherwise an attacker hitting a
 * depleted bucket would "freeze" time and not get progressive refill.
 */
export function tryConsume(refilled: BucketState, cost: number): ConsumeResult {
  if (refilled.tokens < cost) {
    const deficit = cost - refilled.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / RATE_LIMITS.REFILL_PER_SEC));
    return { ok: false, next: refilled, retryAfterSec };
  }
  return {
    ok: true,
    next: { tokens: refilled.tokens - cost, lastRefillMs: refilled.lastRefillMs },
  };
}
