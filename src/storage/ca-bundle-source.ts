// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ca-bundle-source — the single seam that resolves the CA bundle a lease-gated
// route verifies against. Centralizes the dev-vs-prod bundle-source decision so
// every lease-gated route (mcp, oci-registry, disclosure, vault-proxy) shares
// one path instead of each re-deciding it inline. Per ADR-0042: dev relaxes the
// *source* of the trust anchor (a local dev master), never the per-request
// verification.
//
// First consolidation of the fragmented dev-gate story (cloister-d2db6d): axis
// C — "how the CA bundle is obtained" (fetch-notme-and-verify vs local-static) —
// now lives in exactly one place. Axes A ("enforce auth?" — the routes'
// `if (INTERLACE_ROOT_PUBKEY)` gate) and B ("which anchor" — the pinned value)
// are still route-side; unifying all three behind one authority-source selector
// is the follow-on design (see the 5-whys analysis in cloister-d2e89a's thread).

import type { Env } from "../types.js";
import { CaUnavailableError, getCABundle, type CABundle } from "./ca-bundle-cache.js";
import { notmeBundleFetcher } from "./notme-bundle-fetcher.js";

/**
 * Static dev CA bundle (ADR-0042). When `CLOISTER_MODE === "dev"` and
 * `DEV_CA_MASTER` is set, the lease verifier uses this instead of fetching +
 * signature-verifying a bundle from notme. The dev master is provided locally
 * by `task harness:dev`, so there is no fetch to MITM and no bundle signature
 * to check — but `verifyAndUpsertLease` still runs the FULL cert-chain +
 * Ed25519 request-sig + scope + replay pipeline against `keys[active]`. This
 * relaxes only the *source* of the trust anchor (local, ephemeral), never the
 * per-request verification (ADR-0042 safety rail). Returns null outside dev
 * mode, so production always takes the notme-fetch path.
 */
export function devCaBundle(env: Env): CABundle | null {
  if (env.CLOISTER_MODE !== "dev" || !env.DEV_CA_MASTER) return null;
  const epoch = Number.parseInt(env.DEV_CA_EPOCH ?? "1", 10);
  return {
    epoch: Number.isFinite(epoch) ? epoch : 1,
    seqno: 1,
    keys: { active: env.DEV_CA_MASTER },
    keyId: "active",
    issuedAt: Math.floor(Date.now() / 1000),
    signature: "",
  };
}

/**
 * Resolve the CA bundle for lease verification. In dev (`CLOISTER_MODE=dev` +
 * `DEV_CA_MASTER`) returns the static dev bundle; otherwise fetches notme's
 * signed bundle and verifies it against `INTERLACE_ROOT_PUBKEY`. Throws
 * `CaUnavailableError` (with a diagnostic reason) when unavailable.
 *
 * Callers reach this only when the lease gate is active (`INTERLACE_ROOT_PUBKEY`
 * set) or in dev mode, so the fetch path always carries a pinned `rootPubkey` —
 * the "empty rootPubkey skips verification" affordance is never exercised here.
 */
export async function resolveCABundle(env: Env, nowMs: number): Promise<CABundle> {
  const dev = devCaBundle(env);
  if (dev) return dev;
  if (!env.INTERLACE_ROOT_PUBKEY) {
    // No trust anchor: neither a dev master nor a pinned root pubkey. Fail
    // closed rather than fall through to getCABundle with an empty rootPubkey,
    // which would skip signature verification (a dev-only affordance we must
    // never reach on a lease-gated path). Routes gate on INTERLACE_ROOT_PUBKEY
    // before calling, so this is a belt-and-suspenders backstop.
    throw new CaUnavailableError(
      "no CA trust anchor: set INTERLACE_ROOT_PUBKEY (prod / notme-in-loop) " +
        "or CLOISTER_MODE=dev + DEV_CA_MASTER (turnkey dev)",
    );
  }
  return getCABundle(notmeBundleFetcher(env), nowMs, {
    rootPubkey: env.INTERLACE_ROOT_PUBKEY,
  });
}
