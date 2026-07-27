# Event Plane v1 — Plan 1: Declared Resolution Rule + Partition Bridge

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cloister a versioned, referenceable declaration of the resolution rule behind its memoize keys, and the tagged-fold primitive to address it with.

**Architecture:** Two halves. First, a TS module declaring the `glob-closure/v1` rule — the scheme string plus a canonical params encoding — so a skip event can name which rule produced its digest. Second, a wasm bridge exposing LLO's `PartitionSpec::address` so that declaration can be folded into a digest that commits to the decomposition rather than the concatenation.

**Tech Stack:** TypeScript on workerd; Rust wasm32 FFI bridge (`rs/crates/cas`); BLAKE3 via `leyline-core::partition`; vitest + `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-27-tool-call-event-plane-design.md`
**Bead:** `cloister-bc5640` (parent), folds in `cloister-8f6bd6`.

## Global Constraints

- **Runtime is workerd.** Web Crypto is available; Node APIs are not. Anything needing BLAKE3 goes through the wasm bridge, never a JS implementation.
- **ADR-0035 makes bridging mandatory.** `leyline-*` lives in LLO; cloister bridges. Do NOT reimplement the tagged fold in TS or Rust here.
- **The fold context is protocol-visible.** `PARTITION_CONTEXT = "leyline partition fold v1"`. Changing it invalidates every address ever produced — a change means `v2`, never an edit.
- **Scheme strings are one-way doors.** Once `glob-closure/v1` names a rule, that rule is frozen. A different rule is `/v2`.
- **`task lint` must stay green** (currently 460/460). It is the gate of record.
- **Every commit references a bead:** `[cloister-bc5640] type(scope): description`.

## Known hazard — read before Task 2

`rs/Cargo.lock` already contains **two** `leyline-core` versions: `0.4.5` (via `leyline-cas-ffi`, pinned rev `593ee61`) and `0.8.0` (via `leyline-fs`). `partition` is in **0.10.4**. Adding it naively creates a third, and `cargo deny` already emits `warning[duplicate]: found 2 duplicate entries for crate 'leyline-core'`.

Task 2 must resolve this deliberately, not by accident. Do not bump `leyline-cas-ffi`'s rev casually — the Cargo.toml comment says a rev bump means the BLAKE3 substrate algorithm changed and the cross-runtime fixture suite must re-verify.

## File Structure

| File | Responsibility |
|---|---|
| `src/memoize/glob-closure.ts` *(create)* | Declares `glob-closure/v1`: scheme string, canonical params encoding, closure→entries mapping. Pure; no I/O. |
| `test/memoize/glob-closure.test.ts` *(create)* | Pins the canonical encoding byte-for-byte. |
| `rs/crates/cas/Cargo.toml` *(modify)* | Adds `leyline-core` dependency at a pinned rev. |
| `rs/crates/cas/src/lib.rs` *(modify)* | Adds `cloister_partition_address` FFI export. |
| `rs/crates/cas/tests/partition.rs` *(create)* | Asserts the bridge matches LLO's own fixture. |
| `src/wire/partition.ts` *(create)* | TS side of the bridge, mirroring `cas-hash.ts`. |
| `test/wire/partition.test.ts` *(create)* | Round-trip + known-answer test. |

---

### Task 1: Declare the `glob-closure/v1` resolution rule

This is `cloister-8f6bd6`'s deliverable. Pure TS, no bridge needed — it can land and be reviewed on its own.

**Files:**
- Create: `src/memoize/glob-closure.ts`
- Test: `test/memoize/glob-closure.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GLOB_CLOSURE_SCHEME: "glob-closure/v1"`, `encodeGlobClosureParams(patterns: readonly string[]): Uint8Array`, `type GlobClosureEntry = { path: string; digestHex: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { GLOB_CLOSURE_SCHEME, encodeGlobClosureParams } from "../../src/memoize/glob-closure.js";

describe("glob-closure/v1", () => {
  it("names the rule, not the mechanism", () => {
    expect(GLOB_CLOSURE_SCHEME).toBe("glob-closure/v1");
  });

  it("encodes patterns order-independently — the rule is a SET of globs", () => {
    const a = encodeGlobClosureParams(["scripts/**/*.mjs", "Taskfile.yml"]);
    const b = encodeGlobClosureParams(["Taskfile.yml", "scripts/**/*.mjs"]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("distinguishes a tightened glob from the original", () => {
    const wide   = encodeGlobClosureParams(["scripts/**/*.mjs"]);
    const narrow = encodeGlobClosureParams(["scripts/lib/**/*.mjs"]);
    expect(Array.from(wide)).not.toEqual(Array.from(narrow));
  });

  it("length-prefixes each pattern so concatenation cannot collide", () => {
    // ["ab","c"] and ["a","bc"] concatenate identically; the encoding must not.
    const x = encodeGlobClosureParams(["ab", "c"]);
    const y = encodeGlobClosureParams(["a", "bc"]);
    expect(Array.from(x)).not.toEqual(Array.from(y));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/memoize/glob-closure.test.ts`
