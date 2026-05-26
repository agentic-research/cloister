// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cas-hash.ts — TypeScript wrapper over the in-tree cloister-cas wasm32
// bridge (rs/crates/cas/) which re-exports leyline-cas-ffi's BLAKE3 FFI.
//
// Bead cloister-713b4e. Replaces the prior `@noble/hashes` BLAKE3
// implementation in src/storage/canonical.ts. The substrate guarantee
// (BLAKE3 lock, Σ §3.4) is now enforced by LLO's Rust source instead of
// pinned by a TS dependency that can semver-bump.
//
// Architecture mirrors src/wire/signet-verify.ts:
//
//   - `cloister_cas.wasm` is bundled via wrangler's
//     `[[rules]] type = "CompiledWasm"` rule. Built by
//     `task rs:cas:wasm`; the artifact lives at
//     rs/target/wasm32-unknown-unknown/release/cloister_cas.wasm.
//   - The wasm module is instantiated once per Worker isolate and
//     reused across requests. Linear memory is shared; each call to
//     `blake3Hash` allocs input + output buffers, hashes, copies output
//     back, frees. try/finally guards the free path on throw.
//   - Symbols exported by the wasm: `memory`, `cloister_cas_alloc`,
//     `cloister_cas_free`, `leyline_hash_bytes` (the FFI surface from
//     leyline-cas-ffi, carried through by the bridge crate's `pub use`).

import wasmModule from "../../rs/target/wasm32-unknown-unknown/release/cloister_cas.wasm";

// ── wasm exports — must match rs/crates/cas/src/lib.rs + leyline-cas-ffi ─

interface CasWasmExports {
  /** WebAssembly linear memory the wasm operates on. */
  memory: WebAssembly.Memory;

  /** Allocate `size` bytes in wasm linear memory; returns pointer (offset). */
  cloister_cas_alloc: (size: number) => number;

  /** Free a buffer previously returned by cloister_cas_alloc. Pair every alloc. */
  cloister_cas_free: (ptr: number, size: number) => void;

  /**
   * Compute BLAKE3-256 of `in_ptr..in_ptr+in_len`. Writes 32 bytes to
   * `out_buf`. Returns 32 on success, -1 on error (null ptr, out_len < 32).
   */
  leyline_hash_bytes: (
    in_ptr: number, in_len: number,
    out_buf: number, out_len: number,
  ) => number;
}

// ── Module instance — lazy, memoized ─────────────────────────────────

let _instance: WebAssembly.Instance | null = null;

/**
 * Get the wasm instance, instantiating on first call. Subsequent calls
 * reuse the same instance — workerd guarantees the module is shared
 * across requests within an isolate.
 */
async function instance(): Promise<WebAssembly.Instance> {
  if (_instance) return _instance;
  _instance = await WebAssembly.instantiate(wasmModule);
  return _instance;
}

/** Test-only — drop the cached instance so a re-instantiation happens. */
export function _resetInstance(): void {
  _instance = null;
}

// ── Buffer marshaling helpers ─────────────────────────────────────────

/**
 * Allocate `bytes.length` bytes in wasm memory and copy `bytes` in.
 * Returns the pointer (caller must free via cloister_cas_free).
 */
function copyIn(exports: CasWasmExports, bytes: Uint8Array): number {
  // Empty-slice case: cloister_cas_alloc(0) returns a sentinel non-null
  // pointer from Vec::with_capacity(0), and the bridge crate guards
  // size > 0 on free, so a 0-length call is safe to pass through.
  const ptr = exports.cloister_cas_alloc(bytes.length);
  if (ptr === 0 && bytes.length > 0) {
    throw new CasWasmError("cloister_cas_alloc returned null");
  }
  if (bytes.length > 0) {
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  }
  return ptr;
}

/**
 * Read `length` bytes from wasm memory at `ptr` and return a copy.
 * The slice ensures the result outlives wasm memory grow/free.
 */
function copyOut(exports: CasWasmExports, ptr: number, length: number): Uint8Array {
  return new Uint8Array(exports.memory.buffer, ptr, length).slice();
}

// ── Public API ────────────────────────────────────────────────────────

export class CasWasmError extends Error {
  override readonly name = "CasWasmError";
}

/** BLAKE3 digest length in bytes — substrate fixed at 256 bits per Σ §3.4. */
export const BLAKE3_DIGEST_LEN = 32;

/**
 * Compute BLAKE3-256 of `bytes`. Returns the 32-byte digest as a
 * Uint8Array. Throws on wasm-side failure (allocator OOM or unexpected
 * FFI error code).
 *
 * Substrate guarantee: the algorithm is BLAKE3 per Σ §3.4. The
 * implementation comes from LLO's `leyline-cas-ffi` crate, pinned by
 * SHA in `rs/crates/cas/Cargo.toml` — same hash function every consumer
 * of the substrate sees, byte-for-byte.
 */
export async function blake3Hash(bytes: Uint8Array): Promise<Uint8Array> {
  const inst = await instance();
  const exports = inst.exports as unknown as CasWasmExports;

  const inPtr = copyIn(exports, bytes);
  const outPtr = exports.cloister_cas_alloc(BLAKE3_DIGEST_LEN);
  if (outPtr === 0) {
    exports.cloister_cas_free(inPtr, bytes.length);
    throw new CasWasmError("cloister_cas_alloc returned null for output buffer");
  }

  try {
    const rc = exports.leyline_hash_bytes(
      inPtr, bytes.length,
      outPtr, BLAKE3_DIGEST_LEN,
    );
    if (rc !== BLAKE3_DIGEST_LEN) {
      throw new CasWasmError(`leyline_hash_bytes returned ${rc}, expected ${BLAKE3_DIGEST_LEN}`);
    }
    return copyOut(exports, outPtr, BLAKE3_DIGEST_LEN);
  } finally {
    // Always free; pair every alloc with exactly one free even on throw —
    // wasm leaks persist across requests in a Worker.
    exports.cloister_cas_free(inPtr, bytes.length);
    exports.cloister_cas_free(outPtr, BLAKE3_DIGEST_LEN);
  }
}

/**
 * Convenience: BLAKE3-256 of `bytes`, hex-encoded lowercase. Mirrors the
 * shape of the previous `blake3HexBytes` helper in canonical.ts so the
 * callers (verifyClaimedDigest, BlobStore.put substrate-verify) keep
 * working as drop-in.
 */
export async function blake3Hex(bytes: Uint8Array): Promise<string> {
  const digest = await blake3Hash(bytes);
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}
