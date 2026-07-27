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
