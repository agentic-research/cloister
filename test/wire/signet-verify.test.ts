/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it } from "vitest";
import {
  SignetWasmError,
  _resetInstance,
  allocWasmBuffer,
  freeWasmBuffer,
  verifyCertChain,
  verifyCmsSignature,
} from "../../src/wire/signet-verify.js";
import {
  CERT_FULL_B64,
  CERT_MINIMAL_B64,
  CERT_WRONG_MASTER_B64,
  EPHEMERAL_PUBKEY_B64,
  MASTER_PUBKEY_B64,
  NOT_AFTER,
  NOT_BEFORE,
} from "./fixtures/cert-chain.js";

/** base64url (no padding) decode — for fixture material. */
function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// These tests verify Phase 2 of cloister-bd5241 (the TS wrapper over
// the wasm32 leyline-sign build). They DON'T do a full sign-then-verify
// round-trip — generating valid CMS signatures from TS would require
// the signing path AND a generated test cert, which is heavier than
// "wrapper works." Round-trip integration lives at the lease-middleware
// layer (cloister-bd7770) where notme-side signing is the real fixture
// source.
//
// What these tests DO confirm:
//   1. The wasm module loads and exposes the expected functions.
//   2. lsign_alloc / lsign_free round-trip a buffer cleanly (the
//      mechanism the verifier uses for marshaling).
//   3. verifyCmsSignature returns ok=false on garbage input (sanity —
//      the wasm doesn't accidentally accept arbitrary bytes).
//   4. Multiple verify calls in sequence don't leak (allocations free
//      across calls).

afterEach(() => _resetInstance());

describe("signet-verify wasm wrapper", () => {
  it("loads the wasm module and exposes lsign_alloc / lsign_free / leyline_verify", async () => {
    // allocWasmBuffer instantiates lazily; if exports are missing this
    // would throw or return undefined.
    const { exports, ptr, length } = await allocWasmBuffer(new Uint8Array([1, 2, 3]));
    try {
      expect(typeof exports.lsign_alloc).toBe("function");
      expect(typeof exports.lsign_free).toBe("function");
      expect(typeof exports.leyline_verify).toBe("function");
      expect(typeof exports.leyline_sign_data).toBe("function");
      expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);
      expect(ptr).toBeGreaterThan(0);
      expect(length).toBe(3);
    } finally {
      freeWasmBuffer(exports, ptr, length);
    }
  });

  it("alloc + copy-in + read-back round-trips bytes exactly", async () => {
    const bytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0xFF]);
    const { exports, ptr, length } = await allocWasmBuffer(bytes);
    try {
      const view = new Uint8Array(exports.memory.buffer, ptr, length);
      // The view aliases wasm memory; copy out before any subsequent
      // alloc/grow could move the backing ArrayBuffer.
      expect(Array.from(view)).toEqual(Array.from(bytes));
    } finally {
      freeWasmBuffer(exports, ptr, length);
    }
  });

  it("alloc handles zero-length buffer (defensive)", async () => {
    // Empty buffers are allowed; alloc returns a valid pointer (or a
    // sentinel that paired free can handle).
    const { exports, ptr, length } = await allocWasmBuffer(new Uint8Array(0));
    try {
      expect(length).toBe(0);
      // Don't assert ptr > 0 — Rust's Vec::with_capacity(0) is
      // implementation-defined; some hosts return a non-null sentinel
      // (NonNull::dangling), some return null. Either is OK as long as
      // the paired free doesn't crash.
    } finally {
      freeWasmBuffer(exports, ptr, length);
    }
  });

  it("verifyCmsSignature rejects garbage input", async () => {
    const result = await verifyCmsSignature(
      new Uint8Array([0x00, 0x01, 0x02, 0x03]),  // not a CMS signature
      new Uint8Array([0xAA]),                    // arbitrary data
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/verify failed/i);
    }
  });

  it("verifyCmsSignature rejects empty input", async () => {
    const result = await verifyCmsSignature(new Uint8Array(0), new Uint8Array(0));
    expect(result.ok).toBe(false);
  });

  it("verifyCmsSignature rejects truncated CMS-shaped input", async () => {
    // A SEQUENCE-tagged DER with a length field but truncated payload.
    // This exercises the parser-error path (rather than signature-
    // mismatch) — both should surface as ok=false.
    const cmsLike = new Uint8Array([
      0x30, 0x82, 0x10, 0x00,  // SEQUENCE + 0x1000 byte length
      0x06, 0x09,              // OID, length 9
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,  // signedData OID
      // ... payload would follow but is truncated here
    ]);
    const result = await verifyCmsSignature(cmsLike, new Uint8Array([0xAA]));
    expect(result.ok).toBe(false);
  });

  it("multiple verify calls in sequence don't leak (allocs paired with frees)", async () => {
    // Run 50 verify calls; if free is missing, wasm linear memory grows
    // unboundedly. We check that memory.buffer.byteLength stays
    // bounded — a leak would push it past initial capacity.
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

    const { exports } = await allocWasmBuffer(new Uint8Array(0));
    const initialMemBytes = exports.memory.buffer.byteLength;

    for (let i = 0; i < 50; i++) {
      const result = await verifyCmsSignature(garbage, garbage);
      expect(result.ok).toBe(false);
    }

    const finalMemBytes = exports.memory.buffer.byteLength;
    // wasm32 grows in 64KB pages; a single one-time page allocation
    // for the wasm runtime's bookkeeping is not a leak. Per-call leaks
    // would be ~4KB × 50 = ~200KB cumulative growth (the out-buffer is
    // 4KB by default + sig + data). Bound at 128KB (2 pages) to allow
    // wasm's natural page-grained allocation while still catching
    // unbounded per-call growth.
    const delta = finalMemBytes - initialMemBytes;
    expect(delta).toBeLessThanOrEqual(128 * 1024);
  });

  it("SignetWasmError is the expected error class", () => {
    const err = new SignetWasmError("test");
    expect(err.name).toBe("SignetWasmError");
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });
});

