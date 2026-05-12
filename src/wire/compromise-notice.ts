// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Compromise notice construction + verification (RECEIPTS.md §2.7).
//
// When master key sk_N is leaked, A rotates to sk_{N+1} FIRST, then
// signs a `compromise_notice` with sk_{N+1} declaring the compromise.
// V's verification of a receipt under epoch N MUST check for a
// notice; receipts with timestamp_ms < compromised_at_ms remain
// trusted (EUF-CMA holds before compromise).
//
// The notice envelope is canonical CBOR + Ed25519 signature, same
// pattern as receipts.

import { canonicalCbor, decodeCanonicalCbor, type ReceiptCborMap, type ReceiptCborValue } from "./receipts-cbor.js";
import { sha256, verifyEd25519, b64urlEncode } from "./receipts.js";
import type { ReceiptSigner } from "./receipts.js";

export interface CompromiseNoticeCommitment {
  /** N — the leaked epoch. */
  compromisedEpoch:  number;
  /** T — earliest known compromise timestamp (unix ms). */
  compromisedAtMs:   number;
  /** SHA-256 of sk_N's pubkey. */
  prevPubkeyFp:      Uint8Array;
  /** A's stable cross-rotation master fp. */
  rotationActorFp:   Uint8Array;
  /** When this notice was published (unix ms). */
  noticeAtMs:        number;
}

export interface CompromiseNoticeEnvelope {
  commitment: CompromiseNoticeCommitment;
  /** Ed25519(sk_{N+1}, canonical_cbor(commitment)). */
  signature:  Uint8Array;
}

export function compromiseNoticeCborMap(c: CompromiseNoticeCommitment): ReceiptCborMap {
  return {
    compromised_at_ms:  c.compromisedAtMs,
    compromised_epoch:  c.compromisedEpoch,
    notice_at_ms:       c.noticeAtMs,
    prev_pubkey_fp:     c.prevPubkeyFp,
    rotation_actor_fp:  c.rotationActorFp,
  };
}

export function encodeCompromiseNotice(c: CompromiseNoticeCommitment): Uint8Array {
  return canonicalCbor(compromiseNoticeCborMap(c));
}

export function encodeCompromiseNoticeEnvelope(env: CompromiseNoticeEnvelope): Uint8Array {
  return canonicalCbor({
    commitment: compromiseNoticeCborMap(env.commitment),
    signature:  env.signature,
  });
}

/** Sign a compromise-notice commitment using the NEXT-epoch signing key. */
export async function signCompromiseNotice(
  c: CompromiseNoticeCommitment,
  nextEpochSigner: ReceiptSigner,
): Promise<{ envelope: CompromiseNoticeEnvelope; envelopeBytes: Uint8Array; headerB64u: string }> {
  const canon = encodeCompromiseNotice(c);
  const signature = await nextEpochSigner.sign(canon);
  const envelope: CompromiseNoticeEnvelope = { commitment: c, signature };
  const envelopeBytes = encodeCompromiseNoticeEnvelope(envelope);
  return { envelope, envelopeBytes, headerB64u: b64urlEncode(envelopeBytes) };
}

type DecodeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function decodeCompromiseNotice(bytes: Uint8Array): DecodeResult<CompromiseNoticeEnvelope> {
  let outer: ReceiptCborValue;
  try { outer = decodeCanonicalCbor(bytes); }
  catch (err) { return { ok: false, reason: `cbor decode: ${(err as Error).message}` }; }
  if (typeof outer !== "object" || outer === null || outer instanceof Uint8Array || Array.isArray(outer)) {
    return { ok: false, reason: "envelope not a map" };
  }
  const m = outer as ReceiptCborMap;
  const keys = Object.keys(m).sort();
  if (keys.length !== 2 || keys[0] !== "commitment" || keys[1] !== "signature") {
    return { ok: false, reason: `unexpected keys: ${JSON.stringify(keys)}` };
  }
  const cMap = m["commitment"];
  const sig = m["signature"];
  if (typeof cMap !== "object" || cMap === null || cMap instanceof Uint8Array || Array.isArray(cMap)) {
    return { ok: false, reason: "commitment not a map" };
  }
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return { ok: false, reason: "signature" };

  const required = ["compromised_at_ms", "compromised_epoch", "notice_at_ms", "prev_pubkey_fp", "rotation_actor_fp"];
  const cm = cMap as ReceiptCborMap;
  for (const r of required) if (!(r in cm)) return { ok: false, reason: `commitment missing ${r}` };
  const extras = Object.keys(cm).filter((k) => !required.includes(k));
  if (extras.length > 0) return { ok: false, reason: `commitment unexpected ${JSON.stringify(extras)}` };

  if (typeof cm["compromised_at_ms"] !== "number") return { ok: false, reason: "compromised_at_ms" };
  if (typeof cm["compromised_epoch"] !== "number") return { ok: false, reason: "compromised_epoch" };
  if (typeof cm["notice_at_ms"]      !== "number") return { ok: false, reason: "notice_at_ms" };
  if (!(cm["prev_pubkey_fp"] instanceof Uint8Array) || cm["prev_pubkey_fp"].length !== 32) {
    return { ok: false, reason: "prev_pubkey_fp" };
  }
  if (!(cm["rotation_actor_fp"] instanceof Uint8Array) || cm["rotation_actor_fp"].length !== 32) {
    return { ok: false, reason: "rotation_actor_fp" };
  }

  return {
    ok: true,
    value: {
      commitment: {
        compromisedAtMs:  cm["compromised_at_ms"] as number,
        compromisedEpoch: cm["compromised_epoch"] as number,
        noticeAtMs:       cm["notice_at_ms"]      as number,
        prevPubkeyFp:     cm["prev_pubkey_fp"]    as Uint8Array,
        rotationActorFp:  cm["rotation_actor_fp"] as Uint8Array,
      },
      signature: sig,
    },
  };
}

export interface VerifyCompromiseNoticeArgs {
  envelopeBytes: Uint8Array;
  /** Pubkey of sk_{N+1} (the next-epoch key the notice MUST be signed by). */
  nextEpochPubkey: Uint8Array;
  /** SHA-256(sk_N pubkey) — for the prev_pubkey_fp consistency check. */
  expectedPrevPubkeyFp: Uint8Array;
}

export type CompromiseNoticeVerifyResult =
  | { ok: true; envelope: CompromiseNoticeEnvelope }
  | { ok: false; reason: string };

/**
 * Verify a compromise notice. Returns { ok: true, ... } iff the
 * signature is valid under the next-epoch key AND the declared
 * prev_pubkey_fp matches the caller's expectation.
 */
export async function verifyCompromiseNotice(
  args: VerifyCompromiseNoticeArgs,
): Promise<CompromiseNoticeVerifyResult> {
  const decoded = decodeCompromiseNotice(args.envelopeBytes);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const env = decoded.value;
  const canon = encodeCompromiseNotice(env.commitment);
  const sigOk = await verifyEd25519(args.nextEpochPubkey, env.signature, canon);
  if (!sigOk) return { ok: false, reason: "Ed25519 verify failed (next-epoch key)" };

  // Defensive: prev_pubkey_fp consistency. The notice MUST refer to
  // the compromised key whose pubkey hash matches our expectation;
  // otherwise the operator might have published a notice against the
  // wrong epoch.
  const a = env.commitment.prevPubkeyFp;
  const b = args.expectedPrevPubkeyFp;
  let diff = 0;
  if (a.length !== b.length) diff = 1;
  else for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  if (diff !== 0) return { ok: false, reason: "prev_pubkey_fp mismatch" };

  return { ok: true, envelope: env };
}

/** Compute the SHA-256 of a pubkey (the `prev_pubkey_fp` value). */
export async function pubkeyFingerprint(pubkey: Uint8Array): Promise<Uint8Array> {
  return sha256(pubkey);
}
