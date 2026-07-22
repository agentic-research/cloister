// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CA-bundle cache — fetches notme's signed `CABundle` on a periodic refresh
// and caches it per-instance so the lease verifier can check `cert.epoch`
// against `bundle.epoch` on every authenticated request without paying the
// service-binding hop on the hot path.
//
// Per ADR-0007 audit amendment 2026-05-08 (cloister-e195ea): the verifier
// can't rely on a pinned `INTERLACE_MASTER_PUBKEY` alone — that pin is
// revocation-blind. notme rotates epochs (notme/worker/src/revocation.ts
// `BUNDLE_MAX_AGE_MS = 5min`); cloister must observe those rotations
// within a bounded window or accept a revoked cert.
//
// Design:
//
//   - **TTL one minute INSIDE notme's BUNDLE_MAX_AGE_MS.** notme considers
//     bundles >5min old stale; we refresh at 4min so we always see a
//     non-stale bundle (modulo the round-trip).
//   - **Per-instance cache.** No DO storage; the cache is process-local.
//     Worker isolate cycling re-fetches; that's fine — fresh observation
//     is desirable.
//   - **Injected fetcher.** This module doesn't bake in the transport
//     (service binding to notme vs shared KV vs HTTP). bd7770's middleware
//     picks the actual path; the module stays testable in isolation.
//   - **Fail closed beyond TTL.** If notme is unreachable AND the cache is
//     stale, callers get `CaUnavailableError` and reject the request.
//     Per ADR-0007: notme tolerated down for ≤ bundle TTL; beyond that,
//     verifier fails closed.
//
// The CABundle shape mirrors `notme/worker/src/revocation.ts`. Keep these
// in sync — schema drift between them would break the verifier silently.

export interface CABundle {
  /** Monotonically-increasing epoch number; cert's `interlace-epoch` MUST equal this (or older epochs in the rotation window). */
  epoch: number;
  /** Monotonically-increasing seqno within an epoch. */
  seqno: number;
  /** kid → base64-standard raw Ed25519 public key (32 bytes). */
  keys: Record<string, string>;
  /** Currently-active key ID. */
  keyId: string;
  /** Previous key ID, set during the half-open rotation window. Optional. */
  prevKeyId?: string;
  /**
   * Unix-seconds at which the bundle was issued. REQUIRED — staleness
   * check is fail-closed. Must be present for the bundle to be trusted.
   */
  issuedAt: number;
  /** Ed25519 signature over `bundleCanonical(bundle)`, base64-standard. */
  signature: string;
}

import { verifyBundleSignature } from "./bundle-canonical.js";

/**
 * Fetcher contract: returns a fresh `CABundle` from wherever notme exposes
 * it. The transport (service binding, shared KV, plain HTTP) is the
 * caller's choice; this module just accepts the result.
 *
 * Returns `null` if the bundle is unavailable (notme down, KV miss, etc.).
 * The cache treats `null` as "fail open if cache is fresh; fail closed if
 * cache is stale or empty."
 */
export type BundleFetcher = () => Promise<CABundle | null>;

/** Refresh interval — must be shorter than notme's `BUNDLE_MAX_AGE_MS = 5min`. */
export const BUNDLE_REFRESH_MS = 4 * 60 * 1000;

interface CacheEntry {
  bundle: CABundle;
  fetchedAtMs: number;
}

// Module-level cache. One bundle per cluster (notme is the cluster's CA).
// Keep this private; tests use `_resetCache()` to clear between cases.
let _cache: CacheEntry | null = null;

/**
 * Throw if notme is unreachable AND the cache can't satisfy the request.
 * Caller should map this to a 503 + structured error code. Distinct from
 * the verifier's "epoch_mismatch" — that's a valid bundle saying the
 * cert is revoked; this is "we don't know if the cert is revoked at all."
 */
export class CaUnavailableError extends Error {
  override readonly name = "CaUnavailableError";
}

/**
 * Get the current bundle. Returns the cached bundle if fresh; calls the
 * fetcher otherwise. Throws `CaUnavailableError` if notme is unreachable
 * and the cache is stale or empty.
 */
export interface GetBundleOptions {
  /** Refresh interval override; defaults to BUNDLE_REFRESH_MS. */
  refreshMs?: number;
  /**
   * Cluster root Ed25519 pubkey (base64-standard, 32 bytes). When set,
   * fetched bundles are verified against this key BEFORE caching.
   * Bundles that fail verification are rejected as if `fetcher()`
   * returned null — the cache is not poisoned. When undefined or empty,
   * verification is skipped (dev-mode only; production MUST pass a
   * pinned root pubkey).
   */
  rootPubkey?: string;
}