// ── verifyCertChain (cloister-bd7770 / 9d49eb) ───────────────────────────
//
// Fixtures in test/wire/fixtures/cert-chain.ts are minted by
// rs/crates/sign/examples/gen-fixture.rs from a fixed RNG seed, so the
// same byte sequences are reproducible across runs. Regenerate with
// `task rs:sign:fixtures` if cert_chain.rs's mint helpers change.
//
// What these tests cover:
//   1. Happy path: full cert (all Interlace OIDs) round-trips claims
//      shape + values match the fixture.
//   2. Happy path: minimal cert (no extensions) returns claims with
//      undefined optional fields.
//   3. Wrong-master rejection (cert + mismatched master pubkey).
//   4. Cert minted by a different master against the right master.
//   5. Garbage / truncated / empty cert DER → all rejected.
//   6. Master pubkey wrong length (TS-side guard, never hits wasm).
//   7. Output buffer too small → rejected (parse-or-buffer reason).

describe("verifyCertChain", () => {
  const masterPubkey = b64uDecode(MASTER_PUBKEY_B64);

  it("happy path: full cert with all Interlace extensions returns expected claims", async () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const result = await verifyCertChain(cert, masterPubkey);

    expect(result.ok).toBe(true);
    if (!result.ok) return;  // narrow

    expect(Array.from(result.claims.ephemeralPubkey))
      .toEqual(Array.from(b64uDecode(EPHEMERAL_PUBKEY_B64)));
    expect(result.claims.notBefore).toBe(NOT_BEFORE);
    expect(result.claims.notAfter).toBe(NOT_AFTER);
    expect(result.claims.epoch).toBe(7);
    expect(result.claims.peerFp).toBe("sha256:abc123def456");
    expect(result.claims.scope).toBe("bead_create:/repos/foo");
  });

  it("happy path: minimal cert (no Interlace extensions) returns claims with undefined optionals", async () => {
    const cert = b64uDecode(CERT_MINIMAL_B64);
    const result = await verifyCertChain(cert, masterPubkey);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.from(result.claims.ephemeralPubkey))
      .toEqual(Array.from(b64uDecode(EPHEMERAL_PUBKEY_B64)));
    expect(result.claims.notBefore).toBe(NOT_BEFORE);
    expect(result.claims.notAfter).toBe(NOT_AFTER);
    expect(result.claims.epoch).toBeUndefined();
    expect(result.claims.peerFp).toBeUndefined();
    expect(result.claims.scope).toBeUndefined();
  });

  it("rejects cert when master pubkey doesn't match the issuer", async () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const wrongMaster = new Uint8Array(32).fill(0xAA);
    const result = await verifyCertChain(cert, wrongMaster);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cert chain verify failed/i);
  });

  it("rejects cert minted by a different master against the canonical master", async () => {
    const cert = b64uDecode(CERT_WRONG_MASTER_B64);
    const result = await verifyCertChain(cert, masterPubkey);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cert chain verify failed/i);
  });

  it("rejects garbage cert bytes", async () => {
    const result = await verifyCertChain(
      new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
      masterPubkey,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects truncated cert (valid DER prefix, payload cut off)", async () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const truncated = cert.slice(0, 32);
    const result = await verifyCertChain(truncated, masterPubkey);
    expect(result.ok).toBe(false);
  });

  it("rejects empty cert", async () => {
    const result = await verifyCertChain(new Uint8Array(0), masterPubkey);
    expect(result.ok).toBe(false);
  });

  it("rejects tampered cert (single byte flipped in signature region)", async () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const tampered = new Uint8Array(cert);
    // Flip a byte near the end — that's where the trailing Ed25519
    // signature lives, so this is a clean signature-mismatch path.
    tampered[tampered.length - 5] ^= 0xFF;
    const result = await verifyCertChain(tampered, masterPubkey);
    expect(result.ok).toBe(false);
  });

  it("rejects master pubkey of wrong length (TS-side guard, never reaches wasm)", async () => {
    const tooShort = await verifyCertChain(b64uDecode(CERT_FULL_B64), new Uint8Array(16));
    expect(tooShort.ok).toBe(false);
    if (tooShort.ok) return;
    expect(tooShort.reason).toMatch(/master pubkey must be 32 bytes/i);

    const tooLong = await verifyCertChain(b64uDecode(CERT_FULL_B64), new Uint8Array(64));
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.reason).toMatch(/master pubkey must be 32 bytes/i);
  });

  it("rejects when claims output buffer is too small", async () => {
    // Full cert claims serialize to ~120 bytes of JSON; bound the buffer
    // at 8 bytes so writeOut returns -1 inside the wasm.
    const result = await verifyCertChain(
      b64uDecode(CERT_FULL_B64),
      masterPubkey,
      { claimsOutLen: 8 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/parse, sig, or buffer/i);
  });

  it("multiple cert-chain verifies in sequence don't leak (allocs paired with frees)", async () => {
    const cert = b64uDecode(CERT_FULL_B64);

    const { exports } = await allocWasmBuffer(new Uint8Array(0));
    const initialMemBytes = exports.memory.buffer.byteLength;

    for (let i = 0; i < 25; i++) {
      const result = await verifyCertChain(cert, masterPubkey);
      expect(result.ok).toBe(true);
    }

    const delta = exports.memory.buffer.byteLength - initialMemBytes;
    // Same bound rationale as the verifyCmsSignature leak test above:
    // wasm grows in 64KB pages; 2 pages of slack swallows runtime
    // bookkeeping while still catching unbounded per-call growth.
    expect(delta).toBeLessThanOrEqual(128 * 1024);
  });
});
