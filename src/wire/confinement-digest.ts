// SPDX-License-Identifier: AGPL-3.0-or-later
//
// confinement-digest — the TypeScript §7 canonicalizer + confinementDigest for
// cloister/confinement/v1. The runtime (lease-verify) side of what
// rs/crates/cas/{examples,tests}/confinement-digest.rs proves in Rust: a
// ConfinementManifest is §7-canonicalized (ASCII-sorted keys, 2-space indent,
// no trailing newline, null fields omitted) and BLAKE3-256-hashed via cloister's
// substrate hash (cas-hash → leyline-cas-ffi). The result is the `confinementDigest`
// committed to the bundle's lane-2 Interlace identity (§8) and compared at
// lease-verify time (cloister-c80953, property #3).
//
// Conformance: this MUST reproduce LLO's pinned digest for the canonical vector
// (v0.7.x CONFINEMENT_DIGESTS.blake3) — see test/wire/confinement-digest.test.ts.

import { blake3Hex } from "./cas-hash.js";

/**
 * §7 canonical serialization of a ConfinementManifest (or any JSON value) to
 * UTF-8 bytes: object keys ASCII-sorted at every level, 2-space indentation, no
 * trailing newline (last byte `}`), null/undefined fields omitted. Array element
 * order is significant and preserved.
 */
export function canonicalizeConfinement(manifest: unknown): Uint8Array {
  const json = JSON.stringify(sortKeysDeep(manifest), null, 2);
  return new TextEncoder().encode(json);
}

/**
 * confinementDigest (§8): lowercase-hex BLAKE3-256 of the §7-canonical bytes,
 * computed via the substrate hash so it byte-matches LLO's `blake3`-crate digest.
 */
export function confinementDigest(manifest: unknown): string {
  return blake3Hex(canonicalizeConfinement(manifest));
}

/**
 * Recursively rebuild a value with ASCII-sorted object keys (§7 item 2) and
 * null/undefined fields omitted (§7 item 4). Arrays keep their element order; scalars
 * pass through. Object keys are ASCII, so `Array.prototype.sort`'s UTF-16 order
 * equals ASCII byte order.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === null || v === undefined) continue;
      out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}
