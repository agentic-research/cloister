// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical CBOR encoder for interlace 0.2.0 signed receipts
// (RECEIPTS.md §2.1, §3.1, §3.3). Text-key + byte-value flat maps with
// definite-length encoding, sorted bytewise-lex by canonical key bytes,
// shortest-form integer encoding, no floats, no tags.
//
// Scope: PURPOSE-BUILT for the receipt schemas. Not a general CBOR
// encoder. The receipt schemas are flat maps from short ASCII keys to
// (uint | bytes | text). Constraining the input shape lets us produce
// byte-stable canonical bytes without pulling in a full RFC 8949 library
// — and side-steps the cbor-x landmines (it does NOT reject indefinite-
// length encodings, integer-key reordering, or tag emission).
//
// Math-friend review notes that map to invariants enforced here:
//
//   - Definite-length only        — every map/array uses definite-length
//                                   header bytes (§3.1 4th bullet).
//   - Text-string keys only       — §3.1 bullet 7 forbids integer keys.
//   - Byte-string values for      — §3.1 bullet 11 (header values).
//     header values
//   - Shortest-form integers      — §3.1 bullet 3.
//   - No floats / NaN             — §3.1 bullet 7.
//   - No tags                     — §3.1 bullet 8.
//   - Bytewise-lex key sort over  — §2.1 sort-on-serialized-key.
//     the serialized key bytes
//
// The schemas this encoder handles use ONLY text keys ≤24 bytes (all
// schema keys in the spec are well below 24 bytes), so key encoding is
// single-byte-header + ASCII. We still sort by the full canonical key
// bytes (header + body) per spec, not just the body.

/**
 * A canonical-CBOR-encodable receipt value:
 *
 *   - `number`           — non-negative integer, encoded as CBOR major type 0.
 *                          Float / NaN / -0.0 forbidden by §3.1.
 *   - `bigint`           — non-negative bigint, encoded as CBOR major type 0
 *                          (8-byte form for values > 2^32-1).
 *   - `Uint8Array`       — byte string, encoded as CBOR major type 2.
 *                          Used for hashes, signatures, nonces, header values.
 *   - `string`           — text string, encoded as CBOR major type 3.
 *                          Used for enum labels (`stream_mode`, `close_status`).
 *   - `ReceiptCborValue[]` — array, encoded as CBOR major type 4.
 *                            Used for receipt-envelope outer shape.
 *   - `ReceiptCborMap`   — text-keyed flat map, encoded as CBOR major type 5.
 */
export type ReceiptCborValue =
  | number
  | bigint
  | Uint8Array
  | string
  | ReceiptCborValue[]
  | ReceiptCborMap;

/** Text-keyed flat map of canonical values. */
export type ReceiptCborMap = { readonly [key: string]: ReceiptCborValue };

/** Custom error class for canonical-CBOR encoding failures. */
export class CanonicalCborError extends Error {
  override readonly name = "CanonicalCborError";
}

// ── Header encoding (§3.1 shortest-form rule) ────────────────────────────

/**
 * Write a CBOR head byte (major type + argument) using the shortest form
 * representation per RFC 8949 §4.2.1. Returns the bytes that must precede
 * any following payload.
 *
 *   value < 24            → 1-byte: (major << 5) | value
 *   value < 256           → 2-byte: (major << 5) | 24, value
 *   value < 65536         → 3-byte: (major << 5) | 25, hi, lo
 *   value < 2^32          → 5-byte: (major << 5) | 26, b3, b2, b1, b0
 *   value <= 2^64-1       → 9-byte: (major << 5) | 27, 8 big-endian bytes
 */
