/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  CanonicalCborError,
  canonicalCbor,
  decodeCanonicalCbor,
} from "../../src/wire/receipts-cbor.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("canonical-CBOR encoder (interlace 0.2.0 receipts)", () => {
  it("encodes empty map as single 0xA0 byte", () => {
    const out = canonicalCbor({});
    expect(hex(out)).toBe("a0");
  });

  it("encodes uint 0 as single 0x00 byte (shortest form)", () => {
    const out = canonicalCbor({ a: 0 });
    // map(1) + key "a" (text(1) "a") + value 0
    expect(hex(out)).toBe("a1" + "6161" + "00");
  });

  it("encodes uint 23 as single-byte 0x17 (boundary)", () => {
    const out = canonicalCbor({ x: 23 });
    expect(hex(out)).toBe("a1" + "6178" + "17");
  });

  it("encodes uint 24 as 2-byte 0x18 0x18 (next-form boundary)", () => {
    const out = canonicalCbor({ x: 24 });
    expect(hex(out)).toBe("a1" + "6178" + "1818");
  });

  it("encodes uint 255 as 0x18 0xff (max 1-byte)", () => {
    const out = canonicalCbor({ x: 255 });
    expect(hex(out)).toBe("a1" + "6178" + "18ff");
  });

  it("encodes uint 256 as 0x19 0x01 0x00 (2-byte form)", () => {
    const out = canonicalCbor({ x: 256 });
    expect(hex(out)).toBe("a1" + "6178" + "190100");
  });

  it("encodes uint 65535 / 65536 around the 2/4-byte boundary", () => {
    expect(hex(canonicalCbor({ x: 65535 }))).toBe("a1" + "6178" + "19ffff");
    expect(hex(canonicalCbor({ x: 65536 }))).toBe("a1" + "6178" + "1a00010000");
  });

  it("encodes uint at 4/8-byte boundary correctly", () => {
    // 2^32 - 1 — 4-byte form
    expect(hex(canonicalCbor({ x: 0xffffffff }))).toBe("a1" + "6178" + "1affffffff");
    // 2^32 — 8-byte form
    expect(hex(canonicalCbor({ x: 0x100000000 }))).toBe("a1" + "6178" + "1b0000000100000000");
  });

  it("rejects negative numbers", () => {
    expect(() => canonicalCbor({ x: -1 })).toThrow(CanonicalCborError);
  });

  it("rejects floats / NaN", () => {
    expect(() => canonicalCbor({ x: 1.5 })).toThrow(CanonicalCborError);
    expect(() => canonicalCbor({ x: NaN })).toThrow(CanonicalCborError);
    expect(() => canonicalCbor({ x: Infinity })).toThrow(CanonicalCborError);
  });

  it("encodes bytes as major type 2 (NOT text)", () => {
    const out = canonicalCbor({ b: new Uint8Array([0x80, 0x81]) });
    // bytes(2) header = 0x42 (major 2 = 0b010 << 5 = 0x40 | len 2)
    expect(hex(out)).toBe("a1" + "6162" + "428081");
  });

  it("encodes high-bit-set first byte in bytes correctly (regression for naive encoders)", () => {
    const out = canonicalCbor({ h: new Uint8Array([0xff, 0xff]) });
    expect(hex(out)).toBe("a1" + "6168" + "42ffff");
  });

  it("encodes text as major type 3", () => {
    const out = canonicalCbor({ s: "ok" });
    // text(2) "ok" → 0x62 + "ok"
    expect(hex(out)).toBe("a1" + "6173" + "626f6b");
  });

  it("sorts keys by bytewise lex over serialized key bytes (RFC 8949 §4.2)", () => {
    // Keys "aa" and "b": "aa" is text(2) = 0x62 + "aa" (3 bytes total);
    // "b" is text(1) = 0x61 + "b" (2 bytes). Bytewise-lex shorter first
    // — so "b" sorts BEFORE "aa". This differs from naive ASCII sort.
    const out = canonicalCbor({ aa: 1, b: 2 });
    // Expected: map(2), key "b", value 2, key "aa", value 1
    expect(hex(out)).toBe("a2" + "6162" + "02" + "626161" + "01");
  });

  it("does not include undefined values", () => {
    const out = canonicalCbor({ a: 1, b: undefined as unknown as number });
    // Only "a" should appear.
    expect(hex(out)).toBe("a1" + "6161" + "01");
  });

  it("rejects null values", () => {
    expect(() => canonicalCbor({ a: null as unknown as number })).toThrow(CanonicalCborError);
  });

  it("encodes nested maps recursively", () => {
    const out = canonicalCbor({ outer: { inner: 1 } });
    // map(1) "outer" map(1) "inner" 01
    expect(hex(out)).toBe("a1" + "656f75746572" + "a1" + "65696e6e6572" + "01");
  });

  it("encodes arrays as major type 4", () => {
    const out = canonicalCbor([1, 2, 3]);
    expect(hex(out)).toBe("83" + "01" + "02" + "03");
  });

  it("round-trips through decode", () => {
    const value = {
      epoch: 1,
      nonce: new Uint8Array(16).fill(0xab),
      status: 200,
      timestamp_ms: 1700000000000,
    };
    const enc = canonicalCbor(value);
    const dec = decodeCanonicalCbor(enc);
    expect(dec).toEqual({
      epoch: 1,
      nonce: new Uint8Array(16).fill(0xab),
      status: 200,
      timestamp_ms: 1700000000000,
    });
  });

  it("decoder rejects indefinite-length forms", () => {
    // 0x9f = array indefinite-length
    expect(() => decodeCanonicalCbor(new Uint8Array([0x9f, 0xff]))).toThrow(CanonicalCborError);
    // 0xbf = map indefinite-length
    expect(() => decodeCanonicalCbor(new Uint8Array([0xbf, 0xff]))).toThrow(CanonicalCborError);
  });

  it("decoder rejects tags (major type 6)", () => {
    // 0xC0 = tag 0
    expect(() => decodeCanonicalCbor(new Uint8Array([0xc0, 0x00]))).toThrow(CanonicalCborError);
  });

  it("decoder rejects non-canonical length encoding", () => {
    // Encode uint 1 with the 2-byte form 0x18 0x01 instead of canonical 0x01.
    expect(() => decodeCanonicalCbor(new Uint8Array([0x18, 0x01]))).toThrow(CanonicalCborError);
  });

  it("decoder rejects out-of-order map keys", () => {
    // Manually-built map with keys in wrong order: { "b": 1, "a": 1 }
    const bad = new Uint8Array([
      0xa2,             // map(2)
      0x61, 0x62, 0x01, // "b" -> 1
      0x61, 0x61, 0x01, // "a" -> 1
    ]);
    expect(() => decodeCanonicalCbor(bad)).toThrow(CanonicalCborError);
  });

  it("decoder rejects trailing bytes", () => {
    // Valid empty map + extra byte
    expect(() => decodeCanonicalCbor(new Uint8Array([0xa0, 0xff]))).toThrow(CanonicalCborError);
  });

  it("byte-stable across repeated calls", () => {
    const value = { z: 1, a: new Uint8Array([0, 1]), m: 256 };
    const enc1 = canonicalCbor(value);
    const enc2 = canonicalCbor(value);
    expect(hex(enc1)).toBe(hex(enc2));
  });
});
