// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Receipt verification — both audiences (RECEIPTS.md §2.2).
//
//   - P-live verification (§2.2.1): cloister AS CLIENT, verifying an
//     upstream actor's receipt at request time. Strict on
//     current/previous epoch tolerance.
//
//   - V-archival verification (§2.2.2): replay a stored receipt against
//     the archived CA bundle for that epoch + check compromise notice
//     timestamp.
//
// Both procedures run the same primitive checks (signature, hashes,
// timestamps, etc.); they differ in epoch resolution + compromise-
// notice handling.

import {
  RECEIPT_CLOCK_SKEW_MS,
  buildHeadersCommittedBytes,
  decodeReceiptHeader,
  decodeReceiptBytes,
  decodeStreamOpenEnvelopeBytes,
  decodeStreamCloseEnvelopeBytes,
  encodeCommitment,
  encodeStreamOpenCommitment,
  encodeStreamCloseCommitment,
  sha256,
  verifyEd25519,
  type ReceiptCommitment,
  type ReceiptEnvelope,
  type StreamOpenCommitment,
  type StreamCloseCommitment,
  type StreamOpenEnvelope,
  type StreamCloseEnvelope,
} from "./receipts.js";

export interface PLiveVerifyArgs {
  /** Receipt envelope value from the `Interlace-Receipt` HTTP header. */
  headerValue: string;
  /** The expected actor fingerprint (32-byte raw). P pins this. */
  expectedActorFp: Uint8Array;
  /** The actor's current epoch + (optional) previous epoch. */
  currentEpoch: number;
  prevEpoch?: number;
  /** Master pubkey for the named epoch — lookup must succeed. */
  resolvePubkey: (epoch: number) => Uint8Array | null;
  /** Nonce P originally sent in the request. */
  expectedNonce: Uint8Array;
  /** Bytes of P's outgoing request_canon (lease-envelope input). */
  requestCanon: Uint8Array;
  /** Bytes of the response body P observed. */
  responseBody: Uint8Array;
  /** Headers from the response P observed. */
  responseHeaders: Headers;
  /** P's wall-clock (for clock-skew check). */
  nowMs: number;
}

export type ReceiptVerifyResult =
  | { ok: true; commitment: ReceiptCommitment; envelope: ReceiptEnvelope }
  | { ok: false; reason: string };

/**
 * RECEIPTS.md §2.2.1 P-live verification.
 * Returns { ok: true, ... } iff every check passes.
 *
 * Failure reasons are typed-by-string for diagnostics; treat any
 * non-`ok: true` result as "MUST reject" per §2.6.
 */
export async function verifyReceiptPLive(args: PLiveVerifyArgs): Promise<ReceiptVerifyResult> {
  // Steps 1–3: decode + structural validation.
  const decoded = decodeReceiptHeader(args.headerValue);
  if (!decoded.ok) return { ok: false, reason: `decode: ${decoded.reason}` };
  const envelope = decoded.value;
  const c = envelope.commitment;

  // Step 4: nonce match.
  if (!constantTimeEqual(c.nonce, args.expectedNonce)) {
    return { ok: false, reason: "nonce mismatch" };
  }

  // Step 5: request_hash match.
  const expectedRequestHash = await sha256(args.requestCanon);
  if (!constantTimeEqual(c.requestHash, expectedRequestHash)) {
    return { ok: false, reason: "request_hash mismatch" };
  }

  // Step 6: actor_fp match.
  if (!constantTimeEqual(c.actorFp, args.expectedActorFp)) {
    return { ok: false, reason: "actor_fp mismatch" };
  }

  // Step 7: epoch tolerance.
  if (c.epoch !== args.currentEpoch && c.epoch !== args.prevEpoch) {
    return { ok: false, reason: `epoch ${c.epoch} not in {${args.currentEpoch}, ${args.prevEpoch ?? "-"}}` };
  }

  // Step 8 + 9: pubkey lookup + Ed25519 verify.
  const pubkey = args.resolvePubkey(c.epoch);
  if (pubkey === null) return { ok: false, reason: `pubkey unavailable for epoch ${c.epoch}` };
  const canonical = encodeCommitment(c);
  const sigOk = await verifyEd25519(pubkey, envelope.signature, canonical);
  if (!sigOk) return { ok: false, reason: "Ed25519 verify failed" };

  // Step 10: body_hash.
  const observedBodyHash = await sha256(args.responseBody);
  if (!constantTimeEqual(c.bodyHash, observedBodyHash)) {
    return { ok: false, reason: "body_hash mismatch" };
  }

  // Step 11: headers_hash.
  const headersBytes = buildHeadersCommittedBytes(args.responseHeaders);
  const observedHeadersHash = await sha256(headersBytes);
  if (!constantTimeEqual(c.headersHash, observedHeadersHash)) {
    return { ok: false, reason: "headers_hash mismatch" };
  }

  // Step 12: clock-skew.
  if (Math.abs(args.nowMs - c.timestampMs) > RECEIPT_CLOCK_SKEW_MS) {
    return { ok: false, reason: `timestamp_ms out of skew window (${Math.abs(args.nowMs - c.timestampMs)}ms)` };
  }

  // Step 13: status range (defensive — receipts are owed only on 2xx).
  if (c.status < 200 || c.status >= 300) {
    return { ok: false, reason: `status ${c.status} not 2xx` };
  }

  return { ok: true, commitment: c, envelope };
}

