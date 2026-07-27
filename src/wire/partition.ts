// SPDX-License-Identifier: AGPL-3.0-or-later
//
// partition.ts — TypeScript wrapper over the in-tree cloister-cas wasm32
// bridge (rs/crates/cas/) exposing leyline-core's PartitionSpec tagged
// fold (ADR-0032 D2, bridged per ADR-0035 — cloister does not
// reimplement the fold).
//
// Bead cloister-bc5640. Mirrors src/wire/cas-hash.ts's structure exactly:
// same lazy module-level instance, the same alloc/free pairing in
// try/finally, and the same CasWasmError-on-failure convention. Do not
// invent a second convention for calling into this wasm module.
//
// Architecture:
//
//   - Same `cloister_cas.wasm` artifact as cas-hash.ts — built by
//     `task rs:cas:wasm`; the artifact lives at
//     rs/target/wasm32-unknown-unknown/release/cloister_cas.wasm.
//   - The wasm module is instantiated synchronously via
//     `new WebAssembly.Instance(module)` (workerd supports this for
//     CompiledWasm imports).
//   - Wire layout for the spec buffer: domain tag (1 byte) ‖
//     canon_version (u32 LE) ‖ scheme_len (u64 LE) ‖ scheme ‖
//     params_len (u64 LE) ‖ params.
//   - Wire layout for the entries buffer: count (u64 LE) ‖
//     (addr[32] ‖ a u64 LE ‖ b u64 LE)…
//   - Symbols exported by the wasm: `memory`, `cloister_cas_alloc`,
//     `cloister_cas_free`, `cloister_partition_address` (the FFI export
//     added by rs/crates/cas/src/lib.rs for this bead).

import wasmModule from "../../rs/target/wasm32-unknown-unknown/release/cloister_cas.wasm";

// ── wasm exports — must match rs/crates/cas/src/lib.rs ───────────────────

interface PartitionWasmExports {
  /** WebAssembly linear memory the wasm operates on. */
  memory: WebAssembly.Memory;

  /** Allocate `size` bytes in wasm linear memory; returns pointer (offset). */
  cloister_cas_alloc: (size: number) => number;

  /** Free a buffer previously returned by cloister_cas_alloc. Pair every alloc. */
  cloister_cas_free: (ptr: number, size: number) => void;

  /**
   * Fold a declared partition into a 32-byte address. Writes 32 bytes to
   * `out_ptr`. Returns 0 on success, non-zero on malformed input — on
   * ANY malformed input this returns non-zero WITHOUT writing to
   * `out_ptr`, so a caller that ignores the code cannot mistake
   * uninitialised memory for an address.
   */
  cloister_partition_address: (
    spec_ptr: number, spec_len: number,
    entries_ptr: number, entries_len: number,
    out_ptr: number,
  ) => number;
}

// ── Module instance — lazy, synchronous ──────────────────────────────
//
// workerd supports synchronous `new WebAssembly.Instance(module)` for
// CompiledWasm imports.

let _instance: WebAssembly.Instance | null = null;

