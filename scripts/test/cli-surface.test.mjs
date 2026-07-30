// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CLI surface declaration is the single source for `cloister --help` AND
// docs/reference/cli.md. These assert the properties that make that true — and
// that the declaration describes the CLI that actually exists.
//
// Why this file exists: `cloister run` shipped while printHelp hardcoded the
// command list and docs/reference/ had no CLI page at all. The verb was
// documented nowhere. A declaration only fixes that if something checks it
// still matches reality.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, renderHelp } from "../cli-surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("every declared command is actually dispatched by the CLI", () => {
  // The direction that matters most: a command documented but not routed is a
  // promise the tool does not keep.
  // lint-allow-rawparse: matches the literal dispatch conditions, which is what
  // "does this string reach a handler" actually means.
  const src = readFileSync(resolve(ROOT, "scripts/cloister-cli.mjs"), "utf8");
  const undispatched = COMMANDS.filter((c) => {
    const [head, ...rest] = c.name.split(" ");
    if (!src.includes(`command === "${head}"`)) return true;
    return rest.some((seg) => !src.includes(`"${seg}"`));
  }).map((c) => c.name);
  assert.deepEqual(undispatched, [], `declared but not dispatched: ${undispatched}`);
});

test("`run` is declared, and names --repo as required", () => {
  // Non-vacuity plus the specific regression: this is the verb whose absence
  // from the docs prompted the declaration.
  const run = COMMANDS.find((c) => c.name === "run");
  assert.ok(run, "the run verb must be declared");
  const repo = run.flags?.find((f) => f.flag === "--repo");
  assert.ok(repo?.required, "--repo is the security boundary and must be marked required");
  assert.match(repo.summary, /absolute/i, "must say why a relative path is refused");
});

test("the rendered help lists every declared command", () => {
  const help = renderHelp();
  const missing = COMMANDS.filter((c) => !help.includes(`cloister ${c.name} `)).map((c) => c.name);
  assert.deepEqual(missing, [], `declared but absent from --help: ${missing}`);
});

test("the committed docs page matches the declaration", () => {
  // Same property the cli:docs:check gate enforces, asserted here too so a
  // developer sees it in the test run rather than only from the task.
  const page = readFileSync(resolve(ROOT, "docs/reference/cli.md"), "utf8");
  const missing = COMMANDS.filter((c) => !page.includes(`## cloister ${c.name}`)).map((c) => c.name);
  assert.deepEqual(missing, [], `declared but absent from docs/reference/cli.md: ${missing}`);
});

test("the declaration carries no ANSI colour — colour belongs to the renderer", () => {
  // Chalk in the help renderer is fine. Chalk in the DECLARATION would leak
  // escape codes into the generated markdown, which is the one place they must
  // never appear.
  const raw = readFileSync(resolve(ROOT, "scripts/cli-surface.mjs"), "utf8");
  const ESC = String.fromCharCode(27);
  assert.ok(!raw.includes(ESC), "escape sequences must not appear in the declaration");
  assert.doesNotMatch(raw, /from ["']chalk["']/, "the declaration must not import chalk");
});
