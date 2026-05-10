// SPDX-License-Identifier: AGPL-3.0-or-later
//
// notme-bundle-fetcher — wraps `env.NOTME` as a `BundleFetcher` callback
// for `getCABundle` (cloister-c614ae cache + signature verification).
//
// Per ADR-0007 audit amendment 2026-05-08: cloister fetches notme's
// JSON `CABundle` shape on a periodic refresh, verifies its Ed25519
// signature against the pinned root pubkey, and uses the resulting
// keys map as the cluster master pubkey set for cert verification.
//
// notme-side endpoint: cloister calls `env.NOTME.fetch("/internal/ca-bundle")`
// (see `notme-internal-ca-bundle` bead for the cross-repo work). The
// response is JSON matching `CABundle` (revocation.ts in notme).
//
// This module is intentionally thin: it owns the transport (service
// binding URL + JSON parsing + error swallowing). Signature verification
// happens upstream in `getCABundle` via `verifyBundleSignature`. That
// keeps the trust-decision logic in one place — this fetcher cannot
// accidentally accept an unverified bundle.

import type { Env } from "../types.js";
import type { BundleFetcher, CABundle } from "./ca-bundle-cache.js";

/**
 * Path on the notme service binding where the JSON CABundle is served.
 * The exact path is a contract between cloister and notme; until notme
 * exposes a stable endpoint, this is documented + tracked as
 * cross-repo coordination work.
 */
export const NOTME_BUNDLE_PATH = "/internal/ca-bundle";

/**
 * Build a `BundleFetcher` callback bound to this Env's NOTME service
 * binding. Returns null on any failure (network, non-200, JSON parse,
 * shape mismatch). Calling code (`getCABundle`) treats null + cache-
 * stale as `CaUnavailableError`, so the caller never sees an
 * unverified bundle.
 *
 * The callback closes over `env.NOTME`; it does NOT close over the
 * root pubkey — that's passed to `getCABundle` separately so the
 * signature-verification step is visible at the cache layer, not here.
 */
export function notmeBundleFetcher(env: Env): BundleFetcher {
  return async () => {
    try {
      const upstream = `https://notme-bot${NOTME_BUNDLE_PATH}`;
      const res = await env.NOTME.fetch(new Request(upstream, { method: "GET" }));
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (!isCABundleShape(body)) return null;
      return body;
    } catch {
      return null;
    }
  };
}

/**
 * Defensive shape-check. We don't trust notme's response to match the
 * type — a misconfigured deploy or an attacker-served bundle could
 * produce arbitrary JSON. Reject anything missing required fields or
 * with wrong-typed values BEFORE handing to the signature verifier
 * (which would also reject, but at higher cost + lower clarity).
 */
function isCABundleShape(value: unknown): value is CABundle {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.epoch     !== "number") return false;
  if (typeof v.seqno     !== "number") return false;
  if (typeof v.keys      !== "object" || v.keys === null) return false;
  if (typeof v.keyId     !== "string") return false;
  if (typeof v.issuedAt  !== "number") return false;
  if (typeof v.signature !== "string") return false;
  // Optional: prevKeyId may be string or absent.
  if (v.prevKeyId !== undefined && typeof v.prevKeyId !== "string") return false;
  // keys must be Record<string, string>.
  for (const k of Object.keys(v.keys as Record<string, unknown>)) {
    if (typeof (v.keys as Record<string, unknown>)[k] !== "string") return false;
  }
  return true;
}
