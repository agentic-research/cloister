// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One TOML library.
//
// cloister used `@iarna/toml` in 18 places while 0day used `smol-toml` — two
// parsers for one format, and the one cloister was on had not shipped since
// 2023-07-15. Nothing said so, because a second library is invisible until
// somebody reads package.json with the question already in mind.
//
// ── Why this is a package.json check and nothing more ──────────────────────
//
// The first version of this file also scanned every source file for a denylist
// of five library names in both import forms. That was overkill, and the
// argument against it is not just its size: it proved nothing the existing
// gate does not already prove.
//
// The one real miss during the migration was a DYNAMIC import,
// `(await import("@iarna/toml")).default`, invisible to a grep for `from "…"`.
// It was caught anyway — as ERR_MODULE_NOT_FOUND, by the test suite, in one
// cold gate run. A tree scan would have found it a few minutes earlier and
// nothing else, while costing an edit every time a new TOML library exists.
// It also produced a false positive immediately, flagging its own denylist.
//
// What the suite CANNOT see is a second library that is declared and quietly
// used somewhere the tests exercise: everything passes, and the repo has two
// parsers that will disagree the first time they meet a corner of the format.
// That is what this checks, and it is one line of the cost.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const BLESSED = "smol-toml";
const ALTERNATIVES = ["@iarna/toml", "@ltd/j-toml", "toml", "@std/toml"];

test("package.json declares one TOML library, and it is the blessed one", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(declared[BLESSED], `${BLESSED} must be a declared dependency`);
  for (const alt of ALTERNATIVES) {
    assert.ok(
      !declared[alt],
      `${alt} is declared alongside ${BLESSED} — one format, one parser. ` +
      `Two disagree silently, and only one of them gets maintained.`,
    );
  }
});
