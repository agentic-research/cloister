/**
 * Cap'n Proto wire codec primitives — workerd-side encoder/decoder.
 *
 * Hand-rolled per the decision in `wire/cloister.capnp` and bead
 * `cloister-5183bc` Phase 2D-codec. Single-segment, unpacked encoding —
 * sufficient for our 5-struct schema; full multi-segment + far-pointer
 * support is YAGNI here.
 *
 * Format (cap'n proto encoding spec):
 *
 *   stream-framing:
 *     [u32 LE: numSegments - 1]
 *     [u32 LE per segment: size in 8-byte words]
 *     [optional 4 bytes pad to 8-byte alignment]
 *     [segment 0 bytes][segment 1 bytes]...
 *
 *   single-segment shortcut: 8-byte header (0, segWords) + payload.
 *
 *   pointer (8 bytes):
 *     bits [0..2]   kind (0=struct, 1=list, 2=far, 3=other)
 *     bits [2..32]  signed word offset from end of pointer to target (struct/list)
 *     bits [32..48] dataWords (struct) | elementSize (list, 3 bits) + count (29 bits, list)
 *     bits [48..64] ptrWords  (struct) | -- (list)
 *
 *   list element sizes:
 *     0=void, 1=bit, 2=byte, 3=2B, 4=4B, 5=8B-data, 6=8B-pointer, 7=composite
 *
 * Endianness: little-endian everywhere.
 */

export const WORD = 8;
const LE = true;
const KIND_STRUCT = 0;
const KIND_LIST   = 1;
export const ELEM_BYTE = 2;

// ── Builder ────────────────────────────────────────────────────────────────

export class WireBuilder {
  private buf: Uint8Array = new Uint8Array(64);
  private len = 0;
  private dv: DataView = new DataView(this.buf.buffer);

  private grow(needed: number): void {
    if (this.len + needed <= this.buf.length) return;
    const newSize = Math.max(this.buf.length * 2, this.len + needed);
    const nb = new Uint8Array(newSize);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.dv = new DataView(this.buf.buffer);
  }

  /** Reserve N words (8B each); return the byte offset where they start. */
  reserveWords(n: number): number {
    this.grow(n * WORD);
    const off = this.len;
    this.len += n * WORD;
    // Already zero-initialized by Uint8Array.
    return off;
  }

  /**
   * Append `bytes` padded up to the next 8-byte boundary; return start offset.
   * Used for Data and Text payloads (Text is "Data terminated with NUL").
   */
  appendBytesPadded(bytes: Uint8Array): number {
    const padded = (bytes.length + WORD - 1) & ~(WORD - 1);
    this.grow(padded);
    const off = this.len;
    this.buf.set(bytes, off);
    // pad bytes are already 0
    this.len += padded;
    return off;
  }

  writeU8(off: number, v: number): void {
    this.dv.setUint8(off, v & 0xFF);
  }

  writeU16(off: number, v: number): void {
    this.dv.setUint16(off, v & 0xFFFF, LE);
  }

  writeU32(off: number, v: number): void {
    this.dv.setUint32(off, v >>> 0, LE);
  }

  writeU64(off: number, v: bigint): void {
    this.dv.setBigUint64(off, v, LE);
  }

  /** Write bit `bitIdx` (0..7) of byte at `off` to value (0|1). */
  writeBit(off: number, bitIdx: number, value: 0 | 1): void {
    const cur = this.dv.getUint8(off);
    const mask = 1 << (bitIdx & 7);
    this.dv.setUint8(off, value ? cur | mask : cur & ~mask);
  }

