// SPDX-License-Identifier: AGPL-3.0-or-later
//
// glob-closure/v1 — the resolution rule behind cloister's memoize keys
// (cloister-8f6bd6, folded into cloister-bc5640).
//
// Task memoizes via `method: checksum` over declared `sources:` globs. That is
// a content-derived key, so it is a genuine memoize. But the RULE that turns
// glob patterns into the file set being hashed is implicit — recorded only in
// a Taskfile comment, where nothing can act on it.
//
// Tighten one glob and every previously-computed key silently changes meaning.
// Under per-skip attestation that is worse than a cache-invalidation bug: an
// auditor re-deriving a key has no way to know WHICH rule to re-derive it
// under, so the attestation is unverifiable rather than merely stale.
//
// Naming the rule here makes it referenceable from a skip event's `scheme`.
// The string is a ONE-WAY DOOR: a different rule is `/v2`, never an edit.

/** Scheme identifier for the fold. Protocol-visible; changing it means v2. */
export const GLOB_CLOSURE_SCHEME = "glob-closure/v1";

/** One resolved member of the closure. */
export type GlobClosureEntry = { path: string; digestHex: string };

/**
 * Canonical encoding of the rule's parameters — the glob patterns themselves.
 *
 * Sorted, because the rule is a SET of globs: declaring the same patterns in a
 * different Taskfile order is the same rule and must produce the same address.
 *
 * Length-prefixed, because concatenation is ambiguous: ["ab","c"] and
 * ["a","bc"] share a concatenation but are different rules. This mirrors
 * leyline-core::partition, which length-prefixes every variable-length field
 * so the address commits to the decomposition rather than to the join.
 */
export function encodeGlobClosureParams(patterns: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const sorted = [...patterns].sort();
  const parts: Uint8Array[] = [];
  const count = new Uint8Array(8);
  new DataView(count.buffer).setBigUint64(0, BigInt(sorted.length), true);
  parts.push(count);
  for (const p of sorted) {
    const bytes = enc.encode(p);
    const len = new Uint8Array(8);
    new DataView(len.buffer).setBigUint64(0, BigInt(bytes.length), true);
    parts.push(len, bytes);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}
