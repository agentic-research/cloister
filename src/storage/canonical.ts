/**
 * Canonical bytes + content digest — see ADR-0003 §"Bead canonical form."
 *
 * Two substrates produce the same Digest for the same logical value iff their
 * `canonical(value)` produces identical bytes. The serialization rules:
 *
 *   - JSON, no whitespace
 *   - object keys sorted lexicographically by code-point order
 *   - UTF-8 encoded
 *   - no trailing newline
 *
 * `null` and primitives serialize as JSON. Arrays preserve order. Functions /
 * symbols / undefined are rejected — there is no canonical encoding for them.
 *
 * The digest is SHA-256 over the canonical bytes, hex-encoded lowercase.
 */

import { blake3Hex } from "../wire/cas-hash.js";

import { type Digest, asDigest } from "./types.js";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** Canonical serialization. Throws on non-canonicalizable input. */
export function canonical(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(stringify(value));
}

/** Hash arbitrary bytes; returns a Digest (hex-encoded SHA-256). */
export async function digestBytes(bytes: Uint8Array): Promise<Digest> {
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return asDigest(toHex(new Uint8Array(hashBuf)));
}

/** Convenience: canonicalize then hash. */
export async function digestValue(value: CanonicalValue): Promise<Digest> {
  return digestBytes(canonical(value));
}

/**
 * BLAKE3-256 of arbitrary bytes, hex-encoded lowercase.
 *
 * The build-cache/v1 wire spec reuses the OCI `sha256:` digest prefix,
 * but the bytes inside are BLAKE3 (per Σ §3.4 — LLO substrate is
 * BLAKE3-locked). Cloister-as-build-cache-provider needs to verify
 * uploads against BOTH algorithms: SHA-256 for OCI-native clients
 * (Docker, ORAS, cosign), BLAKE3 for build-cache/v1 clients like
 * `mache cache push --remote`.
 *
 * Implementation: delegates to the LLO `leyline-cas-ffi` crate via
 * the in-tree cloister-cas wasm32 bridge (bead cloister-713b4e).
 * Previously was a TS `@noble/hashes` reimplementation; the substrate
 * guarantee (BLAKE3 lock per Σ §3.4) is now enforced in Rust source
 * rather than pinned by an npm package version.
 */
export function blake3HexBytes(bytes: Uint8Array): string {
  return blake3Hex(bytes);
}

// ── internals ──────────────────────────────────────────────────────────────

function stringify(value: CanonicalValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonical: non-finite number (${value})`);
      }
      // Use Number.prototype.toString — V8 produces the shortest round-trip
      // representation, which is deterministic across V8 instances.
      return String(value);
    case "string": return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return "[" + value.map(stringify).join(",") + "]";
      }
      // Sort keys by code-point order (the default for Array#sort on strings).
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = value[k];
        if (v === undefined) continue; // omit undefined entries (matches JSON.stringify)
        parts.push(JSON.stringify(k) + ":" + stringify(v));
      }
      return "{" + parts.join(",") + "}";
    default:
      throw new TypeError(`canonical: unsupported value of type ${typeof value}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