  /**
   * Write a struct pointer at `at` pointing to `target` with given section
   * sizes. Offset is computed from the end of the pointer (at + 8).
   */
  writeStructPointer(at: number, target: number, dataWords: number, ptrWords: number): void {
    const offsetWords = (target - (at + WORD)) / WORD;
    if (!Number.isInteger(offsetWords)) {
      throw new Error(`struct pointer target not word-aligned: ${target} - ${at}`);
    }
    // Low 32 bits: kind (2) | offsetSigned30 (30)
    const lo = ((offsetWords & 0x3FFFFFFF) << 2) | KIND_STRUCT;
    this.writeU32(at, lo);
    // High 32 bits: dataWords (16) | ptrWords (16)
    const hi = (dataWords & 0xFFFF) | ((ptrWords & 0xFFFF) << 16);
    this.writeU32(at + 4, hi);
  }

  /**
   * Write a list pointer at `at` pointing to `target` with given element
   * size code + element count.
   *
   * For COMPOSITE lists (elementSize=7), `count` is the total WORD count of
   * all elements (NOT including the tag word) per capnp spec. For all
   * other list types, `count` is the element count.
   */
  writeListPointer(at: number, target: number, elementSize: number, count: number): void {
    const offsetWords = (target - (at + WORD)) / WORD;
    if (!Number.isInteger(offsetWords)) {
      throw new Error(`list pointer target not word-aligned: ${target} - ${at}`);
    }
    const lo = ((offsetWords & 0x3FFFFFFF) << 2) | KIND_LIST;
    this.writeU32(at, lo);
    // High 32 bits: elementSize (3) | count (29)
    const hi = (elementSize & 7) | ((count & 0x1FFFFFFF) << 3);
    this.writeU32(at + 4, hi);
  }

  /**
   * Reserve a composite list of `count` struct elements, each of shape
   * (dataWords, ptrWords). Returns the byte offset of the TAG WORD, which
   * the list pointer should target. Element bodies are at:
   *   tagOff + 8 + i * (dataWords + ptrWords) * 8
   *
   * Always writes a tag word, including for count=0 — readers use the tag
   * to learn element shape regardless of element count.
   */
  reserveCompositeList(count: number, dataWords: number, ptrWords: number): number {
    const elemSize = dataWords + ptrWords;
    const totalBytes = (1 + count * elemSize) * WORD;  // tag + elements
    this.grow(totalBytes);
    const tagOff = this.len;
    this.len += totalBytes;

    // Tag word: shaped like a struct pointer, but offset field carries the
    // element COUNT (not a pointer offset).
    const lo = ((count & 0x3FFFFFFF) << 2) | KIND_STRUCT;
    this.writeU32(tagOff, lo);
    const hi = (dataWords & 0xFFFF) | ((ptrWords & 0xFFFF) << 16);
    this.writeU32(tagOff + 4, hi);
    return tagOff;
  }

  /** Finalize: prepend 8-byte segment header and return the full message bytes. */
  finalize(): Uint8Array {
    if (this.len % WORD !== 0) {
      throw new Error(`payload not word-aligned: ${this.len} bytes`);
    }
    const segWords = this.len / WORD;
    const out = new Uint8Array(8 + this.len);
    // segment count - 1 = 0 → first 4 bytes already zero
    new DataView(out.buffer).setUint32(4, segWords, LE);
    out.set(this.buf.subarray(0, this.len), 8);
    return out;
  }
}

// ── Reader ────────────────────────────────────────────────────────────────

export interface StructPtr { target: number; dataWords: number; ptrWords: number; }
export interface ListPtr   { target: number; elementSize: number; count: number; }

export class WireReader {
  // Field declarations rather than parameter properties — keeps the codec
  // compatible with `node --experimental-strip-types` so the verify-
  // roundtrip script (Phase 2D-codec.E) can import these modules without
  // a tsc precompile step.
  public readonly bytes: Uint8Array;
  private readonly dv: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Validate header and return the byte offset where segment 0 begins. */
  readSegmentStart(): number {
    if (this.bytes.length < 8) throw new Error("message shorter than segment header");
    const numMinus1 = this.dv.getUint32(0, LE);
    if (numMinus1 !== 0) {
      throw new Error(`expected single-segment message; got ${numMinus1 + 1} segments`);
    }
    const seg0Words = this.dv.getUint32(4, LE);
    const expectedLen = 8 + seg0Words * WORD;
    if (this.bytes.length < expectedLen) {
      throw new Error(`segment table claims ${seg0Words} words but message is ${this.bytes.length} bytes`);
    }
    return 8;
  }

