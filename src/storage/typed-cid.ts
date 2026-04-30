/**
 * Typed Content Identifier (CID) — falsifiability stub for the math-friend's
 * substrate hypothesis. See bead `cloister-df79a5`. This module is a parallel,
 * non-invasive sketch alongside `Digest` in `types.ts`; it does NOT refactor
 * existing storage. If the falsifiability tests pass, this becomes the seed
 * for `cloister-dfbe92` (Digest upgrade); if they fail, the module is deleted.
 *
 * Address shape (per ley-line substrate ADR draft):
 *
 *     cid = <codec, 1 byte> ‖ <typeFingerprint, 8 bytes> ‖ <contentHash, 32 bytes>
 *
 * - **codec** identifies the chunk kind (workerd-isolate, mtls-injector, etc.)
 * - **typeFingerprint** is a truncated digest of the canonical port signature.
 *   Same shape ⇒ same fingerprint regardless of impl.
 * - **contentHash** is SHA-256 of canonical bytes — the existing `Digest`.
 *
 * Two consumption modes that the falsifiability tests exercise:
 *
 *   1. Content-bound (reference by full Cid) — equivalent to plain SHA today.
 *      A byte change in any reachable chunk cascades through every transitive
 *      root.
 *   2. Interface-bound (reference by InterfaceRef = codec + typeFingerprint
 *      only) — the manifest doesn't pin specific content. Same fingerprint
 *      content can substitute without invalidating the deployment root.
 */

import {
  type CanonicalValue,
  canonical,
  digestBytes,
} from "./canonical.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const FINGERPRINT_BYTES   = 8;   // 64 bits — collision-resistant for
                                        // the small interface space we need
export const CONTENT_HASH_BYTES  = 32;  // SHA-256
export const CID_BYTES           = 1 + FINGERPRINT_BYTES + CONTENT_HASH_BYTES;
export const CID_HEX_CHARS       = CID_BYTES * 2;

// Codec registry — small, audit-friendly. Real registry lives in ley-line
// substrate ADR; this is the test fixture.
export const Codec = {
  Raw:           0x00,
  WorkerdIsolate: 0x01,
  MtlsInjector:  0x02,
  HttpHandler:   0x03,
  BeadStore:     0x04,
} as const;

export type CodecId = number;

// ── Types ──────────────────────────────────────────────────────────────────

export interface Cid {
  readonly codec:           CodecId;
  readonly typeFingerprint: Uint8Array;  // FINGERPRINT_BYTES
  readonly contentHash:     Uint8Array;  // CONTENT_HASH_BYTES
}

/**
 * An address that names an *interface* without pinning content. Two chunks
 * with the same `InterfaceRef` are substitutable for each other from the
 * perspective of any consumer that references through it.
 */
export interface InterfaceRef {
  readonly codec:           CodecId;
  readonly typeFingerprint: Uint8Array;
}

export interface PortSignature {
  readonly inputs:  readonly string[];
  readonly outputs: readonly string[];
}

// ── Construction ───────────────────────────────────────────────────────────

/**
 * Compute the typeFingerprint from a port signature: truncated SHA-256 of
 * the canonical serialization. Permutation-invariance is intentional NOT
 * provided — port order is part of the interface.
 */
export async function fingerprintOf(sig: PortSignature): Promise<Uint8Array> {
  const bytes = canonical({ inputs: [...sig.inputs], outputs: [...sig.outputs] });
  const fullDigest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(fullDigest).slice(0, FINGERPRINT_BYTES);
}

/**
 * Hash a canonical value into a Cid given a codec + port signature.
 * Wraps the existing `digestBytes` for the content portion — no
 * cryptography is reinvented.
 */
export async function digestTyped(
  value: CanonicalValue,
  codec: CodecId,
  portSignature: PortSignature,
): Promise<Cid> {
  const bytes = canonical(value);
  // Reuse the existing hex Digest then unhex to bytes — keeps the audit
  // surface the same as today's hashing.
  const contentDigest = await digestBytes(bytes);
  return {
    codec,
    typeFingerprint: await fingerprintOf(portSignature),
    contentHash:     hexToBytes(contentDigest),
  };
}

/** Project a Cid down to its interface-only address. */
export function asInterfaceRef(cid: Cid): InterfaceRef {
  return { codec: cid.codec, typeFingerprint: cid.typeFingerprint };
}

// ── Comparison ─────────────────────────────────────────────────────────────

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function cidEqual(a: Cid, b: Cid): boolean {
  return a.codec === b.codec
      && bytesEqual(a.typeFingerprint, b.typeFingerprint)
      && bytesEqual(a.contentHash, b.contentHash);
}

export function interfaceRefMatches(ref: InterfaceRef, cid: Cid): boolean {
  return ref.codec === cid.codec
      && bytesEqual(ref.typeFingerprint, cid.typeFingerprint);
}

// ── Encoding ───────────────────────────────────────────────────────────────

/** Hex encoding — round-trips with `Digest` storage tables. */
export function encodeCidHex(cid: Cid): string {
  return cid.codec.toString(16).padStart(2, "0")
       + bytesToHex(cid.typeFingerprint)
       + bytesToHex(cid.contentHash);
}

export function decodeCidHex(hex: string): Cid {
  if (hex.length !== CID_HEX_CHARS) {
    throw new Error(`invalid CID hex length ${hex.length}, expected ${CID_HEX_CHARS}`);
  }
  return {
    codec:           parseInt(hex.slice(0, 2), 16),
    typeFingerprint: hexToBytes(hex.slice(2, 2 + FINGERPRINT_BYTES * 2)),
    contentHash:     hexToBytes(hex.slice(2 + FINGERPRINT_BYTES * 2)),
  };
}

// ── Hex helpers (private) ──────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