function writeHead(major: number, value: bigint): Uint8Array {
  if (value < 0n) {
    throw new CanonicalCborError(`negative value not permitted in receipt CBOR (got ${value})`);
  }
  const tag = (major & 0x07) << 5;
  if (value < 24n) {
    return Uint8Array.of(tag | Number(value));
  }
  if (value < 0x100n) {
    return Uint8Array.of(tag | 24, Number(value));
  }
  if (value < 0x10000n) {
    const v = Number(value);
    return Uint8Array.of(tag | 25, (v >> 8) & 0xff, v & 0xff);
  }
  if (value < 0x100000000n) {
    const v = Number(value);
    return Uint8Array.of(
      tag | 26,
      (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff,
    );
  }
  if (value < 0x10000000000000000n) {
    const out = new Uint8Array(9);
    out[0] = tag | 27;
    let v = value;
    for (let i = 8; i >= 1; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }
  throw new CanonicalCborError(`value ${value} exceeds u64 max for canonical CBOR`);
}

// ── Per-type encoding ─────────────────────────────────────────────────────

function encodeUint(v: number | bigint): Uint8Array {
  // Validate numeric forms BEFORE conversion to BigInt — BigInt(1.5)
  // throws RangeError, but we want the canonical-cbor-specific error.
  if (typeof v === "number") {
    if (!Number.isFinite(v))  throw new CanonicalCborError(`non-finite number not permitted: ${v}`);
    if (!Number.isInteger(v)) throw new CanonicalCborError(`non-integer number not permitted: ${v}`);
  }
  const big = typeof v === "bigint" ? v : BigInt(v);
  if (big < 0n) throw new CanonicalCborError(`uint encoding got negative: ${v}`);
  return writeHead(0, big);
}

function encodeBytes(v: Uint8Array): Uint8Array {
  const head = writeHead(2, BigInt(v.length));
  const out = new Uint8Array(head.length + v.length);
  out.set(head, 0);
  out.set(v, head.length);
  return out;
}

function encodeText(v: string): Uint8Array {
  const bytes = new TextEncoder().encode(v);
  const head = writeHead(3, BigInt(bytes.length));
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}

function encodeArray(v: ReceiptCborValue[]): Uint8Array {
  const head = writeHead(4, BigInt(v.length));
  const parts: Uint8Array[] = [head];
  let total = head.length;
  for (const item of v) {
    const enc = encodeValue(item);
    parts.push(enc);
    total += enc.length;
  }
  return concat(parts, total);
}

function encodeMap(m: ReceiptCborMap): Uint8Array {
  // Per RFC 8949 §4.2: sort by bytewise lex of the deterministic
  // encoding of the key. For text-only keys, that means encoding each
  // key first, then comparing the encoded byte sequences.
  type Entry = { keyEnc: Uint8Array; valueEnc: Uint8Array };
  const entries: Entry[] = [];
  for (const [k, val] of Object.entries(m)) {
    if (val === undefined) continue;
    if (typeof k !== "string") {
      throw new CanonicalCborError(`map keys must be strings (got ${typeof k})`);
    }
    entries.push({
      keyEnc:   encodeText(k),
      valueEnc: encodeValue(val),
    });
  }
  entries.sort((a, b) => compareBytes(a.keyEnc, b.keyEnc));
  // Defensive: forbid duplicate keys after sort (would indicate Object
  // shape with non-canonical keys — JS prevents duplicate own-string keys
  // but defense-in-depth catches accidental misuse via Maps cast through).
  for (let i = 1; i < entries.length; i++) {
    if (compareBytes(entries[i - 1]!.keyEnc, entries[i]!.keyEnc) === 0) {
      throw new CanonicalCborError("duplicate map key in canonical CBOR encoding");
    }
  }
  const head = writeHead(5, BigInt(entries.length));
  const parts: Uint8Array[] = [head];
  let total = head.length;
  for (const e of entries) {
    parts.push(e.keyEnc);
    parts.push(e.valueEnc);
    total += e.keyEnc.length + e.valueEnc.length;
  }
  return concat(parts, total);
}

function encodeValue(v: ReceiptCborValue): Uint8Array {
  if (v === null || v === undefined) {
    throw new CanonicalCborError("null/undefined not permitted in receipt CBOR (omit the key instead)");
  }
  if (typeof v === "number" || typeof v === "bigint") return encodeUint(v);
  if (v instanceof Uint8Array) return encodeBytes(v);
  if (typeof v === "string") return encodeText(v);
  if (Array.isArray(v)) return encodeArray(v);
  if (typeof v === "object") return encodeMap(v as ReceiptCborMap);
  throw new CanonicalCborError(`unsupported type for canonical CBOR: ${typeof v}`);
}

/**
 * Canonically encode a value per the receipt-CBOR shape rules. This is
 * the ONLY function in this module callers should use; the per-type
 * helpers are exported for unit testing the encoding boundary.
 *
 * Stability invariant: for byte-identical inputs, this function emits
 * byte-identical output across runs, hosts, and process boundaries.
 * Test vectors in `test/wire/receipts-cbor.test.ts` pin the bytes for
 * each spec schema.
 */
export function canonicalCbor(value: ReceiptCborValue): Uint8Array {
  return encodeValue(value);
}

// ── helpers ───────────────────────────────────────────────────────────────

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) return (a[i]! - b[i]!);
  }
  return a.length - b.length;
}

// ── Decoder (verification-side only) ──────────────────────────────────────
//
// Receipts arrive as bytes; verifiers parse them to extract the
// commitment + signature. The decoder is strict: it REQUIRES canonical
// form. Any indefinite-length byte/text/list/map, integer key, tag, or
// non-shortest-form integer is rejected.

interface DecodeCursor {
  bytes: Uint8Array;
  pos:   number;
}