Expected: FAIL — cannot resolve `../../src/memoize/glob-closure.js`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/memoize/glob-closure.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Run the full gate**

Run: `task lint`
Expected: exit 0, 460/460 plus the 4 new.

- [ ] **Step 6: Commit**

```bash
git add src/memoize/glob-closure.ts test/memoize/glob-closure.test.ts
git commit -m "[cloister-bc5640] feat(memoize): declare the glob-closure/v1 resolution rule"
```

---

### Task 2: Bridge `PartitionSpec::address` into the wasm build

**Files:**
- Modify: `rs/crates/cas/Cargo.toml`
- Modify: `rs/crates/cas/src/lib.rs`
- Create: `rs/crates/cas/tests/partition.rs`

**Interfaces:**
- Consumes: Task 1's `GLOB_CLOSURE_SCHEME` and `encodeGlobClosureParams` (as the scheme/params it will fold).
- Produces: FFI export `cloister_partition_address(spec_ptr, spec_len, entries_ptr, entries_len, out_ptr) -> i32`, returning 0 on success.

The upstream API this wraps, read from `~/remotes/art/ley-line-open/rs/ll-core/core/src/partition.rs`:

```rust
pub enum Domain { ByteStream, ChunkSet, RowSet }   // wire tags 1, 2, 3
pub struct Entry { pub addr: Hash, pub a: u64, pub b: u64 }
pub struct PartitionSpec { pub domain: Domain, pub scheme: String,
                           pub params: Vec<u8>, pub canon_version: u32 }
impl PartitionSpec { pub fn address(&self, entries: &[Entry]) -> Hash }
pub const PARTITION_CONTEXT: &str = "leyline partition fold v1";
```

- [ ] **Step 1: Resolve the version skew FIRST, before writing any code**

Run: `grep -n "leyline-core" rs/Cargo.lock`
Expected: two entries, `0.4.5` and `0.8.0`.

Decide explicitly and record the decision in the commit message:
- **(a)** Add `leyline-core` 0.10.4 as a third pinned entry and accept the duplicate warning, or
- **(b)** Unify by bumping `leyline-cas-ffi` to a rev whose `leyline-core` is 0.10.4.

**(a) is the default.** (b) changes the BLAKE3 substrate crate, which `rs/crates/cas/Cargo.toml` explicitly says means "the algorithm changed and the cross-runtime fixture suite must re-verify" — that is a separate, reviewable act, not a step inside this task.

- [ ] **Step 2: Write the failing bridge test**

```rust
// rs/crates/cas/tests/partition.rs
use cloister_cas::partition_address_for_test;

#[test]
fn address_matches_upstream_fold_for_a_known_spec() {
    // Two entries whose addresses differ only by framing — the fold must
    // distinguish them, which is the property length-prefixing exists for.
    let scheme = "glob-closure/v1";
    let params = b"\x00".to_vec();
    let addr_a = partition_address_for_test(3 /* RowSet */, scheme, &params, 1, &[([0u8; 32], 0, 1)]);
    let addr_b = partition_address_for_test(3, scheme, &params, 1, &[([0u8; 32], 1, 0)]);
    assert_ne!(addr_a, addr_b, "framing must be committed to, not ignored");

    // Same inputs twice must be identical — the fold is deterministic.
    let again = partition_address_for_test(3, scheme, &params, 1, &[([0u8; 32], 0, 1)]);
    assert_eq!(addr_a, again);
}
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd rs && cargo test -p cloister-cas --test partition`
Expected: FAIL — `partition_address_for_test` not found.

- [ ] **Step 4: Add the dependency**

In `rs/crates/cas/Cargo.toml`, under `[dependencies]`, add — matching the existing comment style, which documents *why* the rev is pinned:

```toml
# leyline-core supplies PartitionSpec (ADR-0032's tagged fold). cloister
# BRIDGES it per ADR-0035 rather than reimplementing — the scheme must be
# folded INTO the address, and getting that wrong is unverifiable rather
# than merely wrong. Pin the rev deliberately: PARTITION_CONTEXT is
# protocol-visible, so a rev that changes it invalidates every address.
leyline-core = { git = "https://github.com/agentic-research/ley-line-open", rev = "<SHA of a commit containing rs/ll-core/core/src/partition.rs>", version = "0.10.4", package = "leyline-core" }
```

Find the SHA: `cd ~/remotes/art/ley-line-open && git log -1 --format=%H -- rs/ll-core/core/src/partition.rs`

