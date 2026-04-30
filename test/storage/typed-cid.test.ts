/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import {
  CID_HEX_CHARS,
  CONTENT_HASH_BYTES,
  Codec,
  FINGERPRINT_BYTES,
  asInterfaceRef,
  bytesEqual,
  cidEqual,
  decodeCidHex,
  digestTyped,
  encodeCidHex,
  fingerprintOf,
  interfaceRefMatches,
  type PortSignature,
} from "../../src/storage/typed-cid.js";

const sigA: PortSignature = { inputs: ["bytes"], outputs: ["digest"] };
const sigB: PortSignature = { inputs: ["string"], outputs: ["digest"] };
// Same multiset, different order — must NOT have the same fingerprint
// (port order is part of the interface).
const sigC: PortSignature = { inputs: ["digest"], outputs: ["bytes"] };

// ── fingerprintOf ──────────────────────────────────────────────────────────

describe("fingerprintOf", () => {
  it("returns FINGERPRINT_BYTES bytes", async () => {
    const fp = await fingerprintOf(sigA);
    expect(fp.length).toBe(FINGERPRINT_BYTES);
  });

  it("is deterministic", async () => {
    const a = await fingerprintOf(sigA);
    const b = await fingerprintOf(sigA);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it("differs when inputs differ", async () => {
    expect(bytesEqual(await fingerprintOf(sigA), await fingerprintOf(sigB))).toBe(false);
  });

  it("differs when input/output roles are swapped", async () => {
    expect(bytesEqual(await fingerprintOf(sigA), await fingerprintOf(sigC))).toBe(false);
  });
});

// ── digestTyped ────────────────────────────────────────────────────────────

describe("digestTyped", () => {
  it("produces a Cid with codec + 8-byte fp + 32-byte content hash", async () => {
    const cid = await digestTyped({ x: 1 }, Codec.Raw, sigA);
    expect(cid.codec).toBe(Codec.Raw);
    expect(cid.typeFingerprint.length).toBe(FINGERPRINT_BYTES);
    expect(cid.contentHash.length).toBe(CONTENT_HASH_BYTES);
  });

  it("same content + same signature → same Cid", async () => {
    const a = await digestTyped({ x: 1 }, Codec.Raw, sigA);
    const b = await digestTyped({ x: 1 }, Codec.Raw, sigA);
    expect(cidEqual(a, b)).toBe(true);
  });

  it("same content + different signature → same contentHash, different fingerprint", async () => {
    const a = await digestTyped({ x: 1 }, Codec.Raw, sigA);
    const b = await digestTyped({ x: 1 }, Codec.Raw, sigB);
    expect(bytesEqual(a.contentHash, b.contentHash)).toBe(true);
    expect(bytesEqual(a.typeFingerprint, b.typeFingerprint)).toBe(false);
  });

  it("different content + same signature → same fingerprint, different contentHash", async () => {
    const a = await digestTyped({ x: 1 }, Codec.Raw, sigA);
    const b = await digestTyped({ x: 2 }, Codec.Raw, sigA);
    expect(bytesEqual(a.typeFingerprint, b.typeFingerprint)).toBe(true);
    expect(bytesEqual(a.contentHash, b.contentHash)).toBe(false);
  });

  it("different codec → different Cid even for same content + signature", async () => {
    const a = await digestTyped({ x: 1 }, Codec.Raw,           sigA);
    const b = await digestTyped({ x: 1 }, Codec.MtlsInjector,  sigA);
    expect(cidEqual(a, b)).toBe(false);
  });
});

// ── Encoding round-trip ────────────────────────────────────────────────────

describe("encodeCidHex / decodeCidHex", () => {
  it("round-trips a Cid losslessly", async () => {
    const cid = await digestTyped({ x: 1 }, Codec.MtlsInjector, sigA);
    const hex = encodeCidHex(cid);
    expect(hex.length).toBe(CID_HEX_CHARS);
    const decoded = decodeCidHex(hex);
    expect(cidEqual(cid, decoded)).toBe(true);
  });

  it("rejects malformed hex (wrong length)", () => {
    expect(() => decodeCidHex("ab")).toThrow(/length/);
  });
});

// ── InterfaceRef ───────────────────────────────────────────────────────────

describe("asInterfaceRef + interfaceRefMatches", () => {
  it("matches a Cid against its own InterfaceRef", async () => {
    const cid = await digestTyped({ x: 1 }, Codec.HttpHandler, sigA);
    const ref = asInterfaceRef(cid);
    expect(interfaceRefMatches(ref, cid)).toBe(true);
  });

  it("matches a different content Cid with the same codec + fingerprint", async () => {
    const a = await digestTyped({ x: 1 }, Codec.HttpHandler, sigA);
    const b = await digestTyped({ x: 2 }, Codec.HttpHandler, sigA);
    expect(interfaceRefMatches(asInterfaceRef(a), b)).toBe(true);
  });

  it("does NOT match a different codec", async () => {
    const a = await digestTyped({ x: 1 }, Codec.HttpHandler, sigA);
    const b = await digestTyped({ x: 1 }, Codec.MtlsInjector, sigA);
    expect(interfaceRefMatches(asInterfaceRef(a), b)).toBe(false);
  });

  it("does NOT match a different fingerprint", async () => {
    const a = await digestTyped({ x: 1 }, Codec.HttpHandler, sigA);
    const b = await digestTyped({ x: 1 }, Codec.HttpHandler, sigB);
    expect(interfaceRefMatches(asInterfaceRef(a), b)).toBe(false);
  });
});