function readByte(c: DecodeCursor): number {
  if (c.pos >= c.bytes.length) {
    throw new CanonicalCborError("CBOR decode: unexpected end of input");
  }
  return c.bytes[c.pos++]!;
}

function readBytes(c: DecodeCursor, n: number): Uint8Array {
  if (c.pos + n > c.bytes.length) {
    throw new CanonicalCborError(`CBOR decode: short read (need ${n}, have ${c.bytes.length - c.pos})`);
  }
  const out = c.bytes.subarray(c.pos, c.pos + n);
  c.pos += n;
  return out;
}

function readArgument(initial: number, c: DecodeCursor): bigint {
  const info = initial & 0x1f;
  if (info < 24) return BigInt(info);
  if (info === 24) {
    const v = readByte(c);
    if (v < 24) throw new CanonicalCborError("CBOR decode: non-canonical 1-byte length");
    return BigInt(v);
  }
  if (info === 25) {
    const hi = readByte(c), lo = readByte(c);
    const v = (hi << 8) | lo;
    if (v < 256) throw new CanonicalCborError("CBOR decode: non-canonical 2-byte length");
    return BigInt(v);
  }
  if (info === 26) {
    const b3 = readByte(c), b2 = readByte(c), b1 = readByte(c), b0 = readByte(c);
    const v = ((b3 << 24) >>> 0) | (b2 << 16) | (b1 << 8) | b0;
    if (v < 65536) throw new CanonicalCborError("CBOR decode: non-canonical 4-byte length");
    return BigInt(v);
  }
  if (info === 27) {
    let v = 0n;
    for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(readByte(c));
    if (v < 0x100000000n) throw new CanonicalCborError("CBOR decode: non-canonical 8-byte length");
    return v;
  }
  // 28..30 reserved; 31 = indefinite-length — both forbidden in canonical form.
  throw new CanonicalCborError(`CBOR decode: forbidden additional-info ${info} (indefinite or reserved)`);
}

/** Decode any canonical-CBOR value. Strict — rejects non-canonical forms. */
export function decodeCanonicalCbor(bytes: Uint8Array): ReceiptCborValue {
  const c: DecodeCursor = { bytes, pos: 0 };
  const v = decodeValue(c);
  if (c.pos !== bytes.length) {
    throw new CanonicalCborError(`CBOR decode: trailing bytes (consumed ${c.pos}, total ${bytes.length})`);
  }
  return v;
}

function decodeValue(c: DecodeCursor): ReceiptCborValue {
  const initial = readByte(c);
  const major = initial >> 5;
  switch (major) {
    case 0: { // uint
      const arg = readArgument(initial, c);
      return arg < 0x20000000000000n ? Number(arg) : arg;
    }
    case 1:   // negative int — forbidden (no negatives in receipt schemas)
      throw new CanonicalCborError("CBOR decode: negative integers forbidden in receipt CBOR");
    case 2: { // bytes
      const len = readArgument(initial, c);
      return readBytes(c, Number(len)).slice();
    }
    case 3: { // text
      const len = readArgument(initial, c);
      return new TextDecoder().decode(readBytes(c, Number(len)));
    }
    case 4: { // array
      const n = Number(readArgument(initial, c));
      const out: ReceiptCborValue[] = [];
      for (let i = 0; i < n; i++) out.push(decodeValue(c));
      return out;
    }
    case 5: { // map
      const n = Number(readArgument(initial, c));
      const out: Record<string, ReceiptCborValue> = {};
      let prevKeyBytes: Uint8Array | null = null;
      for (let i = 0; i < n; i++) {
        // Capture the key's encoded bytes so we can enforce sort order.
        const keyStart = c.pos;
        const key = decodeValue(c);
        const keyEnd = c.pos;
        if (typeof key !== "string") {
          throw new CanonicalCborError(`CBOR decode: non-text map key (key #${i})`);
        }
        const keyBytes = c.bytes.subarray(keyStart, keyEnd);
        if (prevKeyBytes !== null && compareBytes(prevKeyBytes, keyBytes) >= 0) {
          throw new CanonicalCborError("CBOR decode: map keys not in canonical sort order");
        }
        prevKeyBytes = keyBytes.slice();
        out[key] = decodeValue(c);
      }
      return out;
    }
    case 6:   // tag — forbidden per §3.1 bullet 8
      throw new CanonicalCborError("CBOR decode: tagged values forbidden");
    case 7:   // simple/float — forbidden per §3.1 bullet 7
      throw new CanonicalCborError("CBOR decode: simple/float values forbidden");
    default:
      throw new CanonicalCborError(`CBOR decode: unreachable major type ${major}`);
  }
}