// ── Archival audit (§2.2.2) ───────────────────────────────────────────────

export interface VArchivalVerifyArgs {
  /** The receipt envelope bytes (decoded from storage). */
  envelopeBytes: Uint8Array;
  /** Expected request_canon (V re-derives, MUST agree with archive). */
  requestCanon: Uint8Array;
  /** Expected response body bytes (V holds these from archive). */
  responseBody: Uint8Array;
  /** Expected response headers (V holds these from archive). */
  responseHeaders: Headers;
  /** Pubkey for the receipt's declared epoch, from archival CA bundle. */
  archivalPubkey: Uint8Array;
  /** Expected actor fingerprint. */
  expectedActorFp: Uint8Array;
  /**
   * Compromise notice for the epoch, if any. When present + the
   * receipt's timestamp_ms >= notice.compromisedAtMs, the receipt is
   * untrustworthy per §2.7.
   */
  compromiseNotice?: { compromisedAtMs: number; verified: boolean };
}

export type VArchivalResult =
  | { ok: true; commitment: ReceiptCommitment; envelope: ReceiptEnvelope; trustedUnderCompromise: boolean }
  | { ok: false; reason: string };

/**
 * RECEIPTS.md §2.2.2 V-archival verification. Skips the live-epoch
 * tolerance check (auditor accepts arbitrary historical epochs as long
 * as the pubkey resolves). Adds the compromise-notice timestamp gate.
 *
 * `trustedUnderCompromise` is true when the receipt remains trustworthy
 * (no notice OR notice exists but receipt was signed before compromise).
 * Caller MUST surface this distinction to the audit consumer per §2.7.
 */
export async function verifyReceiptVArchival(args: VArchivalVerifyArgs): Promise<VArchivalResult> {
  const decoded = decodeReceiptBytes(args.envelopeBytes);
  if (!decoded.ok) return { ok: false, reason: `decode: ${decoded.reason}` };
  const envelope = decoded.value;
  const c = envelope.commitment;

  if (!constantTimeEqual(c.actorFp, args.expectedActorFp)) {
    return { ok: false, reason: "actor_fp mismatch" };
  }
  const expectedRequestHash = await sha256(args.requestCanon);
  if (!constantTimeEqual(c.requestHash, expectedRequestHash)) {
    return { ok: false, reason: "request_hash mismatch" };
  }

  const canonical = encodeCommitment(c);
  const sigOk = await verifyEd25519(args.archivalPubkey, envelope.signature, canonical);
  if (!sigOk) return { ok: false, reason: "Ed25519 verify failed (archival pubkey)" };

  const observedBodyHash = await sha256(args.responseBody);
  if (!constantTimeEqual(c.bodyHash, observedBodyHash)) {
    return { ok: false, reason: "body_hash mismatch" };
  }

  const headersBytes = buildHeadersCommittedBytes(args.responseHeaders);
  const observedHeadersHash = await sha256(headersBytes);
  if (!constantTimeEqual(c.headersHash, observedHeadersHash)) {
    return { ok: false, reason: "headers_hash mismatch" };
  }

  if (c.status < 200 || c.status >= 300) {
    return { ok: false, reason: `status ${c.status} not 2xx` };
  }

  // §2.7 compromise-notice handling.
  let trustedUnderCompromise = true;
  if (args.compromiseNotice && args.compromiseNotice.verified) {
    if (c.timestampMs >= args.compromiseNotice.compromisedAtMs) {
      // Receipt signed AT or AFTER compromise — untrustworthy.
      trustedUnderCompromise = false;
    }
  }

  return { ok: true, commitment: c, envelope, trustedUnderCompromise };
}

