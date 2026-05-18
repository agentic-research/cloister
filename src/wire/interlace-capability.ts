// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Helpers for the P-side (cloister-as-client) of the Interlace 0.2.0
// receipts flow. Per cloister-c18eb3 Phase 1 — pure parsing/extraction
// only. The live wire-in (calling `verifyReceiptPLive` on every
// outbound mcp-proxy response, storing the receipt, returning 502
// on verify-fail) is Phase 2; this file ships the building blocks.
//
// Two functions:
//
//   - `detectInterlaceCapability(initResult)` — pulls the Interlace
//     0.2.0 capability advertisement out of an MCP initialize result.
//     Returns the actor fingerprint + current/previous epochs the
//     upstream is willing to sign with. Returns null when the upstream
//     hasn't advertised the capability (Phase 1 default — skip
//     verification entirely, preserve pre-receipts behavior).
//
//   - `extractReceiptHeader(headers)` — pulls the `Interlace-Receipt`
//     header value out of a Response. Case-insensitive (Headers
//     handles this). Returns null if absent.
//
// Shape contract:
//
//   serverCapabilities.interlace = {
//     "version":       "0.2.0",
//     "actor_fp":      "<base64url 32-byte fingerprint>",
//     "current_epoch": <integer >= 0>,
//     "prev_epoch":    <integer >= 0, optional>,
//   }
//
// The shape mirrors `src/routes/well-known.ts:InterlaceDoc` minus the
// epochs[] array (the well-known endpoint serves the full archive;
// the MCP capability advertisement names only the verification window).
// Both sides converge on `actor_fp` (canonical key) and `current_epoch`
// + optional `prev_epoch` (the §2.6 acceptance window).

/** Validated Interlace capability block, ready for `verifyReceiptPLive` plumbing. */
export interface InterlaceCapability {
  readonly version:      string;
  readonly actor_fp:     string;
  readonly current_epoch: number;
  readonly prev_epoch?:  number;
}

/**
 * Detect whether an MCP initialize result advertises the Interlace
 * 0.2.0 receipts capability. Returns the parsed capability block on
 * match, or null when absent / malformed.
 *
 * Phase 1 (this commit): callers use null to mean "skip receipt
 * verification entirely — preserve pre-receipts behavior."
 * Phase 2 (follow-up): a non-null return arms `verifyReceiptPLive`
 * for every subsequent response on the connection.
 *
 * Malformed advertisement degrades to null (with no throw). The
 * upstream-misconfigured-its-block case must not crash the connection
 * — log + skip is the right behavior per Phase 1 (§8.2 migration).
 */
export function detectInterlaceCapability(
  initResult: unknown,
): InterlaceCapability | null {
  if (initResult === null || typeof initResult !== "object") return null;
  const caps = (initResult as { capabilities?: unknown }).capabilities;
  if (caps === null || typeof caps !== "object") return null;
  const interlace = (caps as Record<string, unknown>).interlace;
  if (interlace === null || typeof interlace !== "object") return null;

  const block = interlace as Record<string, unknown>;
  const version       = block.version;
  const actorFp       = block.actor_fp;
  const currentEpoch  = block.current_epoch;
  const prevEpoch     = block.prev_epoch;

  // Required field checks. Non-conforming shapes degrade to null.
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof actorFp !== "string" || actorFp.length === 0) return null;
  if (typeof currentEpoch !== "number" || !Number.isInteger(currentEpoch) || currentEpoch < 0) {
    return null;
  }

  // Optional field — present-but-malformed is degraded to omitted
  // (matches the well-known endpoint's "omit when null" convention,
  // see src/routes/well-known.ts:86).
  let prev: number | undefined;
  if (prevEpoch !== undefined && prevEpoch !== null) {
    if (typeof prevEpoch === "number" && Number.isInteger(prevEpoch) && prevEpoch >= 0) {
      prev = prevEpoch;
    }
  }

  return prev !== undefined
    ? { version, actor_fp: actorFp, current_epoch: currentEpoch, prev_epoch: prev }
    : { version, actor_fp: actorFp, current_epoch: currentEpoch };
}

/** Canonical header name for the receipt envelope. Lowercased for byte-compare. */
export const RECEIPT_HEADER_NAME = "interlace-receipt";

/**
 * Pull the `Interlace-Receipt` header value off a Response. Returns
 * null if absent. The Headers API is case-insensitive so callers
 * don't need to worry about upstream-side casing.
 *
 * The returned string is the receipt envelope (base64url-encoded
 * canonical CBOR) ready to hand to `verifyReceiptPLive` — no further
 * parsing happens here.
 */
export function extractReceiptHeader(headers: Headers): string | null {
  const v = headers.get(RECEIPT_HEADER_NAME);
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}
