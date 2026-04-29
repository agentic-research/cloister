/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { canonical, digestBytes, digestValue } from "../../src/storage/canonical.js";
import { isDigest } from "../../src/storage/types.js";

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// ── canonical() ────────────────────────────────────────────────────────────

describe("canonical bytes", () => {
  it("encodes primitives as JSON", () => {
    expect(decode(canonical(null))).toBe("null");
    expect(decode(canonical(true))).toBe("true");
    expect(decode(canonical(false))).toBe("false");
    expect(decode(canonical(42))).toBe("42");
    expect(decode(canonical("hi"))).toBe('"hi"');
  });

  it("emits no whitespace", () => {
    const s = decode(canonical({ a: 1, b: [2, 3] }));
    expect(s).toBe('{"a":1,"b":[2,3]}');
  });

  it("sorts object keys lexicographically", () => {
    expect(decode(canonical({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
    expect(decode(canonical({ z: 1, a: 1, m: 1 }))).toBe('{"a":1,"m":1,"z":1}');
  });

  it("preserves array order", () => {
    expect(decode(canonical([3, 1, 2]))).toBe("[3,1,2]");
  });

  it("produces identical bytes for value-equal objects regardless of key order", () => {
    const a = canonical({ a: 1, b: 2, c: 3 });
    const b = canonical({ c: 3, b: 2, a: 1 });
    expect(decode(a)).toBe(decode(b));
  });

  it("recurses through nested objects sorting at every level", () => {
    const s = decode(canonical({ outer: { z: 1, a: 2 }, prior: [1, { y: 1, x: 2 }] }));
    expect(s).toBe('{"outer":{"a":2,"z":1},"prior":[1,{"x":2,"y":1}]}');
  });

  it("omits undefined fields (matches JSON.stringify)", () => {
    const s = decode(canonical({ a: 1, b: undefined as unknown as null, c: 2 }));
    expect(s).toBe('{"a":1,"c":2}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonical(NaN)).toThrow(/non-finite/);
    expect(() => canonical(Infinity)).toThrow(/non-finite/);
    expect(() => canonical(-Infinity)).toThrow(/non-finite/);
  });

  it("escapes string contents with JSON rules", () => {
    expect(decode(canonical('say "hi"'))).toBe('"say \\"hi\\""');
    expect(decode(canonical("a\nb"))).toBe('"a\\nb"');
  });
});

// ── digestBytes / digestValue ──────────────────────────────────────────────

describe("digest", () => {
  it("returns a 64-char lowercase hex Digest", async () => {
    const d = await digestBytes(new TextEncoder().encode("hello"));
    expect(isDigest(d)).toBe(true);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d.length).toBe(64);
  });

  it("matches the published SHA-256 of 'hello'", async () => {
    const d = await digestBytes(new TextEncoder().encode("hello"));
    expect(d).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("is deterministic", async () => {
    const a = await digestValue({ a: 1, b: [2, 3] });
    const b = await digestValue({ b: [2, 3], a: 1 });
    expect(a).toBe(b);
  });

  it("changes when content changes", async () => {
    const a = await digestValue({ x: 1 });
    const b = await digestValue({ x: 2 });
    expect(a).not.toBe(b);
  });
});

// ── isDigest ──────────────────────────────────────────────────────────────

describe("isDigest", () => {
  it("accepts 64-char lowercase hex", () => {
    expect(isDigest("0".repeat(64))).toBe(true);
    expect(isDigest("a".repeat(64))).toBe(true);
    expect(isDigest("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")).toBe(true);
  });

  it("rejects wrong length, uppercase, or non-hex", () => {
    expect(isDigest("")).toBe(false);
    expect(isDigest("0".repeat(63))).toBe(false);
    expect(isDigest("0".repeat(65))).toBe(false);
    expect(isDigest("A".repeat(64))).toBe(false);                  // uppercase
    expect(isDigest("g".repeat(64))).toBe(false);                  // non-hex char
    expect(isDigest("z".repeat(64))).toBe(false);
  });
});
