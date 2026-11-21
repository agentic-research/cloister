// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every "was this module started as a script" decision goes through
// cli/lib/started-as-script.mjs. A module that compares `process.argv[1]`
// with its own path is correct on its own, and wrong the moment it is
// bundled: every module in a bundle shares the bundle's path, so each one
// would run its main. The plan checker is shipped as a bundle
// (gen/bundle.mjs), and the first build of it did exactly that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startedAsScript } from "../lib/started-as-script.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = "cli/lib/started-as-script.mjs";

test("no module in cli/ decides for itself whether it was started as a script", () => {
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "--", "cli/*.mjs"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith("cli/test/") && f !== HELPER);
  assert.ok(files.length > 50, "cli/ was read");
  const offenders = files.filter((f) => /process\.argv\[1\]/.test(readFileSync(resolve(ROOT, f), "utf8")));
  assert.deepEqual(offenders, [], `compare process.argv[1] through startedAsScript(import.meta.url) instead (${HELPER})`);

  const callers = files.filter((f) => readFileSync(resolve(ROOT, f), "utf8").includes("startedAsScript(import.meta.url)"));
  assert.ok(callers.length >= 10, "the modules that are also scripts use the helper");
});

test("startedAsScript is true for the module node was started with, and false otherwise", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(startedAsScript(import.meta.url, self), true);
  assert.equal(startedAsScript(import.meta.url, resolve(ROOT, "cli/index.mjs")), false);
  // An empty argv[1] is a node started with no script (a REPL, `-e`).
  assert.equal(startedAsScript(import.meta.url, ""), false);
  assert.equal(startedAsScript(pathToFileURL(self).href, self), true);
});

test("a bundle turns it off for every module", () => {
  const self = fileURLToPath(import.meta.url);
  globalThis.__CLOISTER_BUNDLE__ = true;
  try {
    assert.equal(startedAsScript(import.meta.url, self), false);
  } finally {
    delete globalThis.__CLOISTER_BUNDLE__;
  }
  assert.equal(startedAsScript(import.meta.url, self), true);
});
