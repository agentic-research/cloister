/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it } from "vitest";
import {
  SignetWasmError,
  _parseClaimsJson,
  _resetInstance,
  allocWasmBuffer,
  freeWasmBuffer,
  verifyCertChain,
  verifyCmsSignature,
} from "../../src/wire/signet-verify.js";
import {
  CERT_ADMIN_B64,
  CERT_CRITICAL_UNKNOWN_EXT_B64,
  CERT_FULL_B64,
  CERT_MINIMAL_B64,
  CERT_NONCRITICAL_UNKNOWN_EXT_B64,
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
  it("loads the wasm module and exposes lsign_alloc / lsign_free / leyline_verify", () => {
    // allocWasmBuffer instantiates lazily; if exports are missing this
    // would throw or return undefined.
    const { exports, ptr, length } = allocWasmBuffer(new Uint8Array([1, 2, 3]));
    try {
      expect(typeof exports.lsign_alloc).toBe("function");
      expect(typeof exports.lsign_free).toBe("function");
      expect(typeof exports.leyline_verify).toBe("function");
      // leyline_sign_data is deliberately NOT in the typed interface
      // (cloister-d51165) — see the note in src/wire/signet-verify.ts. The
      // assertion that used to live here checked `typeof … === "function"`,
      // which proves a symbol is exported and NOT that calling it works: a
      // wrong signature, broken pointer contract, or panicking body all pass
      // it. It read as coverage of a signing path nobody had executed.
      expect(exports.memory).toBeInstanceOf(WebAssembly.Memory);
      expect(ptr).toBeGreaterThan(0);
      expect(length).toBe(3);
    } finally {
      freeWasmBuffer(exports, ptr, length);
    }
  });

  it("alloc + copy-in + read-back round-trips bytes exactly", () => {
    const bytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0xFF]);
    const { exports, ptr, length } = allocWasmBuffer(bytes);
    try {
      const view = new Uint8Array(exports.memory.buffer, ptr, length);
      // The view aliases wasm memory; copy out before any subsequent
      // alloc/grow could move the backing ArrayBuffer.
      expect(Array.from(view)).toEqual(Array.from(bytes));
    } finally {
      freeWasmBuffer(exports, ptr, length);
    }
  });

  it("alloc handles zero-length buffer (defensive)", () => {
    // Empty buffers are allowed; alloc returns a valid pointer (or a
    // sentinel that paired free can handle).
    const { exports, ptr, length } = allocWasmBuffer(new Uint8Array(0));
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

  it("verifyCmsSignature rejects garbage input", () => {
    const result = verifyCmsSignature(
      new Uint8Array([0x00, 0x01, 0x02, 0x03]),  // not a CMS signature
      new Uint8Array([0xAA]),                    // arbitrary data
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/verify failed/i);
    }
  });

  it("verifyCmsSignature rejects empty input", () => {
    const result = verifyCmsSignature(new Uint8Array(0), new Uint8Array(0));
    expect(result.ok).toBe(false);
  });

  it("verifyCmsSignature rejects truncated CMS-shaped input", () => {
    // A SEQUENCE-tagged DER with a length field but truncated payload.
    // This exercises the parser-error path (rather than signature-
    // mismatch) — both should surface as ok=false.
    const cmsLike = new Uint8Array([
      0x30, 0x82, 0x10, 0x00,  // SEQUENCE + 0x1000 byte length
      0x06, 0x09,              // OID, length 9
      0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,  // signedData OID
      // ... payload would follow but is truncated here
    ]);
    const result = verifyCmsSignature(cmsLike, new Uint8Array([0xAA]));
    expect(result.ok).toBe(false);
  });

  it("multiple verify calls in sequence don't leak (allocs paired with frees)", () => {
    // Run 50 verify calls; if free is missing, wasm linear memory grows
    // unboundedly. We check that memory.buffer.byteLength stays
    // bounded — a leak would push it past initial capacity.
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

    const { exports } = allocWasmBuffer(new Uint8Array(0));
    const initialMemBytes = exports.memory.buffer.byteLength;

    for (let i = 0; i < 50; i++) {
      const result = verifyCmsSignature(garbage, garbage);
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
// Fixtures in test/wire/fixtures/cert-chain.ts were minted by the
// `gen-fixture` example from a fixed RNG seed, so the same byte
// sequences are reproducible across runs. The generator (and its
// mint helpers) moved to LLO with the leyline-sign consolidation
// (cloister-8f4d3f); regen path is now upstream once LLO ports the
// example.
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

  it("happy path: full cert with all Interlace extensions returns expected claims", () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const result = verifyCertChain(cert, masterPubkey);

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

  it("happy path: admin proof cert carries wildcard scope", () => {
    const cert = b64uDecode(CERT_ADMIN_B64);
    const result = verifyCertChain(cert, masterPubkey);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.claims.epoch).toBe(7);
    expect(result.claims.peerFp).toBe("sha256:abc123def456");
    expect(result.claims.scope).toBe("*");
  });

  it("happy path: minimal cert (no Interlace extensions) returns claims with undefined optionals", () => {
    const cert = b64uDecode(CERT_MINIMAL_B64);
    const result = verifyCertChain(cert, masterPubkey);

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

  it("full cert minted before v0.7.6 carries no confinementDigest (absent stays undefined)", () => {
    // The golden CERT_FULL fixture predates the OID …1.7 extension, so a
    // real verified cert without a `cd` claim must leave confinementDigest
    // undefined — the fail-open-on-optionality half of cloister-c80953.
    const cert = b64uDecode(CERT_FULL_B64);
    const result = verifyCertChain(cert, masterPubkey);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.confinementDigest).toBeUndefined();
  });

  it("rejects cert when master pubkey doesn't match the issuer", () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const wrongMaster = new Uint8Array(32).fill(0xAA);
    const result = verifyCertChain(cert, wrongMaster);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cert chain verify failed/i);
  });

  it("rejects cert minted by a different master against the canonical master", () => {
    const cert = b64uDecode(CERT_WRONG_MASTER_B64);
    const result = verifyCertChain(cert, masterPubkey);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cert chain verify failed/i);
  });

  it("rejects garbage cert bytes", () => {
    const result = verifyCertChain(
      new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
      masterPubkey,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects truncated cert (valid DER prefix, payload cut off)", () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const truncated = cert.slice(0, 32);
    const result = verifyCertChain(truncated, masterPubkey);
    expect(result.ok).toBe(false);
  });

  it("rejects empty cert", () => {
    const result = verifyCertChain(new Uint8Array(0), masterPubkey);
    expect(result.ok).toBe(false);
  });

  it("rejects tampered cert (single byte flipped in signature region)", () => {
    const cert = b64uDecode(CERT_FULL_B64);
    const tampered = new Uint8Array(cert);
    // Flip a byte near the end — that's where the trailing Ed25519
    // signature lives, so this is a clean signature-mismatch path.
    tampered[tampered.length - 5] ^= 0xFF;
    const result = verifyCertChain(tampered, masterPubkey);
    expect(result.ok).toBe(false);
  });

  it("rejects master pubkey of wrong length (TS-side guard, never reaches wasm)", () => {
    const tooShort = verifyCertChain(b64uDecode(CERT_FULL_B64), new Uint8Array(16));
    expect(tooShort.ok).toBe(false);
    if (tooShort.ok) return;
    expect(tooShort.reason).toMatch(/master pubkey must be 32 bytes/i);

    const tooLong = verifyCertChain(b64uDecode(CERT_FULL_B64), new Uint8Array(64));
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.reason).toMatch(/master pubkey must be 32 bytes/i);
  });

  it("rejects when claims output buffer is too small", () => {
    // Full cert claims serialize to ~120 bytes of JSON; bound the buffer
    // at 8 bytes so writeOut returns -1 inside the wasm.
    const result = verifyCertChain(
      b64uDecode(CERT_FULL_B64),
      masterPubkey,
      { claimsOutLen: 8 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/parse, sig, or buffer/i);
  });

  it("rejects cert with critical unknown extension (RFC 5280 §4.2 / cloister-c71977)", () => {
    const cert = b64uDecode(CERT_CRITICAL_UNKNOWN_EXT_B64);
    const result = verifyCertChain(cert, masterPubkey);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cert chain verify failed/i);
  });

  it("accepts cert with non-critical unknown extension (RFC 5280 says MAY ignore)", () => {
    const cert = b64uDecode(CERT_NONCRITICAL_UNKNOWN_EXT_B64);
    const result = verifyCertChain(cert, masterPubkey);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The cert was minted with epoch=7 + peer_fp + scope, same as
    // mint_test_cert_with_extra_ext defaults. Sanity check at least one.
    expect(result.claims.epoch).toBe(7);
  });

  it("multiple cert-chain verifies in sequence don't leak (allocs paired with frees)", () => {
    const cert = b64uDecode(CERT_FULL_B64);

    const { exports } = allocWasmBuffer(new Uint8Array(0));
    const initialMemBytes = exports.memory.buffer.byteLength;

    for (let i = 0; i < 25; i++) {
      const result = verifyCertChain(cert, masterPubkey);
      expect(result.ok).toBe(true);
    }

    const delta = exports.memory.buffer.byteLength - initialMemBytes;
    // Same bound rationale as the verifyCmsSignature leak test above:
    // wasm grows in 64KB pages; 2 pages of slack swallows runtime
    // bookkeeping while still catching unbounded per-call growth.
    expect(delta).toBeLessThanOrEqual(128 * 1024);
  });
});