  readU8(off: number): number {
    return this.dv.getUint8(off);
  }

  readU16(off: number): number {
    return this.dv.getUint16(off, LE);
  }

  readU32(off: number): number {
    return this.dv.getUint32(off, LE);
  }

  readU64(off: number): bigint {
    return this.dv.getBigUint64(off, LE);
  }

  /** Read bit `bitIdx` (0..7) of byte at `off`. */
  readBit(off: number, bitIdx: number): 0 | 1 {
    return ((this.dv.getUint8(off) >> (bitIdx & 7)) & 1) as 0 | 1;
  }

  /** Sign-extend a 30-bit field stored in the low 30 of a u32. */
  private signExtend30(raw: number): number {
    return (raw & 0x20000000) ? raw | ~0x3FFFFFFF : raw;
  }

  /**
   * True iff the 8 bytes at `at` are all zero (a "null pointer" in capnp).
   * Capnp encodes default-valued pointer fields as null pointers — empty
   * Data, empty Text, absent struct. Callers must decide what null means
   * for their schema's field type (typically: empty list / empty string /
   * absent struct).
   */
  isNullPointer(at: number): boolean {
    return this.dv.getBigUint64(at, LE) === 0n;
  }

  readStructPointer(at: number): StructPtr {
    const lo = this.readU32(at);
    const kind = lo & 3;
    if (kind !== KIND_STRUCT) {
      throw new Error(`expected struct pointer at ${at}; got kind=${kind}`);
    }
    const offsetWords = this.signExtend30(lo >>> 2);
    const hi = this.readU32(at + 4);
    return {
      target:    at + WORD + offsetWords * WORD,
      dataWords: hi & 0xFFFF,
      ptrWords:  (hi >>> 16) & 0xFFFF,
    };
  }

  readListPointer(at: number): ListPtr {
    const lo = this.readU32(at);
    const kind = lo & 3;
    if (kind !== KIND_LIST) {
      throw new Error(`expected list pointer at ${at}; got kind=${kind}`);
    }
    const offsetWords = this.signExtend30(lo >>> 2);
    const hi = this.readU32(at + 4);
    return {
      target:      at + WORD + offsetWords * WORD,
      elementSize: hi & 7,
      count:       (hi >>> 3) & 0x1FFFFFFF,
    };
  }

  /** Read `length` bytes starting at byte offset `start` (no padding handling). */
  readBytes(start: number, length: number): Uint8Array {
    if (start + length > this.bytes.length) {
      throw new Error(`read past end: ${start}+${length} > ${this.bytes.length}`);
    }
    return this.bytes.slice(start, start + length);
  }

  /**
   * Read the composite-list tag word at `at`. Returns the element count
   * and per-element shape. The tag word's "offset" field is the element
   * count (not a pointer offset).
   */
  readCompositeListTag(at: number): { count: number; dataWords: number; ptrWords: number } {
    const lo = this.readU32(at);
    if ((lo & 3) !== KIND_STRUCT) {
      throw new Error(`composite list tag at ${at} has wrong kind=${lo & 3} (expected struct/0)`);
    }
    // sign-extend 30-bit count field (capnp spec keeps it signed; for our
    // composite-list tag it's always non-negative)
    const count = (lo & 0x20000000) ? ((lo >>> 2) | ~0x3FFFFFFF) : (lo >>> 2);
    const hi = this.readU32(at + 4);
    return {
      count,
      dataWords: hi & 0xFFFF,
      ptrWords:  (hi >>> 16) & 0xFFFF,
    };
  }
}
