// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One TOML library. Not two, and not a stale one.
//
// ── Why this rail exists ───────────────────────────────────────────────────
//
// cloister used `@iarna/toml` in 18 places while 0day used `smol-toml`, so the
// ecosystem had two parsers for one format. The one cloister was on had not
// shipped since 2023-07-15; smol-toml releases regularly. Nothing said so —
// two libraries for one format is invisible until someone reads package.json
// with the question already in mind.
//
// The migration then demonstrated why a one-time sweep is not enough:
//
//     const TOML = (await import("@iarna/toml")).default;
//
// A DYNAMIC import in scripts/harness-targets.mjs, invisible to a grep for
// `from "…"`. It survived the sweep, passed a cached `task lint`, and failed
// only when the pre-push gate ran the suite cold — as ERR_MODULE_NOT_FOUND,
// after the package had already been removed.
//
// So the invariant is checked by name, in any import form, rather than trusted
// to whoever does the next sweep.
//
// Deliberately a denylist of KNOWN ALTERNATIVES plus a package.json check, not
// a parse of every import: the risk is a second library arriving, and it will
// arrive under one of these names or as a new dependency, both of which this
// sees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The one permitted TOML library. Changing this is a deliberate migration. */
const BLESSED = "smol-toml";

/** Other TOML libraries that could plausibly be added by habit or by an agent. */
const ALTERNATIVES = ["@iarna/toml", "@ltd/j-toml", "toml", "toml-j0.4", "@std/toml"];

function sourceFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, acc);
    else if (/\.(mjs|mts|ts|js)$/.test(name)) acc.push(full);
  }
  return acc;
}

test("no source file imports a TOML library other than the blessed one", () => {
  const files = ["scripts", "src", "tools"].flatMap((d) => {
    try { return sourceFiles(resolve(ROOT, d)); } catch { return []; }
  });
  const offenders = [];
  for (const f of files) {
    // This file necessarily NAMES every banned library — in the denylist and
    // in the worked example above — so it matches its own pattern. Skipping
    // exactly one file, itself, rather than loosening the regex: a narrower
    // pattern would be a hole for real code, and this is the one file whose
    // mentions are a specification rather than a use.
    if (f === fileURLToPath(import.meta.url)) continue;
    const text = readFileSync(f, "utf8");
    for (const alt of ALTERNATIVES) {
      // Both forms: static `from "x"` and dynamic `import("x")`. The dynamic
      // one is the case that actually escaped — matching only the static form
      // would reproduce the exact miss this test exists for.
      const re = new RegExp(`(?:from|import\\s*\\()\\s*["']${alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
      if (re.test(text)) offenders.push(`${f.slice(ROOT.length + 1)} → ${alt}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these import a TOML library other than ${BLESSED}:\n` +
    offenders.map((o) => `  ${o}`).join("\n") +
    `\nOne format, one parser — two disagree silently and only one gets maintained.`,
  );
});

test("package.json declares the blessed TOML library and no alternative", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(declared[BLESSED], `${BLESSED} must be a declared dependency`);
  for (const alt of ALTERNATIVES) {
    assert.ok(!declared[alt], `${alt} is declared alongside ${BLESSED} — pick one`);
  }
});