// ── confinementDigest ("cd") claim parsing (cloister-c80953) ─────────────
//
// The LLO v0.7.6 wasm emits `"cd":"<base64url-nopad>"` (32-byte BLAKE3-256 of
// the §6-canonical ConfinementManifest, OID 1.3.6.1.4.1.99999.1.7). The wasm
// already length-checks the DER OctetString; these unit tests exercise the
// TS-side re-assertion in `_parseClaimsJson` directly, since the golden cert
// fixtures predate the extension (the fixture generator lives upstream in LLO).

/** base64url (no padding) encode — inverse of the fixture `b64uDecode`. */
function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("_parseClaimsJson — cd (confinementDigest) claim", () => {
  // A minimal well-formed claims object the wasm would emit: epk is a valid
  // 32-byte base64url pubkey (reuse the fixture), plus the required nb/na.
  const baseClaims = { epk: EPHEMERAL_PUBKEY_B64, nb: NOT_BEFORE, na: NOT_AFTER };
  const digest32 = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

  it("parses a valid 32-byte cd into confinementDigest", () => {
    const json = JSON.stringify({ ...baseClaims, cd: b64uEncode(digest32) });
    const result = _parseClaimsJson(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.confinementDigest).toBeDefined();
    expect(Array.from(result.claims.confinementDigest!)).toEqual(Array.from(digest32));
  });

  it("leaves confinementDigest undefined when cd is absent", () => {
    const result = _parseClaimsJson(JSON.stringify(baseClaims));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.confinementDigest).toBeUndefined();
  });

  it("hard-rejects a cd whose length is not 32 bytes", () => {
    const digest16 = new Uint8Array(16).fill(0xab);
    const json = JSON.stringify({ ...baseClaims, cd: b64uEncode(digest16) });
    const result = _parseClaimsJson(json);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cd wrong length/i);
  });

  it("rejects a cd that is not valid base64url", () => {
    const json = JSON.stringify({ ...baseClaims, cd: "bad*base64*chars" });
    const result = _parseClaimsJson(json);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cd not valid base64url/i);
  });

  it("hard-rejects a present-but-non-string cd (fail-closed on presence)", () => {
    // A `cd` key that is present but not a string is a malformed claim, not an
    // absent one — reject rather than silently drop the commitment. Absence
    // (no `cd` key) stays legacy-compat, covered above.
    const json = JSON.stringify({ ...baseClaims, cd: 12345 });
    const result = _parseClaimsJson(json);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cd present but not a string/i);
  });
});
