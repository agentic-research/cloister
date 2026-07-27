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
//
// ## What v1 commits to — and what it does NOT
//
// COMMITS TO: the sorted, deduped, length-prefixed glob pattern set; the
// domain tag; the canon version; the entry addresses and their order.
//
// DOES NOT COMMIT TO: the base directory the globs resolve against (Task
// `includes:` can set `dir:`, so identical pattern text resolves differently
// per Taskfile); the globbing implementation's `**` and dotfile semantics;
// `exclude:` entries; symlink following; filesystem case sensitivity (macOS
// vs Linux CI resolve the same pattern differently); and file paths (two
// closures with identical digests in identical order but different
// filenames share an address).
//
// CONSEQUENCE, stated explicitly: v1 is NOT sufficient for cross-machine
// re-derivation. An auditor on a different OS or base directory can compute
// a different file set under the same address. Folding a resolver-identity
// field into params is the fix, and it is deliberately deferred — v1 must
// not be relied on for third-party verification until that lands.

/** Scheme identifier for the fold. Protocol-visible; changing it means v2. */
export const GLOB_CLOSURE_SCHEME = "glob-closure/v1";

/**
 * Domain tag for the `PartitionSpec` this scheme folds under — RowSet (3): a
 * closure member is a logical record (a file), not a chunk of a larger byte
 * stream. Shared with `PartitionSpecInput.domainTag` so callers never
 * hand-inline the magic number.
 */
export const GLOB_CLOSURE_DOMAIN_TAG = 3;

/** Canon version for this scheme's wire encoding. */
export const GLOB_CLOSURE_CANON_VERSION = 1;

/** One resolved member of the closure. */
export type GlobClosureEntry = { path: string; digestHex: string };

/**
 * Lexicographic comparison over raw bytes (unsigned), matching how a Rust or
 * Go verifier would sort `&[u8]`. NOT the same order as `Array.prototype.sort()`
 * on the original strings, which compares UTF-16 code units — those two
 * orders diverge for characters outside the BMP vs. full-width BMP
 * characters (e.g. "Ｚ" U+FF3A vs "𐀀" U+10000).
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Canonical encoding of the rule's parameters — the glob patterns themselves.
 *
 * Encoded to UTF-8 bytes FIRST, then sorted BY BYTE SEQUENCE — not by
 * `Array.prototype.sort()` on the strings, which sorts by UTF-16 code unit
 * and can disagree with a byte-sorting Rust/Go verifier for non-BMP input.
 * This is a cross-runtime canonical encoding, so it must agree with
 * whatever re-derives it outside this runtime.
 *
 * Deduped after sorting, because the rule is a SET of globs, not a
 * multiset: `["a","a"]` and `["a"]` are the same rule and must produce the
 * same address. Declaring the same patterns in a different Taskfile order
 * (or repeating one) is the same rule.
 *
 * Length-prefixed, because concatenation is ambiguous: ["ab","c"] and
 * ["a","bc"] share a concatenation but are different rules. This mirrors
 * leyline-core::partition, which length-prefixes every variable-length field
 * so the address commits to the decomposition rather than to the join.
 */
export function encodeGlobClosureParams(patterns: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const byteForms = patterns.map((p) => enc.encode(p));
  byteForms.sort(compareBytes);

  const deduped: Uint8Array[] = [];
  for (const b of byteForms) {
    const last = deduped[deduped.length - 1];
    if (last === undefined || !bytesEqual(last, b)) {
      deduped.push(b);
    }
  }

  const parts: Uint8Array[] = [];
  const count = new Uint8Array(8);
  new DataView(count.buffer).setBigUint64(0, BigInt(deduped.length), true);
  parts.push(count);
  for (const bytes of deduped) {
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
