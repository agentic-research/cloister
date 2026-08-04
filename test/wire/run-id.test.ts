/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Cross-implementation conformance for `cloister/execution/v1` run-identity
// derivation (cloister-c1bd9e), against LLO's vendored `run-id.json`.
//
// ── Why this test carries the contract, not the source file ──────────────────
//
// src/wire/run-id.ts has to hard-code the domain separator, prefix and hash
// name: a runtime derivation cannot read its own constants out of a test
// fixture. That is exactly the restatement `lint:schema-claim` forbids, and the
// exemption is only safe if something checks the restatement. This is that
// something — every constant below is read FROM the vector and compared, so an
// upstream re-scoping of the domain fails cloister's own suite instead of
// silently producing confident, wrong names.
//
// ── Why preimage and digest are asserted separately ──────────────────────────
//
// LLO pins `preimageHex` per case as well as `runId`. Comparing only the digest
// collapses two distinct defects — wrong field framing and wrong hash — into
// one indistinguishable failure. Checking the preimage first means a failure
// says which half broke.
//
// ── The two cases that are the whole point ───────────────────────────────────
//
// `field-boundary-ab-c` and `field-boundary-a-bc` differ only in where the
// boundary between grantId and replayKey falls. Under a bare concatenation
// their preimages are byte-identical and two distinct runs collapse to one
// identity. An implementation that drops the length prefixes still passes the
// canonical case; it fails only here. They get their own assertion below so
// that intent survives a future edit.

import { describe, expect, it } from "vitest";
import vector from "../fixtures/llo-execution-v1/test-vectors/run-id.json";
import {
  RUN_ID_DOMAIN,
  RUN_ID_HASH,
  RUN_ID_PREFIX,
  buildRunIdPreimage,
  deriveRunId,
} from "../../src/wire/run-id";

const bytesToHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("the vendored run-id vector", () => {
  it("is the execution/v1 vector this suite claims to drive", () => {
    // Guards against passing vacuously: every per-case assertion below is a
    // no-op over an empty array, and a vendored fixture is exactly the kind of
    // file that gets moved or truncated.
    expect(vector.version).toBe("cloister/execution/v1");
    expect(vector.cases.length).toBeGreaterThanOrEqual(3);
  });

  it("agrees with the constants src/wire/run-id.ts restates", () => {
    // The restatement exemption is discharged here — see the file header.
    expect(RUN_ID_DOMAIN).toBe(vector.derivation.domain);
    expect(RUN_ID_PREFIX).toBe(vector.derivation.prefix);
    expect(RUN_ID_HASH).toBe(vector.derivation.hash);
  });
});

describe("run-id derivation reproduces LLO's pinned cases", () => {
  for (const c of vector.cases) {
    it(`${c.name} builds the pinned preimage`, () => {
      const preimage = buildRunIdPreimage(c);
      // Hex rather than byte arrays so a failure prints the diverging sequence
      // instead of "Uint8Array(89) !== Uint8Array(89)".
      expect(bytesToHex(preimage)).toBe(c.preimageHex);
    });

    it(`${c.name} derives the pinned run id`, () => {
      expect(deriveRunId(c)).toBe(c.runId);
    });
  }
});

describe("the field-boundary ambiguity the length prefixes exist to close", () => {
  const ab = vector.cases.find((c) => c.name === "field-boundary-ab-c");
  const a = vector.cases.find((c) => c.name === "field-boundary-a-bc");

  it("pins both halves of the ambiguous pair", () => {
    // Named lookups, so dropping a case from the vector fails loudly rather
    // than quietly reducing this describe block to nothing.
    expect(ab).toBeDefined();
    expect(a).toBeDefined();
  });

  it("gives two distinct identities to inputs a bare concat would merge", () => {
    // ("ab","c") and ("a","bc") concatenate to the same bytes. If these two ever
    // agree, the framing has been lost — regardless of what the digest is.
    expect(deriveRunId(ab!)).not.toBe(deriveRunId(a!));
    expect(bytesToHex(buildRunIdPreimage(ab!)))
      .not.toBe(bytesToHex(buildRunIdPreimage(a!)));
  });

  it("differs only in the length prefixes, not the payload bytes", () => {
    // Both preimages carry the same concatenated payload; the ONLY thing
    // telling them apart is the u64le framing. Asserting that directly is what
    // makes this a test of the framing rather than a test of BLAKE3.
    const strip = (c: { grantId: string; replayKey: string }) => c.grantId + c.replayKey;
    expect(strip(ab!)).toBe(strip(a!));
    expect(buildRunIdPreimage(ab!).length).toBe(buildRunIdPreimage(a!).length);
  });
});

describe("preimage framing properties", () => {
  const base = vector.cases[0];

  it("length-prefixes by UTF-8 byte length, not JS string length", () => {
    // "é" is one JS char and two UTF-8 bytes. A `.length` prefix declares 1
    // where the payload is 2 — a defect no ASCII case can catch, and every case
    // in the vector is ASCII.
    //
    // This MUST read the prefix VALUE. An earlier version asserted the total
    // preimage length instead and mutation-testing showed it survived exactly
    // this bug: swapping `bytes.length` for `field.length` changes what the
    // prefix DECLARES while still appending the same UTF-8 payload, so the
    // total never moves. A framing test that never decodes the framing is
    // measuring the payload.
    const preimage = buildRunIdPreimage({ ...base, grantId: "é", replayKey: "" });
    const domainLen = new TextEncoder().encode(RUN_ID_DOMAIN).length;
    const digestLen = new TextEncoder().encode(base.canonicalSpecDigest).length;

    // domain || 0x00 || u64(digest) || digest || u64(grantId) || ...
    const grantIdPrefixAt = domainLen + 1 + 8 + digestLen;
    const view = new DataView(
      preimage.buffer, preimage.byteOffset, preimage.byteLength);
    expect(view.getBigUint64(grantIdPrefixAt, true)).toBe(2n);

    // And the digest's own prefix, to pin that the offset above is real rather
    // than a coincidence that happens to land on a 2.
    expect(view.getBigUint64(domainLen + 1, true)).toBe(BigInt(digestLen));
  });

  it("starts with the domain separator followed by a NUL", () => {
    const preimage = buildRunIdPreimage(base);
    const domain = new TextEncoder().encode(RUN_ID_DOMAIN);
    expect(bytesToHex(preimage.slice(0, domain.length))).toBe(bytesToHex(domain));
    expect(preimage[domain.length]).toBe(0x00);
  });

  it("distinguishes an empty field from an absent one", () => {
    // An empty replayKey still contributes its 8-byte zero length prefix, so it
    // cannot alias a shorter preimage. Dropping empties is the other way the
    // framing silently degrades to a concatenation.
    const withEmpty = buildRunIdPreimage({ ...base, replayKey: "" });
    const withValue = buildRunIdPreimage({ ...base, replayKey: "x" });
    expect(withEmpty.length).toBe(withValue.length - 1);
    expect(deriveRunId({ ...base, replayKey: "" }))
      .not.toBe(deriveRunId({ ...base, replayKey: "x" }));
  });
});