/**
 * Get the current bundle. Returns the cached bundle if fresh; calls the
 * fetcher otherwise. Fetched bundles are signature-verified against
 * `options.rootPubkey` (when set) before being cached.
 *
 * Throws `CaUnavailableError` if notme is unreachable, the fetched
 * bundle fails signature verification, AND the cache is stale or empty.
 */
export async function getCABundle(
  fetcher: BundleFetcher,
  nowMs: number,
  optionsOrRefreshMs: GetBundleOptions | number = {},
): Promise<CABundle> {
  // Backwards-compat: caller used to pass `refreshMs: number` as the
  // third arg. Accept either shape so existing call sites keep working.
  const options: GetBundleOptions =
    typeof optionsOrRefreshMs === "number"
      ? { refreshMs: optionsOrRefreshMs }
      : optionsOrRefreshMs;
  const refreshMs = options.refreshMs ?? BUNDLE_REFRESH_MS;

  if (_cache && nowMs - _cache.fetchedAtMs < refreshMs) {
    return _cache.bundle;
  }

  // Stale or empty — fetch. Track WHY it fails so the opaque
  // CaUnavailableError carries a diagnostic reason. A silent double-swallow
  // here (this catch + the fetcher's own) turned a trivial key-pin mismatch
  // into a P2 debugging mystery — see cloister-3ad090; this is the
  // cloister-3b8cd6-class "fail legibly" fix. The reason is server-side only
  // (routes still return an opaque error to the client) and logs only public
  // data — pubkey prefixes, status — never secrets.
  let next: CABundle | null;
  let reason: string;
  try {
    next = await fetcher();
    reason = "fetch returned null (notme unreachable / non-200 / bad JSON / shape mismatch)";
  } catch (err) {
    next = null;
    reason = `fetch threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }

  // Verify signature against pinned root pubkey if configured. Per
  // cloister-c614ae / threat-model §5: fetched bundles MUST be verified
  // before caching; an unverified bundle is treated as "fetch failed."
  // Empty rootPubkey disables verification (dev-only).
  if (next && options.rootPubkey) {
    const valid = await verifyBundleSignature(next, options.rootPubkey);
    if (!valid) {
      reason =
        `signature verify FAILED — the fetched bundle is not signed by the pinned ` +
        `root pubkey (rootPubkey=${options.rootPubkey.slice(0, 12)}… vs bundle signer ` +
        `${next.keys[next.keyId]?.slice(0, 12)}…). Check INTERLACE_ROOT_PUBKEY matches ` +
        `the authority that signed the bundle (notme's master key).`;
      next = null;
    }
  } else if (next) {
    // rootPubkey empty/undefined → signature verification SKIPPED. A dev-only
    // affordance, but an empty value silently meaning "don't verify" is exactly
    // the footgun cloister-21e42e is about. resolveCABundle now fails closed
    // before reaching here, so on a lease-gated path this is unreachable — warn
    // loudly if it ever fires so an accidental empty pin can never pass unseen.
    // TODO(cloister-21e42e): systemic audit of empty-value-means-off; fold this
    // skip into an explicit, mode-gated decision rather than an empty default.
    console.warn(
      "[cloister] getCABundle: accepting an UNVERIFIED bundle — rootPubkey is empty/unset. " +
        "This must only occur in explicit dev/test, never on a lease-gated path.",
    );
  }

  if (next) {
    _cache = { bundle: next, fetchedAtMs: nowMs };
    return next;
  }

  // notme unreachable OR signature verify failed. If we have a cached
  // bundle from before the window, we still fail closed — the audit
  // amendment is explicit: ≤ bundle TTL tolerance only.
  console.warn(`[cloister] getCABundle: CA bundle unavailable — ${reason}`);
  throw new CaUnavailableError(`notme CA bundle unavailable: ${reason}`);
}

/**
 * Test-only — clear the module-level cache between cases. Not exported
 * for production code paths (production does not need to clear; the
 * isolate is the boundary).
 */
export function _resetCache(): void {
  _cache = null;
}

/**
 * Check that a cert's epoch is current per the bundle. Returns:
 *   - `ok: true` — cert.epoch ≤ bundle.epoch (current or one rotation back)
 *   - `ok: false` — cert.epoch > bundle.epoch (cert claims newer than reality)
 *     OR cert.epoch is far behind bundle.epoch (cert revoked).
 *
 * The "one rotation back" tolerance accepts certs minted just before a
 * rotation completed but verified just after. notme's `prevKeyId` field
 * is the rotation-window signal; its presence means the verifier should
 * accept `cert.epoch === bundle.epoch - 1` as well. Without `prevKeyId`,
 * only `cert.epoch === bundle.epoch` is accepted.
 */
export function isCertEpochCurrent(
  certEpoch: number,
  bundle: CABundle,
): boolean {
  if (certEpoch === bundle.epoch) return true;
  if (bundle.prevKeyId !== undefined && certEpoch === bundle.epoch - 1) {
    return true;
  }
  return false;
}
