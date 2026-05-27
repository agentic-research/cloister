// SPDX-License-Identifier: AGPL-3.0-or-later
//
// signet-verify.ts — TypeScript wrapper over the in-tree leyline-sign
// wasm32 build. Provides a clean async API for verifying CMS/PKCS#7
// signatures from inside cloister's lease middleware.
//
// Phase 2 of cloister-bd5241. Phase 1 (rs/crates/sign/ with wasm32 build
// pipeline + lsign_alloc/lsign_free exports) shipped at f587254.
//
// ## Architecture
//
// The wasm module is bundled into the Worker via the
// `[[rules]] type = "CompiledWasm"` rule in wrangler.toml. At Worker
// boot we instantiate it once; every request uses the same instance.
// Linear memory is shared across requests — verifiers must alloc + free
// per call to avoid leaking. The wrapper functions handle this for the
// caller via try/finally.
//
// ## Threat model boundary
//
// Verification is offline (no network). The Worker must hold the master
// public key from somewhere before this layer runs — typically a pinned
// env binding or a fetched-and-cached CA bundle (per cloister-e195ea).
// This wrapper ONLY verifies the cryptographic signature and returns the
// embedded cert; epoch checks, scope checks, and TTL checks are the
// caller's responsibility (the lease middleware in cloister-bd7770).
//
// ## Calling convention with wasm
//
// The wasm crate exposes a flat C-FFI: pointers are 32-bit indices into
// linear memory; outputs are written into a caller-allocated buffer; the
// return value is bytes-written or -1 on error. We allocate input and
// output buffers via lsign_alloc, copy bytes via Uint8Array views over
// the wasm memory, call the function, copy outputs back, free.

import wasmModule from "../../rs/target/wasm32-unknown-unknown/release/leyline_sign.wasm";

// ── wasm exports — must match rs/crates/sign/src/ffi.rs ──────────────

interface SignetWasmExports {
  /** WebAssembly linear memory the wasm operates on. */
  memory: WebAssembly.Memory;

  /** Allocate `size` bytes in wasm linear memory; returns pointer (offset). */
  lsign_alloc: (size: number) => number;

  /** Free a buffer previously returned by lsign_alloc. Must pair every alloc. */
  lsign_free: (ptr: number, size: number) => void;

  /**
   * Sign data with CMS/PKCS#7 + Ed25519 + signed attributes.
   * Returns bytes written to out_buf, or -1 on error / buffer too small.
   * Not used by the verifier path; kept here for symmetry with FFI.
   */
  leyline_sign_data: (
    data_ptr: number, data_len: number,
    cert_der_ptr: number, cert_der_len: number,
    private_key_ptr: number,
    out_buf: number, out_len: number,
  ) => number;

  /**
   * Verify a CMS/PKCS#7 signature against the original data. On success,
   * writes the embedded certificate DER into `cert_out_buf` and returns
   * its byte length. Returns -1 on any verification failure.
   */
  leyline_verify: (
    cms_sig_ptr: number, cms_sig_len: number,
    data_ptr: number, data_len: number,
    cert_out_buf: number, cert_out_len: number,
  ) => number;

  /**
   * Verify cert-chain (Ed25519 cert signed by master_pubkey) and write
   * parsed claims as compact JSON into `claims_out_buf`. Returns claims
   * byte length on success, -1 on any failure.
   *
   * JSON shape (see rs/crates/sign/src/cert_chain.rs::claims_to_json):
   *   {"epk":"<base64url>","nb":<i64>,"na":<i64>,"ep":<u32>,"pf":"...","sc":"..."}
   * `ep`, `pf`, `sc` are optional (omitted when cert lacks the matching
   * Interlace extension).
   */
  leyline_verify_cert_chain: (
    cert_der_ptr: number, cert_der_len: number,
    master_pubkey_ptr: number, master_pubkey_len: number,
    claims_out_buf: number, claims_out_len: number,
  ) => number;
}

// ── Module instance — lazy, memoized ─────────────────────────────────

let _pending: Promise<WebAssembly.Instance> | null = null;

/**
 * Get the wasm instance, instantiating on first call. Memoizes the
 * in-flight Promise so concurrent first calls share one instantiation
 * rather than racing through the await.
 */
async function instance(): Promise<WebAssembly.Instance> {
  if (!_pending) {
    _pending = WebAssembly.instantiate(wasmModule);
  }
  return _pending;
}

/** Test-only — drop the cached instance so a re-instantiation happens. */
export function _resetInstance(): void {
  _pending = null;
}

// ── Buffer marshaling helpers ─────────────────────────────────────────