// ── Stream commitment verification (§2.4) ─────────────────────────────────

export interface StreamOpenVerifyArgs {
  /** The header value from the response's Interlace-Receipt. */
  headerValue: string;
  expectedActorFp: Uint8Array;
  currentEpoch: number;
  prevEpoch?: number;
  resolvePubkey: (epoch: number) => Uint8Array | null;
  expectedNonce: Uint8Array;
  requestCanon: Uint8Array;
  nowMs: number;
}

export type StreamOpenVerifyResult =
  | { ok: true; envelope: StreamOpenEnvelope; openCommitmentHash: Uint8Array }
  | { ok: false; reason: string };

/** Verify a stream-open commitment (P-live). */
export async function verifyStreamOpen(args: StreamOpenVerifyArgs): Promise<StreamOpenVerifyResult> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(args.headerValue);
  } catch (err) {
    return { ok: false, reason: `base64url decode: ${(err as Error).message}` };
  }
  const decoded = decodeStreamOpenEnvelopeBytes(bytes);
  if (!decoded.ok) return { ok: false, reason: `decode: ${decoded.reason}` };
  const envelope = decoded.value;
  const c = envelope.commitment;

  if (!constantTimeEqual(c.nonce, args.expectedNonce)) return { ok: false, reason: "nonce mismatch" };
  const expectedRequestHash = await sha256(args.requestCanon);
  if (!constantTimeEqual(c.requestHash, expectedRequestHash)) {
    return { ok: false, reason: "request_hash mismatch" };
  }
  if (!constantTimeEqual(c.actorFp, args.expectedActorFp)) {
    return { ok: false, reason: "actor_fp mismatch" };
  }
  if (c.epoch !== args.currentEpoch && c.epoch !== args.prevEpoch) {
    return { ok: false, reason: `epoch ${c.epoch} not in current/prev` };
  }
  const pubkey = args.resolvePubkey(c.epoch);
  if (pubkey === null) return { ok: false, reason: `pubkey unavailable epoch ${c.epoch}` };
  const canonical = encodeStreamOpenCommitment(c);
  const sigOk = await verifyEd25519(pubkey, envelope.signature, canonical);
  if (!sigOk) return { ok: false, reason: "Ed25519 verify failed" };

  if (Math.abs(args.nowMs - c.timestampMs) > RECEIPT_CLOCK_SKEW_MS) {
    return { ok: false, reason: "timestamp_ms out of skew window" };
  }
  if (c.status !== 200) return { ok: false, reason: `status not 200` };

  const openCommitmentHash = await sha256(canonical);
  return { ok: true, envelope, openCommitmentHash };
}

export interface StreamCloseVerifyArgs {
  /** base64url payload from the `interlace-stream-close` SSE event data. */
  payload: string;
  /** Expected open_commitment_hash to bind close→open (§2.4 N1). */
  expectedOpenCommitmentHash: Uint8Array;
  /** Expected tip_hash from P's rolling event-chain state. */
  expectedTipHash: Uint8Array;
  /** Pubkey for the receipt's epoch. */
  pubkey: Uint8Array;
}

export type StreamCloseVerifyResult =
  | { ok: true; envelope: StreamCloseEnvelope }
  | { ok: false; reason: string };

/** Verify a stream-close commitment + binding to the open. */
export async function verifyStreamClose(args: StreamCloseVerifyArgs): Promise<StreamCloseVerifyResult> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(args.payload);
  } catch (err) {
    return { ok: false, reason: `base64url decode: ${(err as Error).message}` };
  }
  const decoded = decodeStreamCloseEnvelopeBytes(bytes);
  if (!decoded.ok) return { ok: false, reason: `decode: ${decoded.reason}` };
  const envelope = decoded.value;
  const c = envelope.commitment;

  if (!constantTimeEqual(c.openCommitmentHash, args.expectedOpenCommitmentHash)) {
    return { ok: false, reason: "open_commitment_hash mismatch (close not bound to open)" };
  }
  if (!constantTimeEqual(c.tipHash, args.expectedTipHash)) {
    return { ok: false, reason: "tip_hash mismatch (P's rolling chain diverged)" };
  }

  const canonical = encodeStreamCloseCommitment(c);
  const sigOk = await verifyEd25519(args.pubkey, envelope.signature, canonical);
  if (!sigOk) return { ok: false, reason: "Ed25519 verify failed" };

  return { ok: true, envelope };
}

// ── helpers ───────────────────────────────────────────────────────────────

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
