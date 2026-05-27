/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import {
  BLAKE3_DIGEST_LEN,
  blake3Hash,
  blake3Hex,
} from "../../src/wire/cas-hash.js";

describe("cas-hash — synchronous BLAKE3 via wasm32", () => {
  it("blake3Hash returns Uint8Array, not Promise", () => {
    const result = blake3Hash(new Uint8Array([1, 2, 3]));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.length).toBe(BLAKE3_DIGEST_LEN);
  });

  it("blake3Hex returns string, not Promise", () => {
    const result = blake3Hex(new Uint8Array([1, 2, 3]));
    expect(typeof result).toBe("string");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.length).toBe(64);
  });

  it("empty input hashes without error", () => {
    const hex = blake3Hex(new Uint8Array(0));
    expect(hex.length).toBe(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deterministic — same input same output", () => {
    const input = new TextEncoder().encode("substrate-lock-check");
    expect(blake3Hex(input)).toBe(blake3Hex(input));
  });

  it("different inputs produce different digests", () => {
    const a = blake3Hex(new TextEncoder().encode("a"));
    const b = blake3Hex(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});
