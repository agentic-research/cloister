/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Regression properties for `PartitionSpec::address` framing + entry order
// (cloister-944766), asserted through cloister's FFI bridge.
//
// ── What was wrong, and where ────────────────────────────────────────────────
//
// LLO 0.11.3's fold dropped field framing and entry order, so distinct
// partitions could reach the same content address — an ADR-0032 D2 violation.
// LLO v0.15.0 fixes it: the preimage now carries a domain tag, canon_version,
// LENGTH-PREFIXED scheme and params, an entry count, and per-domain
// order-canonicalization.
//
// ── Why cloister tests a fix it did not write ────────────────────────────────
//
// cloister BRIDGES the fold (ADR-0035) rather than reimplementing it, so it
// inherits the fix the moment the wasm is rebuilt against the new pin. "We
// inherit it" is an assumption about a build artifact, though, and an
// assumption is not a check.
//
// WHAT ALREADY EXISTED, so this file does not overclaim: rs/crates/cas/src/lib.rs
// (`address_matches_upstream_fold_for_a_known_spec`) already asserts the
// RowSet framing property in Rust, against glob-closure/v1. That covers the
// crate. It does NOT cover the path a Worker actually takes — TS `encodeSpec` /
// `encodeEntries` marshalling into wasm linear memory — and a bridge that
// dropped `a`/`b` while writing entry records would leave that Rust test green
// and every partition address wrong at runtime. These are the same properties
// asserted one layer out, where cloister's own code is the thing under test.
//
// ── Why these are properties, not a pinned vector ────────────────────────────
//
// LLO publishes no partition vector (there is no schema-spec/partition/), so
// the only fixture available would be cloister's own output — and a fixture
// generated with the implementation under test is a fixed point that ANY
// self-consistent implementation satisfies, including the broken one. That is
// the same trap the receipt-canonical-bytes vector was built to avoid, and it
// bites harder here because the defect being guarded is precisely
// "two different inputs agree".
//
// So each test below states a falsifiable INEQUALITY that the 0.11.3 fold
// violated and the 0.15.0 fold satisfies. They are checks on the substrate
// cloister actually links, not on a number cloister chose.

import { describe, expect, it } from "vitest";
import { partitionAddress, type PartitionEntry } from "../../src/wire/partition";

const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A 32-byte address filled with `n`, so entries are distinguishable by eye. */
const addr = (n: number): Uint8Array => new Uint8Array(32).fill(n);

const entry = (n: number, a = 0n, b = 1n): PartitionEntry => ({ addr: addr(n), a, b });

/** Domain tag 1. The tags the bridge accepts are 1, 2, 3 (see encodeSpec). */
const ORDERED_DOMAIN = 1;

const baseSpec = {
  domainTag: ORDERED_DOMAIN,
  scheme: "cdc-v1",
  params: new Uint8Array([1, 2, 3]),
  canonVersion: 1,
};

