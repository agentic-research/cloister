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

describe("cas-hash — alloc/free pairing soundness", () => {
  it("K sequential hashes produce distinct correct digests (pairing stress)", () => {
    const K = 256;
    const enc = new TextEncoder();
    const digests = new Map<string, number>();

    for (let i = 0; i < K; i++) {
      const hex = blake3Hex(enc.encode(`pairing-stress-${i}`));
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      digests.set(hex, (digests.get(hex) ?? 0) + 1);
    }

    // Every input is unique, so every digest must be unique. A pairing
    // bug that reuses or corrupts a buffer would produce duplicates or
    // wrong-length output.
    expect(digests.size).toBe(K);
  });

  it("varying input sizes don't corrupt adjacent buffers", () => {
    const enc = new TextEncoder();
    const sizes = [0, 1, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 1024, 4096];
    const results: string[] = [];

    for (const size of sizes) {
      const input = new Uint8Array(size);
      for (let j = 0; j < size; j++) input[j] = j & 0xff;
      results.push(blake3Hex(input));
    }

    // Re-hash the same inputs — must be identical. A buffer-overlap
    // bug would cause non-determinism.
    for (let i = 0; i < sizes.length; i++) {
      const input = new Uint8Array(sizes[i]);
      for (let j = 0; j < sizes[i]; j++) input[j] = j & 0xff;
      expect(blake3Hex(input)).toBe(results[i]);
    }
  });

  it("interleaved small and large inputs stay correct", () => {
    const enc = new TextEncoder();
    const small = enc.encode("a");
    const large = new Uint8Array(8192).fill(0x42);

    const smallHex = blake3Hex(small);
    const largeHex = blake3Hex(large);

    // Interleave: small → large → small → large. If free(ptr, size)
    // is mismatched, linear memory corruption would surface here.
    for (let i = 0; i < 50; i++) {
      expect(blake3Hex(small)).toBe(smallHex);
      expect(blake3Hex(large)).toBe(largeHex);
    }
  });
});
