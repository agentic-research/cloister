// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint-silent-swallow.mjs — cloister-bd7210 Phase 2 rail. No regex
// assertions per operator request.
//
// Run with: node --import tsx --test scripts/test/lint-silent-swallow.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findSilentSwallows, collectSilentSwallows } from "../lint-silent-swallow.mjs";

test("flags a bare catch that silently returns null", () => {
  const text = "  } catch {\n    return null;\n  }";
  const v = findSilentSwallows("src/storage/x.ts", text);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
});

test("flags a `} catch {` on the same line as the try's close brace", () => {
  // Regression: the brace counter must start at the catch's own `{`, not the
  // try's closing `}` (which would otherwise net to zero and miss the body).
  const text = "    try { risky(); }\n    catch {\n      return false;\n    }";
  const v = findSilentSwallows("src/wire/x.ts", text);
  assert.equal(v.length, 1);
});

test("allows a justified silent return (lint-allow-silent)", () => {
  const text = "  } catch {\n    // lint-allow-silent: verify predicate\n    return false;\n  }";
  assert.equal(findSilentSwallows("src/storage/x.ts", text).length, 0);
});

test("allows a catch that surfaces the error (console.warn)", () => {
  const text = "  } catch {\n    console.warn('x');\n    return null;\n  }";
  assert.equal(findSilentSwallows("src/storage/x.ts", text).length, 0);
});

test("ignores a catch with an error binding (not a bare discard)", () => {
  const text = "  } catch (e) {\n    return null;\n  }";
  assert.equal(findSilentSwallows("src/storage/x.ts", text).length, 0);
});

test("ignores a catch that returns a typed error (not a silent default)", () => {
  const text = '  catch { return { kind: "bad_base64" }; }';
  assert.equal(findSilentSwallows("src/routes/x.ts", text).length, 0);
});

test("the shipped trust/IO surface has no unjustified silent-swallows", () => {
  // The live guard: after Phase 2, every bare-catch silent discard on the
  // trust/IO surface is either fixed (fetcher logs) or justified inline.
  assert.deepEqual(collectSilentSwallows(), []);
});
