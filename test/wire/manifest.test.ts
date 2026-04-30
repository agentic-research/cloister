/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import {
  encodeManifest,
  decodeManifest,
  MANIFEST_ENCODED_BYTES,
  MANIFEST_PUBKEY_BYTES,
  MANIFEST_SIG_BYTES,
  MANIFEST_HASH_BYTES,
  type Manifest,
} from "../../src/wire/manifest.js";

const fixture = (overrides: Partial<Manifest> = {}): Manifest => ({
  sequence:    42n,
  publicKey:   new Uint8Array(MANIFEST_PUBKEY_BYTES).fill(0x11),
  signature:   new Uint8Array(MANIFEST_SIG_BYTES).fill(0x22),
  contentHash: new Uint8Array(MANIFEST_HASH_BYTES).fill(0x33),
  ...overrides,
});

const eq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ── Round-trip ────────────────────────────────────────────────────────────

describe("Manifest wire codec — round-trip", () => {
  it("encode → decode is lossless for the canonical fixture", () => {
    const m = fixture();
    const decoded = decodeManifest(encodeManifest(m));
    expect(decoded.sequence).toBe(m.sequence);
    expect(eq(decoded.publicKey,   m.publicKey)).toBe(true);
    expect(eq(decoded.signature,   m.signature)).toBe(true);
    expect(eq(decoded.contentHash, m.contentHash)).toBe(true);
  });

  it("preserves sequence = 0", () => {
    expect(decodeManifest(encodeManifest(fixture({ sequence: 0n }))).sequence).toBe(0n);
  });

  it("preserves sequence = UInt64 max (2^64 - 1)", () => {
    const max = (1n << 64n) - 1n;
    expect(decodeManifest(encodeManifest(fixture({ sequence: max }))).sequence).toBe(max);
  });

  it("preserves arbitrary byte content (not just fill patterns)", () => {
    const pk  = new Uint8Array(MANIFEST_PUBKEY_BYTES);
    const sig = new Uint8Array(MANIFEST_SIG_BYTES);
    const ch  = new Uint8Array(MANIFEST_HASH_BYTES);
    for (let i = 0; i < pk.length;  i++) pk[i]  = (i * 7  + 13) & 0xFF;
    for (let i = 0; i < sig.length; i++) sig[i] = (i * 17 + 5)  & 0xFF;
    for (let i = 0; i < ch.length;  i++) ch[i]  = (i * 31 + 1)  & 0xFF;
    const m = fixture({ sequence: 1234567890n, publicKey: pk, signature: sig, contentHash: ch });
    const r = decodeManifest(encodeManifest(m));
    expect(eq(r.publicKey,   pk)).toBe(true);
    expect(eq(r.signature,   sig)).toBe(true);
    expect(eq(r.contentHash, ch)).toBe(true);
  });
});

// ── Wire-format invariants ────────────────────────────────────────────────

describe("Manifest wire codec — format", () => {
  it("encoded length is exactly MANIFEST_ENCODED_BYTES (176)", () => {
    expect(encodeManifest(fixture()).length).toBe(MANIFEST_ENCODED_BYTES);
  });

  it("output is 8-byte aligned", () => {
    expect(encodeManifest(fixture()).length % 8).toBe(0);
  });

  it("segment header declares 21 words (single segment, count-1 = 0)", () => {
    const bytes = encodeManifest(fixture());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0);   // count - 1
    expect(dv.getUint32(4, true)).toBe(21);  // seg0 size in words
    // 8 header bytes + 21 * 8 segment bytes = 176
    expect(8 + 21 * 8).toBe(MANIFEST_ENCODED_BYTES);
  });

  it("data section carries the sequence at offset 16 in little-endian", () => {
    const m = fixture({ sequence: 0xDEADBEEFCAFEBABEn });
    const bytes = encodeManifest(m);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // segment(8) + root_ptr(8) = byte 16 is start of data section
    expect(dv.getBigUint64(16, true)).toBe(0xDEADBEEFCAFEBABEn);
  });
});

// ── Encode validation ─────────────────────────────────────────────────────

describe("Manifest wire codec — input validation", () => {
  it("rejects publicKey of wrong length", () => {
    expect(() => encodeManifest(fixture({ publicKey: new Uint8Array(31) }))).toThrow(/publicKey/);
    expect(() => encodeManifest(fixture({ publicKey: new Uint8Array(33) }))).toThrow(/publicKey/);
  });

  it("rejects signature of wrong length", () => {
    expect(() => encodeManifest(fixture({ signature: new Uint8Array(63) }))).toThrow(/signature/);
  });

  it("rejects contentHash of wrong length", () => {
    expect(() => encodeManifest(fixture({ contentHash: new Uint8Array(33) }))).toThrow(/contentHash/);
  });
});

// ── Decode failure modes ─────────────────────────────────────────────────

describe("Manifest wire codec — decode robustness", () => {
  it("rejects messages shorter than segment header", () => {
    expect(() => decodeManifest(new Uint8Array(4))).toThrow(/segment/);
  });

  it("rejects multi-segment messages", () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, 1, true); // count - 1 = 1 (so 2 segments)
    expect(() => decodeManifest(bytes)).toThrow(/single-segment/);
  });

  it("rejects header claiming more bytes than the message contains", () => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(4, 999, true); // claims 999 words = 7992 bytes
    expect(() => decodeManifest(bytes)).toThrow(/segment table claims/);
  });

  it("rejects truncated payload (header valid, struct missing)", () => {
    // Header says 21 words, but actually truncated mid-payload.
    const full = encodeManifest(fixture());
    const truncated = full.slice(0, full.length - 1);
    // Either decoder catches the bounds, or it fails at struct decode; both ok.
    expect(() => decodeManifest(truncated)).toThrow();
  });

  it("rejects struct with too few data/pointer words", () => {
    // Forge a struct pointer claiming 0 data words / 0 pointer words.
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(4, 1, true); // segWords = 1
    // root pointer at byte 8: kind=0, offset=0, dataWords=0, ptrWords=0
    // → all zeros. decoded as too-small struct.
    expect(() => decodeManifest(bytes)).toThrow(/Manifest struct too small/);
  });
});
