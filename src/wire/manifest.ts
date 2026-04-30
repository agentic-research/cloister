/**
 * Manifest wire codec — leyline-net per-message header.
 *
 * Schema source: `wire/cloister.capnp` struct Manifest. ADR-0005 §"Manifest".
 *
 * Layout when encoded as a single-segment, unpacked capnp message:
 *
 *     bytes  0..  7  : segment table (count-1=0, segWords=21)
 *     bytes  8.. 15  : root struct pointer (1d/3p, target offset 0)
 *     bytes 16.. 23  : data section — UInt64 sequence (LE)
 *     bytes 24.. 31  : pointer 0 — list ptr to publicKey (32B)
 *     bytes 32.. 39  : pointer 1 — list ptr to signature (64B)
 *     bytes 40.. 47  : pointer 2 — list ptr to contentHash (32B)
 *     bytes 48.. 79  : publicKey payload (4 words, no padding)
 *     bytes 80..143  : signature payload (8 words)
 *     bytes 144..175 : contentHash payload (4 words)
 *
 * Total: 176 bytes (8 header + 21 segment words). Fixed-size — no dynamic
 * allocation needed at runtime, and length checks are O(1).
 */

import { ELEM_BYTE, WORD, WireBuilder, WireReader } from "./codec.js";

// ── Domain constants (binding cryptographic primitives we accept) ────────

export const MANIFEST_PUBKEY_BYTES = 32;   // Ed25519 public key
export const MANIFEST_SIG_BYTES    = 64;   // Ed25519 signature
export const MANIFEST_HASH_BYTES   = 32;   // SHA-256

/** Total length of an encoded Manifest (always exactly this many bytes). */
export const MANIFEST_ENCODED_BYTES = 176;

// ── Type ──────────────────────────────────────────────────────────────────

export interface Manifest {
  /** Monotonic per-publicKey counter; receivers reject sequence ≤ last-seen. */
  sequence:    bigint;
  /** Ed25519 public key (32 bytes). */
  publicKey:   Uint8Array;
  /** Ed25519 signature over (sequence ‖ contentHash) (64 bytes). */
  signature:   Uint8Array;
  /** SHA-256 of the AEAD plaintext (32 bytes). */
  contentHash: Uint8Array;
}

// ── Encode ────────────────────────────────────────────────────────────────

export function encodeManifest(m: Manifest): Uint8Array {
  if (m.publicKey.length !== MANIFEST_PUBKEY_BYTES) {
    throw new Error(`manifest.publicKey must be ${MANIFEST_PUBKEY_BYTES} bytes; got ${m.publicKey.length}`);
  }
  if (m.signature.length !== MANIFEST_SIG_BYTES) {
    throw new Error(`manifest.signature must be ${MANIFEST_SIG_BYTES} bytes; got ${m.signature.length}`);
  }
  if (m.contentHash.length !== MANIFEST_HASH_BYTES) {
    throw new Error(`manifest.contentHash must be ${MANIFEST_HASH_BYTES} bytes; got ${m.contentHash.length}`);
  }

  const b = new WireBuilder();
  // Layout: root pointer (W0), data word (W1), three pointer words (W2..W4),
  // then payloads appended at the end.
  const rootPtr = b.reserveWords(1);   //  0
  const dataOff = b.reserveWords(1);   //  8
  const p0Off   = b.reserveWords(1);   // 16
  const p1Off   = b.reserveWords(1);   // 24
  const p2Off   = b.reserveWords(1);   // 32

  b.writeStructPointer(rootPtr, dataOff, /*data*/ 1, /*ptr*/ 3);
  b.writeU64(dataOff, m.sequence);

  const pkOff = b.appendBytesPadded(m.publicKey);
  b.writeListPointer(p0Off, pkOff, ELEM_BYTE, MANIFEST_PUBKEY_BYTES);

  const sigOff = b.appendBytesPadded(m.signature);
  b.writeListPointer(p1Off, sigOff, ELEM_BYTE, MANIFEST_SIG_BYTES);

  const chOff = b.appendBytesPadded(m.contentHash);
  b.writeListPointer(p2Off, chOff, ELEM_BYTE, MANIFEST_HASH_BYTES);

  return b.finalize();
}

// ── Decode ────────────────────────────────────────────────────────────────

export function decodeManifest(bytes: Uint8Array): Manifest {
  const r = new WireReader(bytes);
  const segStart = r.readSegmentStart();

  const root = r.readStructPointer(segStart);
  if (root.dataWords < 1 || root.ptrWords < 3) {
    throw new Error(
      `Manifest struct too small: dataWords=${root.dataWords} ptrWords=${root.ptrWords} (need 1d/3p)`,
    );
  }

  const sequence = r.readU64(root.target);

  const ptr0 = r.readListPointer(root.target + 1 * WORD);
  const ptr1 = r.readListPointer(root.target + 2 * WORD);
  const ptr2 = r.readListPointer(root.target + 3 * WORD);

  if (ptr0.elementSize !== ELEM_BYTE || ptr0.count !== MANIFEST_PUBKEY_BYTES) {
    throw new Error(`Manifest.publicKey shape: elem=${ptr0.elementSize} count=${ptr0.count}`);
  }
  if (ptr1.elementSize !== ELEM_BYTE || ptr1.count !== MANIFEST_SIG_BYTES) {
    throw new Error(`Manifest.signature shape: elem=${ptr1.elementSize} count=${ptr1.count}`);
  }
  if (ptr2.elementSize !== ELEM_BYTE || ptr2.count !== MANIFEST_HASH_BYTES) {
    throw new Error(`Manifest.contentHash shape: elem=${ptr2.elementSize} count=${ptr2.count}`);
  }

  return {
    sequence,
    publicKey:   r.readBytes(ptr0.target, MANIFEST_PUBKEY_BYTES),
    signature:   r.readBytes(ptr1.target, MANIFEST_SIG_BYTES),
    contentHash: r.readBytes(ptr2.target, MANIFEST_HASH_BYTES),
  };
}
