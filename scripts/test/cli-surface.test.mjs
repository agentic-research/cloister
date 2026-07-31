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

import { COMMANDS, renderHelp, HARNESS_ENV } from "../../cli/surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("every declared command is actually dispatched by the CLI", () => {
  // The direction that matters most: a command documented but not routed is a
  // promise the tool does not keep.
  // lint-allow-rawparse: matches the literal dispatch conditions, which is what
  // "does this string reach a handler" actually means.
  const src = readFileSync(resolve(ROOT, "cli/index.mjs"), "utf8");
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
  const raw = readFileSync(resolve(ROOT, "cli/surface.mjs"), "utf8");
  const ESC = String.fromCharCode(27);
  assert.ok(!raw.includes(ESC), "escape sequences must not appear in the declaration");
  assert.doesNotMatch(raw, /from ["']chalk["']/, "the declaration must not import chalk");
});

test("the harness launcher reads every declared env name THROUGH the shared constant", () => {
  // This rail used to check that the literal strings appeared in
  // harness-dev.mjs, because cli-run.mjs wrote them and harness-dev.mjs read
  // them — two literals in two files, and renaming either side left
  // `cloister run --repo X` silently confining to process.cwd() instead of X.
  //
  // cli-run.mjs no longer writes them at all: it passes a typed LaunchRequest
  // in-process. What remains couplable is the OPERATOR contract — the names a
  // person types before `task harness:dev` — and the way that stops drifting is
  // for the door to reference HARNESS_ENV rather than restate the strings.
  //
  // So the property tightened: not "the literal appears somewhere" but "the
  // door reads it from the one declaration". A literal reintroduced alongside
  // the constant would pass the old check and fail this one.
  //
  // lint-allow-rawparse: the property IS "does this file reference the shared
  // constant", so reading its text is the property, not a shortcut.
  const consumer = readFileSync(resolve(ROOT, "scripts/harness-dev.mjs"), "utf8");
  const unread = Object.keys(HARNESS_ENV)
    .filter((k) => k !== "sandboxProvider")
    .filter((k) => !consumer.includes(`HARNESS_ENV.${k}`))
    .map((k) => `${k} (${HARNESS_ENV[k]})`);
  assert.deepEqual(
    unread,
    [],
    `harness-dev.mjs no longer reads: ${unread}. The operator contract would drift.`,
  );
  assert.ok(
    consumer.includes("HARNESS_ENV.sandboxProvider"),
    `harness-dev.mjs no longer implements the ${HARNESS_ENV.sandboxProvider} provider`,
  );

  // And the names are not ALSO hardcoded next to the constant — which is how a
  // shared declaration quietly becomes decorative.
  for (const [key, name] of Object.entries(HARNESS_ENV)) {
    if (key === "sandboxProvider") continue;
    assert.ok(
      !new RegExp(`["'\`]${name}["'\`]`).test(consumer),
      `harness-dev.mjs hardcodes ${JSON.stringify(name)} alongside HARNESS_ENV.${key}`,
    );
  }
});

test("cloister run does NOT re-launch the harness bin — one orchestration, two doors", () => {
  // The structural half of the same property. `cloister run` used to spawn
  // `node scripts/harness-dev.mjs`; if it ever does again, the typed
  // LaunchRequest silently degrades back into env-var strings and the tests
  // that assert on the request would keep passing while the real path went
  // through a serializer nothing checks.
  //
  // lint-allow-rawparse: "does this file spawn that file" is a textual property.
  //
  // Comment lines are stripped first. The header of cli-run.mjs NAMES
  // harness-dev.mjs while explaining why it no longer spawns it — a rail that
  // failed on the explanation would be pressure to delete the explanation.
  const cliRun = readFileSync(resolve(ROOT, "cli/commands/run.mjs"), "utf8");
  const code = cliRun.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /harness-dev\.mjs/, "cloister run must not re-launch the bin");
  assert.doesNotMatch(
    code, /from "node:child_process"/,
    "cloister run has no reason to spawn anything — the pipeline is called directly",
  );
  assert.match(
    cliRun, /from "\.\.\/lib\/harness\/launch\.mjs"/,
    "cloister run must call the shared pipeline directly",
  );
});
