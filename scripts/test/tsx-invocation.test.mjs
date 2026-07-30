// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Taskfile command that runs a script which dynamically imports TypeScript
// must invoke it through the TS loader, not bare `node`.
//
// Node 20 — what CI runs — has no TS loader and throws `Unknown file extension
// ".ts"`. Node 25, which this repo's developers are on, strips types natively.
// So a bare-`node` invocation of a script that imports a .ts module works on
// every developer machine and fails on every CI runner. It stays invisible for
// exactly as long as nothing in CI invokes that task.
//
// Both known instances were latent for that reason:
//
//   cluster:emit      broken on Node 20 since it was written. Surfaced only when
//                     cluster:emit:check-drift (cloister-cb735c) became the first
//                     thing in CI to run it — the gate's first act was to expose
//                     a pre-existing bug in what it gates.
//   cluster:dev       same shape, found by sweeping for the pattern rather than
//                     by waiting for it to bite.
//
// This is the third appearance of one lesson in this branch: a green local run
// says nothing about the interpreter or toolchain CI actually has (the others
// being the Node 20 test-runner failure and `image:check` needing melange/apko).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Scripts that dynamically import a .ts module, so they need the loader. */
function scriptsNeedingLoader(taskfile) {
  const named = new Set(
    [...taskfile.matchAll(/scripts\/([\w-]+\.mjs)/g)].map((m) => m[1]),
  );
  const out = [];
  for (const name of named) {
    const p = resolve(ROOT, "scripts", name);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    // A dynamic import whose specifier ends in .ts — the only construct that
    // needs the loader. A static `import ... from "./x.mjs"` does not.
    if (/await import\([^)]*\.ts["'`)]/.test(src) || /\.ts["'`]\)\.href/.test(src)) {
      out.push(name);
    }
  }
  return out.sort();
}

test("every Taskfile command running a TS-importing script uses the TS loader", () => {
  // lint-allow-rawparse: reads Taskfile TEXT because the assertion is about the
  // literal command string an invocation uses, which is what the shell runs.
  const taskfile = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
  const needLoader = scriptsNeedingLoader(taskfile);

  assert.ok(
    needLoader.length > 0,
    "sanity: no TS-importing scripts found — the detector is broken, not the tree",
  );

  const violations = [];
  for (const script of needLoader) {
    // Every command line that invokes this script.
    const re = new RegExp(`^\\s*-?\\s*"?([^\\n"]*scripts/${script.replace(".", "\\.")}[^\\n"]*)`, "gm");
    for (const m of taskfile.matchAll(re)) {
      const cmd = m[1];
      if (/^\s*#/.test(cmd)) continue;            // a comment mentioning it
      if (!/\bnode\b/.test(cmd)) continue;        // `sources:` entries etc.
      if (cmd.includes("{{.NODE_TSX}}") || cmd.includes("--import tsx")) continue;
      violations.push(`${script}: ${cmd.trim()}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `these invoke a TS-importing script with bare node — works on Node 25, throws\n` +
    `\`Unknown file extension ".ts"\` on CI's Node 20:\n` +
    violations.map((v) => `  ${v}`).join("\n") +
    `\nUse {{.NODE_TSX}}.`,
  );
});