/**
 * Allocate `bytes.length` bytes in wasm memory and copy `bytes` in.
 * Returns the pointer (caller must free via `lsign_free(ptr, length)`).
 */
function copyIn(exports: SignetWasmExports, bytes: Uint8Array): number {
  const ptr = exports.lsign_alloc(bytes.length);
  if (ptr === 0) throw new SignetWasmError("alloc returned null");
  // Important: take the view AFTER alloc, since growth could move the
  // backing ArrayBuffer. (For small allocations within Worker memory
  // this is rare, but the pattern is the safe default.)
  new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

/**
 * Read `length` bytes from wasm memory at `ptr` and return a copy that
 * outlives the wasm instance's memory lifecycle.
 */
function copyOut(exports: SignetWasmExports, ptr: number, length: number): Uint8Array {
  // .slice() copies — without it, the returned view aliases wasm memory
  // and becomes invalid after the next alloc/grow.
  return new Uint8Array(exports.memory.buffer, ptr, length).slice();
}

// ── Public API ────────────────────────────────────────────────────────

export class SignetWasmError extends Error {
  override readonly name = "SignetWasmError";
}

/** Result of `verifyCmsSignature`. */
export type VerifyResult =
  | { ok: true; certDer: Uint8Array }
  | { ok: false; reason: string };

/** Default output buffer size for the embedded cert. ~4KB is generous
 * for an Ed25519 cert with our extension set; oversized to avoid -1
 * errors on non-pathological certs. */
const DEFAULT_CERT_OUT_LEN = 4096;

/**
 * Verify a detached CMS/PKCS#7 signature against the original data.
 *
 * Returns the embedded certificate DER on success (so the caller can
 * walk into scope/epoch/TTL checks). Returns `{ ok: false, reason }` on
 * any verification failure — same return shape; callers branch on `ok`.
 *
 * **Does not** check epoch, scope, or TTL. Those are caller-side concerns
 * (cloister-e195ea for epoch, cloister-bd7770 for scope + TTL +
 * caller-binding).
 */
export async function verifyCmsSignature(
  cmsSig: Uint8Array,
  data: Uint8Array,
  options: { certOutLen?: number } = {},
): Promise<VerifyResult> {
  const inst = await instance();
  const exports = inst.exports as unknown as SignetWasmExports;
  const certOutLen = options.certOutLen ?? DEFAULT_CERT_OUT_LEN;

  const sigPtr = copyIn(exports, cmsSig);
  const dataPtr = copyIn(exports, data);
  const certOutPtr = exports.lsign_alloc(certOutLen);

  try {
    const result = exports.leyline_verify(
      sigPtr, cmsSig.length,
      dataPtr, data.length,
      certOutPtr, certOutLen,
    );

    if (result < 0) {
      // -1 from leyline_verify covers: signature mismatch, malformed CMS,
      // cert/key mismatch, or output buffer too small. We don't get
      // structured error info from the FFI; surface a generic reason.
      return { ok: false, reason: "verify failed (signature, parse, or output-buffer-overflow)" };
    }

    const certDer = copyOut(exports, certOutPtr, result);
    return { ok: true, certDer };
  } finally {
    // Always free; pair every alloc with exactly one free, even on
    // throw — wasm leaks are persistent across requests in a Worker.
    exports.lsign_free(sigPtr, cmsSig.length);
    exports.lsign_free(dataPtr, data.length);
    exports.lsign_free(certOutPtr, certOutLen);
  }
}

/**
 * Allocate a buffer in wasm memory, copy bytes in, return the pointer
 * for direct use against the wasm exports. Useful for tests and for
 * future verifier paths that don't fit the high-level API above.
 *
 * The caller MUST pair this with `freeWasmBuffer(ptr, length)` — a
 * leaked alloc persists for the isolate's lifetime.
 */
export async function allocWasmBuffer(bytes: Uint8Array): Promise<{
  ptr: number;
  length: number;
  exports: SignetWasmExports;
}> {
  const inst = await instance();
  const exports = inst.exports as unknown as SignetWasmExports;
  const ptr = copyIn(exports, bytes);
  return { ptr, length: bytes.length, exports };
}

/** Counterpart to `allocWasmBuffer`. */
export function freeWasmBuffer(
  exports: SignetWasmExports,
  ptr: number,
  length: number,
): void {
  exports.lsign_free(ptr, length);
}

// ── Cert-chain verification + claims parsing ────────────────────────────

/**
 * Parsed claims extracted from a verified ephemeral cert. Mirrors the
 * Rust `CertClaims` struct in `rs/crates/sign/src/cert_chain.rs`.
 *
 * `ephemeralPubkey` is the SubjectPublicKeyInfo's raw bytes (32 bytes for
 * Ed25519). `notBefore` / `notAfter` are Unix-seconds. The Interlace-
 * specific fields (`epoch`, `peerFp`, `scope`) are optional — present
 * only when the cert was minted with the matching custom-OID extension.
 */
export interface CertClaims {
  ephemeralPubkey: Uint8Array;
  notBefore:       number;
  notAfter:        number;
  epoch?:          number;
  peerFp?:         string;
  scope?:          string;
}

export type CertChainResult =
  | { ok: true;  claims: CertClaims }
  | { ok: false; reason: string };

/** Output buffer size for the JSON claims blob; ~512B is generous. */
const DEFAULT_CLAIMS_OUT_LEN = 1024;

/**
 * Verify an ephemeral Signet cert is signed by the master public key,
 * and extract its claims (ephemeral pubkey, validity window, optional
 * Interlace extensions).
 *
 * On success: returns `{ ok: true, claims }` with parsed values.
 * On any failure: `{ ok: false, reason }` — same shape as
 * `verifyCmsSignature`. Callers branch on `ok`.
 *
 * The wasm module returns claims as compact JSON; we parse it once
 * into the typed `CertClaims` shape. Callers shouldn't need to touch
 * the JSON form directly.
 */
export async function verifyCertChain(
  certDer: Uint8Array,
  masterPubkey: Uint8Array,
  options: { claimsOutLen?: number } = {},
): Promise<CertChainResult> {
  if (masterPubkey.length !== 32) {
    return { ok: false, reason: "master pubkey must be 32 bytes (Ed25519)" };
  }

  const inst = await instance();
  const exports = inst.exports as unknown as SignetWasmExports;
  const claimsOutLen = options.claimsOutLen ?? DEFAULT_CLAIMS_OUT_LEN;

  const certPtr = copyIn(exports, certDer);
  const masterPtr = copyIn(exports, masterPubkey);
  const claimsOutPtr = exports.lsign_alloc(claimsOutLen);

  try {
    const result = exports.leyline_verify_cert_chain(
      certPtr, certDer.length,
      masterPtr, masterPubkey.length,
      claimsOutPtr, claimsOutLen,
    );

    if (result < 0) {
      // -1 covers: bad DER, wrong sig algorithm, signature mismatch,
      // bad SPKI, malformed Interlace extension, or output buffer too
      // small. The wasm doesn't return structured error info; surface
      // a generic reason. Callers that want to log details can match
      // on the verdict at the Rust side via tests.
      return { ok: false, reason: "cert chain verify failed (parse, sig, or buffer)" };
    }

    const jsonBytes = new Uint8Array(exports.memory.buffer, claimsOutPtr, result).slice();
    const json = new TextDecoder().decode(jsonBytes);
    return parseClaimsJson(json);
  } finally {
    exports.lsign_free(certPtr, certDer.length);
    exports.lsign_free(masterPtr, masterPubkey.length);
    exports.lsign_free(claimsOutPtr, claimsOutLen);
  }
}

/**
 * Parse the wasm's compact claims JSON into a typed `CertClaims`.
 * Defensive — bad JSON or missing required fields return
 * `{ ok: false, reason }`.
 */
function parseClaimsJson(json: string): CertChainResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "claims JSON parse failed" };
  }

  const epkRaw = parsed["epk"];
  const nbRaw  = parsed["nb"];
  const naRaw  = parsed["na"];

  if (typeof epkRaw !== "string") return { ok: false, reason: "claims missing epk" };
  if (typeof nbRaw  !== "number") return { ok: false, reason: "claims missing nb" };
  if (typeof naRaw  !== "number") return { ok: false, reason: "claims missing na" };

  let ephemeralPubkey: Uint8Array;
  try {
    ephemeralPubkey = b64decode(epkRaw);
  } catch {
    return { ok: false, reason: "claims epk not valid base64url" };
  }
  if (ephemeralPubkey.length !== 32) {
    return { ok: false, reason: "claims epk wrong length (expected 32 bytes Ed25519)" };
  }

  const claims: CertClaims = {
    ephemeralPubkey,
    notBefore: nbRaw,
    notAfter:  naRaw,
  };

  // Optional Interlace fields.
  if (typeof parsed["ep"] === "number") claims.epoch  = parsed["ep"] as number;
  if (typeof parsed["pf"] === "string") claims.peerFp = parsed["pf"] as string;
  if (typeof parsed["sc"] === "string") claims.scope  = parsed["sc"] as string;

  return { ok: true, claims };
}

// ── base64url helpers (no padding) ──────────────────────────────────────

/** base64url decode (no padding) — matches the wasm's epk encoding. */
function b64decode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/")
    + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