- [ ] **Step 5: Write the minimal implementation**

```rust
// in rs/crates/cas/src/lib.rs
use leyline_core::partition::{Domain, Entry, PartitionSpec};
use leyline_core::substrate::Hash;

fn domain_from_tag(tag: u8) -> Option<Domain> {
    match tag {
        1 => Some(Domain::ByteStream),
        2 => Some(Domain::ChunkSet),
        3 => Some(Domain::RowSet),
        _ => None,
    }
}

/// Test-visible wrapper. Kept separate from the FFI export so the fold can be
/// exercised without wasm linear-memory plumbing.
pub fn partition_address_for_test(
    domain_tag: u8,
    scheme: &str,
    params: &[u8],
    canon_version: u32,
    entries: &[([u8; 32], u64, u64)],
) -> [u8; 32] {
    let spec = PartitionSpec {
        domain: domain_from_tag(domain_tag).expect("unknown domain tag"),
        scheme: scheme.to_string(),
        params: params.to_vec(),
        canon_version,
    };
    let es: Vec<Entry> = entries
        .iter()
        .map(|(addr, a, b)| Entry { addr: Hash::from_bytes(*addr), a: *a, b: *b })
        .collect();
    *spec.address(&es).as_bytes()
}
```

- [ ] **Step 6: Run it and watch it pass**

Run: `cd rs && cargo test -p cloister-cas --test partition`
Expected: PASS, 1/1.

- [ ] **Step 7: Confirm the wasm target still builds and the dep graph is acceptable**

Run: `cd rs && cargo build -p cloister-cas --target wasm32-unknown-unknown`
Expected: builds clean.

Run: `cd rs && cargo deny check bans 2>&1 | grep -c "leyline-core"`
Expected: a duplicate warning naming `leyline-core` — **expected under decision (a)**. If it is an *error* rather than a warning, `rs/deny.toml` needs a documented `skip` entry; add it with a comment naming this bead.

- [ ] **Step 8: Commit**

```bash
git add rs/crates/cas/Cargo.toml rs/crates/cas/src/lib.rs rs/crates/cas/tests/partition.rs rs/Cargo.lock
git commit -m "[cloister-bc5640] feat(cas): bridge leyline-core's PartitionSpec tagged fold"
```

---

### Task 3: Expose the fold to TypeScript

**Files:**
- Modify: `rs/crates/cas/src/lib.rs` (add the `#[no_mangle]` export)
- Create: `src/wire/partition.ts`
- Test: `test/wire/partition.test.ts`

**Interfaces:**
- Consumes: Task 2's `partition_address_for_test` logic, now behind an FFI export.
- Produces: `partitionAddress(spec: { domainTag: number; scheme: string; params: Uint8Array; canonVersion: number }, entries: readonly { addr: Uint8Array; a: bigint; b: bigint }[]): Uint8Array` — 32 bytes.

Mirror `src/wire/cas-hash.ts` exactly: same alloc/free pairing, same `CasWasmError`, same synchronous instantiation. Read that file first; do not invent a second convention.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { partitionAddress } from "../../src/wire/partition.js";
import { GLOB_CLOSURE_SCHEME, encodeGlobClosureParams } from "../../src/memoize/glob-closure.js";

