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
