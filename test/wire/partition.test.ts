import { describe, it, expect } from "vitest";
import { partitionAddress } from "../../src/wire/partition.js";
import {
  GLOB_CLOSURE_SCHEME,
  GLOB_CLOSURE_DOMAIN_TAG,
  GLOB_CLOSURE_CANON_VERSION,
  encodeGlobClosureParams,
} from "../../src/memoize/glob-closure.js";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

describe("partitionAddress (wasm bridge)", () => {
  const spec = {
    domainTag: GLOB_CLOSURE_DOMAIN_TAG,               // RowSet
    scheme: GLOB_CLOSURE_SCHEME,
    params: encodeGlobClosureParams(["scripts/**/*.mjs"]),
    canonVersion: GLOB_CLOSURE_CANON_VERSION,
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

  // Known-answer vector: every other assertion in this file is relational
  // (equal/not-equal/32-bytes), so a consistent drift in BOTH encoders (or
  // an upstream fold change) would pass silently. This vector was derived
  // independently from upstream's `A(spec, children)` definition at the
  // pinned rev — it is a fixture, not a tautology restating the code.
  it("known-answer vector — fixed inputs yield fixed params + address bytes", () => {
    const knownSpec = {
      domainTag: GLOB_CLOSURE_DOMAIN_TAG,
      canonVersion: GLOB_CLOSURE_CANON_VERSION,
      scheme: GLOB_CLOSURE_SCHEME,
      params: encodeGlobClosureParams(["scripts/**/*.mjs"]),
    };
    const knownEntry = { addr: new Uint8Array(32), a: 0n, b: 1n };

    expect(toHex(knownSpec.params)).toBe(
      "01000000000000001000000000000000736372697074732f2a2a2f2a2e6d6a73",
    );
    expect(toHex(partitionAddress(knownSpec, [knownEntry]))).toBe(
      "a5fca3f2b41703e70c8285f3f08af9b7fb9da69469d1f5197be3f048d147a082",
    );
  });
});