function instance(): WebAssembly.Instance {
  if (!_instance) {
    _instance = new WebAssembly.Instance(wasmModule);
  }
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
function copyIn(exports: PartitionWasmExports, bytes: Uint8Array): number {
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
function copyOut(exports: PartitionWasmExports, ptr: number, length: number): Uint8Array {
  return new Uint8Array(exports.memory.buffer, ptr, length).slice();
}

// ── Public API ────────────────────────────────────────────────────────

export class CasWasmError extends Error {
  override readonly name = "CasWasmError";
}

/** Partition address length in bytes — 256 bits, same as the CAS digest. */
export const PARTITION_ADDRESS_LEN = 32;

/** A single folded entry: an address plus its two framing fields. */
export interface PartitionEntry {
  addr: Uint8Array;
  a: bigint;
  b: bigint;
}

/** The declared partition rule — domain, scheme, params, canon version. */
export interface PartitionSpecInput {
  domainTag: number;
  scheme: string;
  params: Uint8Array;
  canonVersion: number;
}

/**
 * Encode a `PartitionSpecInput` per the wire layout `cloister_partition_address`
 * expects: domain tag (1 byte) ‖ canon_version (u32 LE) ‖ scheme_len (u64 LE)
 * ‖ scheme ‖ params_len (u64 LE) ‖ params.
 */
function encodeSpec(spec: PartitionSpecInput): Uint8Array {
  const enc = new TextEncoder();
  const schemeBytes = enc.encode(spec.scheme);
  const total = 1 + 4 + 8 + schemeBytes.length + 8 + spec.params.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  out[o] = spec.domainTag;
  o += 1;
  view.setUint32(o, spec.canonVersion, true);
  o += 4;
  view.setBigUint64(o, BigInt(schemeBytes.length), true);
  o += 8;
  out.set(schemeBytes, o);
  o += schemeBytes.length;
  view.setBigUint64(o, BigInt(spec.params.length), true);
  o += 8;
  out.set(spec.params, o);
  return out;
}

/**
 * Encode a list of `PartitionEntry` per the wire layout
 * `cloister_partition_address` expects: count (u64 LE) ‖
 * (addr[32] ‖ a u64 LE ‖ b u64 LE)…
 */
function encodeEntries(entries: readonly PartitionEntry[]): Uint8Array {
  const REC = 32 + 8 + 8;
  const out = new Uint8Array(8 + entries.length * REC);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(entries.length), true);
  let o = 8;
  for (const entry of entries) {
    if (entry.addr.length !== 32) {
      throw new CasWasmError(`entry.addr must be 32 bytes, got ${entry.addr.length}`);
    }
    out.set(entry.addr, o);
    view.setBigUint64(o + 32, entry.a, true);
    view.setBigUint64(o + 40, entry.b, true);
    o += REC;
  }
  return out;
}

/**
 * Fold a declared partition into its 32-byte address by calling into
 * leyline-core's `PartitionSpec::address` (ADR-0032 D2) via the wasm
 * bridge. Bridged per ADR-0035 — cloister does not reimplement the fold.
 *
 * Throws `CasWasmError` on wasm-side failure, which per the FFI's
 * contract means the input was malformed (unknown domain tag, truncated
 * buffer, or trailing bytes after a well-formed spec).
 */
export function partitionAddress(
  spec: PartitionSpecInput,
  entries: readonly PartitionEntry[],
): Uint8Array {
  const inst = instance();
  const exports = inst.exports as unknown as PartitionWasmExports;

  const specBytes = encodeSpec(spec);
  const entriesBytes = encodeEntries(entries);

  // Track every allocation as it happens, so ANY throw during the alloc
  // sequence — not just inside the final wasm call — frees everything
  // allocated so far. cas-hash.ts's try/finally is safe with a single
  // buffer live before the output alloc; this function allocates THREE
  // buffers in sequence (spec, entries, out), so a throw from the second
  // copyIn's null-check (or any step in between) must not leak the
  // first. Building the free list as we go, rather than freeing named
  // variables in `finally`, makes "every alloc gets exactly one free"
  // true by construction instead of by enumerating every partial-failure
  // path by hand.
  const allocated: Array<{ ptr: number; len: number }> = [];
  const freeAll = (): void => {
    for (const { ptr, len } of allocated) {
      exports.cloister_cas_free(ptr, len);
    }
  };

  try {
    const specPtr = copyIn(exports, specBytes);
    allocated.push({ ptr: specPtr, len: specBytes.length });

    const entriesPtr = copyIn(exports, entriesBytes);
    allocated.push({ ptr: entriesPtr, len: entriesBytes.length });

    const outPtr = exports.cloister_cas_alloc(PARTITION_ADDRESS_LEN);
    if (outPtr === 0) {
      throw new CasWasmError("cloister_cas_alloc returned null for output buffer");
    }
    allocated.push({ ptr: outPtr, len: PARTITION_ADDRESS_LEN });

    const rc = exports.cloister_partition_address(
      specPtr, specBytes.length,
      entriesPtr, entriesBytes.length,
      outPtr,
    );
    if (rc !== 0) {
      throw new CasWasmError(`cloister_partition_address returned ${rc} (malformed input)`);
    }
    return copyOut(exports, outPtr, PARTITION_ADDRESS_LEN);
  } finally {
    // Always free; pair every alloc with exactly one free even on throw —
    // wasm leaks persist across requests in a Worker.
    freeAll();
  }
}