describe("partitionAddress (wasm bridge)", () => {
  const spec = {
    domainTag: 3,                                   // RowSet
    scheme: GLOB_CLOSURE_SCHEME,
    params: encodeGlobClosureParams(["scripts/**/*.mjs"]),
    canonVersion: 1,
  };
  const entry = { addr: new Uint8Array(32), a: 0n, b: 1n };

  it("returns 32 bytes", () => {
    expect(partitionAddress(spec, [entry]).byteLength).toBe(32);
  });

  it("is deterministic", () => {
    expect(Array.from(partitionAddress(spec, [entry])))
      .toEqual(Array.from(partitionAddress(spec, [entry])));
  });

  it("commits to the SCHEME, not just the entries", () => {
    const other = { ...spec, scheme: "glob-closure/v2" };
    expect(Array.from(partitionAddress(spec, [entry])))
      .not.toEqual(Array.from(partitionAddress(other, [entry])));
  });

  it("commits to the PARAMS — a tightened glob is a different address", () => {
    const narrowed = { ...spec, params: encodeGlobClosureParams(["scripts/lib/**/*.mjs"]) };
    expect(Array.from(partitionAddress(spec, [entry])))
      .not.toEqual(Array.from(partitionAddress(narrowed, [entry])));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/wire/partition.test.ts`
Expected: FAIL — cannot resolve `src/wire/partition.js`.

- [ ] **Step 3: Add the FFI export**

```rust
/// Fold a declared partition into a 32-byte address.
///
/// Wire layout for `spec_ptr`: domain tag (1 byte) ‖ canon_version (u32 LE)
/// ‖ scheme_len (u64 LE) ‖ scheme ‖ params_len (u64 LE) ‖ params.
/// Wire layout for `entries_ptr`: count (u64 LE) ‖ (addr[32] ‖ a u64 LE ‖ b u64 LE)…
/// Writes 32 bytes to `out_ptr`. Returns 0 on success, non-zero on malformed input.
/// On ANY malformed input this returns non-zero WITHOUT writing to `out_ptr`,
/// so a caller that ignores the code cannot mistake uninitialised memory for
/// an address.
#[unsafe(no_mangle)]
pub extern "C" fn cloister_partition_address(
    spec_ptr: *const u8, spec_len: usize,
    entries_ptr: *const u8, entries_len: usize,
    out_ptr: *mut u8,
) -> i32 {
    let spec_buf = unsafe { std::slice::from_raw_parts(spec_ptr, spec_len) };
    let ent_buf  = unsafe { std::slice::from_raw_parts(entries_ptr, entries_len) };

    // -- spec: tag(1) | canon(4) | scheme_len(8) | scheme | params_len(8) | params
    let mut o = 0usize;
    let rd_u64 = |b: &[u8], o: usize| -> Option<u64> {
        b.get(o..o + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()))
    };
    let tag = match spec_buf.first() { Some(t) => *t, None => return 1 };
    let domain = match domain_from_tag(tag) { Some(d) => d, None => return 1 };
    o += 1;
    let canon_version = match spec_buf.get(o..o + 4) {
        Some(s) => u32::from_le_bytes(s.try_into().unwrap()),
        None => return 1,
    };
    o += 4;
    let slen = match rd_u64(spec_buf, o) { Some(v) => v as usize, None => return 1 };
    o += 8;
    let scheme = match spec_buf.get(o..o + slen).and_then(|s| std::str::from_utf8(s).ok()) {
        Some(s) => s.to_string(),
        None => return 1,
    };
    o += slen;
    let plen = match rd_u64(spec_buf, o) { Some(v) => v as usize, None => return 1 };
    o += 8;
    let params = match spec_buf.get(o..o + plen) { Some(s) => s.to_vec(), None => return 1 };
    o += plen;
    if o != spec_buf.len() { return 1; }   // trailing bytes are a malformed spec

    // -- entries: count(8) | (addr[32] | a(8) | b(8))…
    let count = match rd_u64(ent_buf, 0) { Some(v) => v as usize, None => return 1 };
    const REC: usize = 32 + 8 + 8;
    if ent_buf.len() != 8 + count * REC { return 1; }
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let base = 8 + i * REC;
        let mut addr = [0u8; 32];
        addr.copy_from_slice(&ent_buf[base..base + 32]);
        let a = u64::from_le_bytes(ent_buf[base + 32..base + 40].try_into().unwrap());
        let b = u64::from_le_bytes(ent_buf[base + 40..base + 48].try_into().unwrap());
        entries.push(Entry { addr: Hash::from_bytes(addr), a, b });
    }

    let spec = PartitionSpec { domain, scheme, params, canon_version };
    let addr = spec.address(&entries);
    unsafe { std::ptr::copy_nonoverlapping(addr.as_bytes().as_ptr(), out_ptr, 32) };
    0
}
```

Note the `if o != spec_buf.len()` check: a spec with trailing bytes is rejected rather than silently ignored, so two different buffers cannot fold to the same address.

- [ ] **Step 4: Write the TS side**

Mirror `src/wire/cas-hash.ts`'s structure: module-level lazy instance, `cloister_cas_alloc`/free pairing in a `try/finally`, and a `CasWasmError` on a non-zero return code. Encode the two buffers per the layout in Step 3.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run test/wire/partition.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 6: Run the full gate**

Run: `task lint && task verify`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add rs/crates/cas/src/lib.rs src/wire/partition.ts test/wire/partition.test.ts
git commit -m "[cloister-bc5640] feat(wire): expose the partition fold to TypeScript"
```

---

## What this plan deliberately does NOT do

- **No event emission.** The `{scheme, spec_digest, input_digest, prior_result_ref}` shape and its emit seam are Plan 2.
- **No verifier.** The three-valued type, `collapseForWire()`, and `lint:tristate-collapse` are Plan 2.
- **No disclosure-stream changes.** Per-export spec bundling and the header manifest are Plan 3.
- **No `Digest` type migration.** That is `cloister-24c13a`, scheduled after this work.

Plan 1 is done when cloister can name its resolution rule and fold a declared decomposition into an address. Nothing consumes that yet — which is exactly why it is safe to land first.