describe("the fold is reachable through the bridge at all", () => {
  it("returns a 32-byte address", () => {
    // Guards the rest of this file from passing because every call threw and
    // some future refactor swallowed it: an inequality between two throws is
    // not an inequality anyone should trust.
    const out = partitionAddress(baseSpec, [entry(7)]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
  });
});

describe("field framing — the half that made scheme/params ambiguous", () => {
  it("distinguishes a scheme/params split that concatenates identically", () => {
    // Without length prefixes, ("ab", <c>) and ("a", <bc>) produce the same
    // preimage bytes and therefore one address for two declared partitions.
    // This is the partition-level form of the run-id field-boundary case.
    const left = partitionAddress(
      { ...baseSpec, scheme: "ab", params: new Uint8Array([0x63]) }, [entry(7)]);
    const right = partitionAddress(
      { ...baseSpec, scheme: "a", params: new Uint8Array([0x62, 0x63]) }, [entry(7)]);
    expect(hex(left)).not.toBe(hex(right));
  });

  it("distinguishes an empty params from a one-byte params", () => {
    // An empty field must still contribute its length prefix; dropping empties
    // is the other way framing silently degrades to concatenation.
    const empty = partitionAddress(
      { ...baseSpec, params: new Uint8Array([]) }, [entry(7)]);
    const oneByte = partitionAddress(
      { ...baseSpec, params: new Uint8Array([0]) }, [entry(7)]);
    expect(hex(empty)).not.toBe(hex(oneByte));
  });

  it("commits to canon_version", () => {
    const v1 = partitionAddress({ ...baseSpec, canonVersion: 1 }, [entry(7)]);
    const v2 = partitionAddress({ ...baseSpec, canonVersion: 2 }, [entry(7)]);
    expect(hex(v1)).not.toBe(hex(v2));
  });

  it("commits to the domain tag", () => {
    // Domain separation is what keeps a partition address from colliding with
    // another BLAKE3 preimage in the substrate.
    const d1 = partitionAddress({ ...baseSpec, domainTag: 1 }, [entry(7)]);
    const d3 = partitionAddress({ ...baseSpec, domainTag: 3 }, [entry(7)]);
    expect(hex(d1)).not.toBe(hex(d3));
  });
});

describe("entry framing — the half that made the entry list ambiguous", () => {
  it("commits to entry order in an ordered domain", () => {
    // The named defect: order dropped. Two sequences over the same entries are
    // different partitions and must not share an address.
    const ab = partitionAddress(baseSpec, [entry(1), entry(2)]);
    const ba = partitionAddress(baseSpec, [entry(2), entry(1)]);
    expect(hex(ab)).not.toBe(hex(ba));
  });

  it("commits to the entry count", () => {
    // A repeated entry is not the same partition as a single one — without the
    // count in the preimage, a duplicate can be absorbed.
    const once = partitionAddress(baseSpec, [entry(1)]);
    const twice = partitionAddress(baseSpec, [entry(1), entry(1)]);
    expect(hex(once)).not.toBe(hex(twice));
  });

  it("commits to an entry's a/b framing fields, not just its addr", () => {
    const ab = partitionAddress(baseSpec, [entry(1, 0n, 1n)]);
    const ba = partitionAddress(baseSpec, [entry(1, 1n, 0n)]);
    expect(hex(ab)).not.toBe(hex(ba));
  });

  it("is deterministic for identical input", () => {
    // The inequalities above are only meaningful if equality holds when it
    // should — otherwise they would pass under a random oracle.
    const first = partitionAddress(baseSpec, [entry(1), entry(2)]);
    const second = partitionAddress(baseSpec, [entry(1), entry(2)]);
    expect(hex(first)).toBe(hex(second));
  });
});

// ── Set domains: the property that CHANGED under the pin, not just one that
//    was already true ─────────────────────────────────────────────────────────
//
// Everything above holds identically on v0.11.3 and v0.15.0 — the ordered path
// was never the broken one, which is worth stating plainly because bead
// cloister-944766 reads as though it were.
//
// The set path is different. v0.11.3 sorted by ADDRESS ALONE and deliberately
// dropped each entry's (a, b) framing, on the theory that framing "carries no
// defined meaning" in a set. Downstream schemes do define it — LLO names
// cloister's own `glob-closure/v1` RowSet framing as the casualty — so
// materially different decompositions collided into one address. v0.15.0 sorts
// whole `(addr, a, b)` triples, erasing enumeration order and ONLY enumeration
// order.
//
// So this block pins a genuine before/after: the framing test below FAILS on
// the version cloister was pinned to yesterday. That is what makes it worth
// having, versus the ordered-domain tests which merely document.
describe("set domains commit framing while erasing enumeration order", () => {
  const CHUNK_SET = 2;
  const ROW_SET = 3;

  for (const [label, tag] of [["ChunkSet", CHUNK_SET], ["RowSet", ROW_SET]] as const) {
    it(`${label}: enumeration order does not change the address`, () => {
      // A set has no order, so folding enumeration order in would be a
      // malleability slot — a producer could mint unlimited distinct addresses
      // for one set. This is the half v0.11.3 got right.
      const spec = { ...baseSpec, domainTag: tag };
      const ab = partitionAddress(spec, [entry(1, 5n, 6n), entry(2, 7n, 8n)]);
      const ba = partitionAddress(spec, [entry(2, 7n, 8n), entry(1, 5n, 6n)]);
      expect(hex(ab)).toBe(hex(ba));
    });

    it(`${label}: framing (a, b) DOES change the address`, () => {
      // The b67a73 fix. Same addresses, same enumeration, different framing:
      // two materially different decompositions that v0.11.3 collided into one
      // address and v0.15.0 keeps apart.
      const spec = { ...baseSpec, domainTag: tag };
      const left = partitionAddress(spec, [entry(1, 0n, 4n), entry(2, 4n, 8n)]);
      const right = partitionAddress(spec, [entry(1, 0n, 6n), entry(2, 6n, 8n)]);
      expect(hex(left)).not.toBe(hex(right));
    });
  }

  it("distinguishes a ChunkSet from a RowSet over identical entries", () => {
    // Both are set domains taking the same canonicalization branch, so only the
    // domain tag separates them. If tags stopped being committed, the two set
    // domains — and nothing else in this file — would silently merge.
    const entries = [entry(1, 5n, 6n), entry(2, 7n, 8n)];
    const chunk = partitionAddress({ ...baseSpec, domainTag: CHUNK_SET }, entries);
    const row = partitionAddress({ ...baseSpec, domainTag: ROW_SET }, entries);
    expect(hex(chunk)).not.toBe(hex(row));
  });
});
