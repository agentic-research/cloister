import { describe, it, expect } from "vitest";
import { GLOB_CLOSURE_SCHEME, encodeGlobClosureParams } from "../../src/memoize/glob-closure.js";

describe("glob-closure/v1", () => {
  it("names the rule, not the mechanism", () => {
    expect(GLOB_CLOSURE_SCHEME).toBe("glob-closure/v1");
  });

  it("encodes patterns order-independently — the rule is a SET of globs", () => {
    const a = encodeGlobClosureParams(["scripts/**/*.mjs", "Taskfile.yml"]);
    const b = encodeGlobClosureParams(["Taskfile.yml", "scripts/**/*.mjs"]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("distinguishes a tightened glob from the original", () => {
    const wide   = encodeGlobClosureParams(["scripts/**/*.mjs"]);
    const narrow = encodeGlobClosureParams(["scripts/lib/**/*.mjs"]);
    expect(Array.from(wide)).not.toEqual(Array.from(narrow));
  });

  it("length-prefixes each pattern so concatenation cannot collide", () => {
    // ["ab","c"] and ["a","bc"] concatenate identically; the encoding must not.
    const x = encodeGlobClosureParams(["ab", "c"]);
    const y = encodeGlobClosureParams(["a", "bc"]);
    expect(Array.from(x)).not.toEqual(Array.from(y));
  });

  it("dedupes — the rule is a SET, not a multiset", () => {
    // ["a","a"] and ["a"] are the same rule; a multiset encoding would
    // give them different params (and hence different addresses).
    const dup = encodeGlobClosureParams(["a", "a"]);
    const single = encodeGlobClosureParams(["a"]);
    expect(Array.from(dup)).toEqual(Array.from(single));
  });

  it("sorts by UTF-8 BYTES, not UTF-16 code units (regression: Array.prototype.sort())", () => {
    // "Ｚ" (U+FF3A, fullwidth Latin capital Z) UTF-8-encodes starting with
    // byte 0xEF. "𐀀" (U+10000) UTF-8-encodes starting with byte 0xF0.
    // 0xEF < 0xF0, so the byte-sorted order is [Ｚ, 𐀀].
    //
    // Array.prototype.sort() on the raw strings instead compares UTF-16
    // CODE UNITS: "𐀀" is a surrogate pair starting with the code unit
    // 0xD800, while "Ｚ" is the single code unit 0xFF3A. 0xD800 < 0xFF3A,
    // so a naive `.sort()` over strings puts "𐀀" FIRST — the opposite
    // order from byte-sorting. Since this is a cross-runtime canonical
    // encoding that a Rust/Go verifier must be able to re-derive by
    // sorting `&[u8]`, a regression back to `.sort()` on strings would
    // silently produce a different (wrong) canonical order.
    const enc = new TextEncoder();
    const zBytes = enc.encode("Ｚ");
    const gBytes = enc.encode("𐀀");
    expect(Array.from(zBytes)).toEqual([0xef, 0xbc, 0xba]);
    expect(Array.from(gBytes)).toEqual([0xf0, 0x90, 0x80, 0x80]);

    const expected = new Uint8Array(8 + 8 + zBytes.length + 8 + gBytes.length);
    const view = new DataView(expected.buffer);
    let o = 0;
    view.setBigUint64(o, 2n, true); o += 8;
    view.setBigUint64(o, BigInt(zBytes.length), true); o += 8;
    expected.set(zBytes, o); o += zBytes.length;
    view.setBigUint64(o, BigInt(gBytes.length), true); o += 8;
    expected.set(gBytes, o);

    // Feed input in both orders — output must be identical, and must
    // match the byte-sorted order (Ｚ before 𐀀), not the naive-`.sort()`
    // order (which would put 𐀀 first).
    expect(Array.from(encodeGlobClosureParams(["Ｚ", "𐀀"]))).toEqual(Array.from(expected));
    expect(Array.from(encodeGlobClosureParams(["𐀀", "Ｚ"]))).toEqual(Array.from(expected));
  });
});
