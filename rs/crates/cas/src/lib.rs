// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-cas — wasm32 bridge over leyline-cas-ffi for cloister's
// bundle pipeline (bead cloister-713b4e).
//
// This crate is a thin wrapper around `leyline-cas-ffi` (LLO PR #54):
//
//   - re-exports the substrate's hash FFI so the wasm32 build has the
//     symbol cloister's TS adapter calls (`leyline_hash_bytes`).
//   - adds wasm32 linear-memory management exports (`cloister_cas_alloc`
//     / `cloister_cas_free`) so the TS adapter can pass byte buffers in
//     without overlapping with leyline-sign's `lsign_alloc`/`lsign_free`
//     (the two wasm modules are loaded as separate instances; they
//     don't share linear memory, but giving each its own symbol names
//     keeps the TS-side adapters from accidentally crossing wires if
//     the load model ever changes).
//
// Same convention as `crates/sign/src/ffi.rs`: pointers become 32-bit
// indices into wasm linear memory; outputs are written into a caller-
// allocated buffer; the return value is bytes-written or -1 on error.
//
// LLO is pulled via a git dep pinned to a specific SHA — see Cargo.toml.
// allow-git for the LLO repo is set in `rs/deny.toml` so cargo-deny
// audits permit this single trusted source.

// Re-export the substrate's hash FFI. The `pub use` of an
// `extern "C"` `#[no_mangle]` function carries the symbol through into
// the cdylib emit — wasm32 will export `leyline_hash_bytes` on this
// crate's .wasm just as if we defined it here.
pub use leyline_cas_ffi::ffi::leyline_hash_bytes;

// ── wasm32 linear-memory management ────────────────────────────────────
//
// Mirrors crates/sign/src/ffi.rs::{lsign_alloc, lsign_free}. The wasm32
// callee can't reach wasm-linear-memory directly without these — the
// host (TS) only sees opaque memory exports + the explicit alloc/free
// surface.

/// Allocate `size` bytes in wasm linear memory; return pointer (caller
/// owns and must free via `cloister_cas_free`). Returns null on
/// allocation failure.
///
/// # Safety
/// Caller must pair every `cloister_cas_alloc(n)` with exactly one
/// `cloister_cas_free(ptr, n)`. Failing to free leaks linear memory
/// until the wasm instance is destroyed.
#[unsafe(no_mangle)]
pub extern "C" fn cloister_cas_alloc(size: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a buffer previously allocated by `cloister_cas_alloc`. The
/// `size` must match the original allocation.
///
/// # Safety
/// `ptr` must be a value previously returned by `cloister_cas_alloc`,
/// with the same `size`. Double-free or mismatched-size free is UB.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cloister_cas_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size > 0 {
        unsafe { drop(Vec::from_raw_parts(ptr, 0, size)) };
    }
}

#[cfg(test)]
mod tests {
    //! Native-target sanity: the re-export carries the symbol and the
    //! alloc/free pair round-trips. The full FFI behavior is tested
    //! upstream in leyline-cas-ffi; we only need to confirm the bridge
    //! preserves it.
    use super::*;

    #[test]
    fn alloc_free_roundtrip() {
        let ptr = cloister_cas_alloc(64);
        assert!(!ptr.is_null());
        unsafe { cloister_cas_free(ptr, 64) };
    }

    #[test]
    fn alloc_zero_size_is_safe() {
        // Vec::with_capacity(0) returns a sentinel non-null ptr in stable
        // Rust; alloc returning that is fine — free of (ptr, 0) is a
        // no-op per the size > 0 guard.
        let ptr = cloister_cas_alloc(0);
        unsafe { cloister_cas_free(ptr, 0) };
    }

    #[test]
    fn hash_via_re_export_matches_blake3() {
        // Sanity: the re-exported `leyline_hash_bytes` is reachable +
        // produces BLAKE3 of the input. Full edge coverage lives in
        // leyline-cas-ffi's own test suite.
        let input = b"bridge-check";
        let mut out = [0u8; 32];
        let rc = unsafe {
            leyline_hash_bytes(input.as_ptr(), input.len(), out.as_mut_ptr(), out.len())
        };
        assert_eq!(rc, 32);
        let expected = blake3::hash(input);
        assert_eq!(&out[..], expected.as_bytes());
    }
}
