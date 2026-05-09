/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it } from "vitest";
import {
  SignetWasmError,
  _resetInstance,
  allocWasmBuffer,
  freeWasmBuffer,
  verifyCmsSignature,
} from "../../src/wire/signet-verify.js";

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
