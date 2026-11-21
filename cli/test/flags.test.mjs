// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A command's flags are parsed from its declaration in cli/surface.mjs
// (cli/lib/flags.mjs, ADR-0077 Part 3 as amended), the same entry its help is
// rendered from. So what help lists and what the parser accepts cannot
// disagree; these check the parser's side of that, and that a command which
// has moved stays moved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DECLARED_PARSE } from "../commands/cluster.mjs";
import { FlagsError, argumentKey, flagKey, parseFlags } from "../lib/flags.mjs";
import { COMMANDS, renderCommandHelp } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The commands that still parse their arguments by hand (ADR-0077 Part 3).
// Every other declared command is held below to its declaration. This list
// only shrinks: a command added to cli/surface.mjs is parsed from its
// declaration, or is added here where a reviewer sees it.
const NOT_YET_MOVED = new Set([
  "install",
  "uninstall",
  "run",
  "dev bootstrap",
  "dev serve",
  "dev test",
  "init",
  "skills list",
  "skills pin",
  "cluster generate",
  "cluster resolve",
  "cluster up",
  "cluster down",
  "cluster k8s",
  "cluster lower",
  "inspect",
  "runtime plan",
  "runtime install",
  "runtime import",
  "runtime run",
  "runtime inspect",
  "runtime collect",
  "runtime cancel",
  "runtime cleanup",
  "runtime doctor",
  "runtime storage init",
  "runtime storage status",
]);

test("an absent flag takes its declared default, and a given one its value", () => {
  assert.deepEqual(parseFlags("cluster graph", []), { env: "local", dir: ".", json: false });
  assert.deepEqual(parseFlags("cluster graph", ["--env", "prod", "--json"]), { env: "prod", dir: ".", json: true });
  assert.equal(parseFlags("cluster graph", ["--env=prod"]).env, "prod");
});

test("only declared flags are accepted, and each mistake is named", () => {
  for (const [argv, message] of [
    [["--destroy"], /unknown option "--destroy" for `cloister cluster graph`/],
    [["stray"], /unexpected argument "stray"/],
    [["--env"], /--env requires a value/],
    [["--env", "--json"], /--env requires a value \(for one that starts with "-", write --env=<value>\)/],
    [["--json=1"], /--json is a switch and takes no value/],
    [["--dir", "a", "--dir", "b"], /--dir is given more than once/],
  ]) {
    assert.throws(() => parseFlags("cluster graph", argv), (e) => e instanceof FlagsError && message.test(e.message), JSON.stringify(argv));
  }
});

test("a required flag must be given", () => {
  const run = COMMANDS.find((c) => c.name === "run");
  assert.ok(run.flags.some((f) => f.flag === "--repo" && f.required), "run declares --repo required");
  assert.throws(() => parseFlags("run", []), (e) => e instanceof FlagsError && /--repo is required/.test(e.message));
});

test("a command that is not declared is a programming error, not a usage one", () => {
  assert.throws(() => parseFlags("cluster nope", []), (e) => !(e instanceof FlagsError) && /no command "cluster nope" is declared/.test(e.message));
});

test("help shows a declared default from the declaration", () => {
  assert.match(renderCommandHelp("cluster graph"), /--env <name> +environment whose connection targets and placements are read \(default: local\)/);
  const graph = COMMANDS.find((c) => c.name === "cluster graph");
  // A default is stated once: in its `default`, not also in its summary.
  for (const f of graph.flags) assert.doesNotMatch(f.summary, /default:/, f.flag);
});

test("every declared command but the listed ones is held by the CLI to its declaration", () => {
  // Run through the real entry point, so this holds what a user types, not
  // what a unit test calls. An unmoved command is never run here: a hand
  // parser might ignore the flag and go on to do real work.
  const moved = COMMANDS.filter((c) => !NOT_YET_MOVED.has(c.name));
  assert.ok(moved.length >= 3, "cluster graph, add and artifacts pull have moved");
  for (const c of moved) {
    const r = spawnSync(process.execPath, [resolve(ROOT, "bin/cloister.mjs"), ...c.name.split(" "), "--no-such-flag"], { cwd: resolve(ROOT, "test/e2e/lowered-kind"), encoding: "utf8" });
    assert.equal(r.status, 2, `${c.name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`unknown option "--no-such-flag" for \`cloister ${c.name}\``), c.name);
  }
});

test("the list of unmoved commands names only declared commands, and none cluster parses from its declaration", () => {
  const declared = new Set(COMMANDS.map((c) => c.name));
  for (const name of NOT_YET_MOVED) assert.ok(declared.has(name), `${name} is listed as unmoved but is not declared`);
  assert.ok(DECLARED_PARSE.length >= 1);
  for (const sub of DECLARED_PARSE) {
    assert.ok(declared.has(`cluster ${sub}`), `cluster ${sub} is parsed from a declaration it does not have`);
    assert.ok(!NOT_YET_MOVED.has(`cluster ${sub}`), `cluster ${sub} has moved; take it off the list`);
  }
});

test("declared arguments are the positionals, in order; only the last repeats", () => {
  assert.deepEqual(parseFlags("add", ["github://o/r@main"]), { ref: "github://o/r@main", name: undefined, version: undefined, provides: [], requires: [] });
  assert.deepEqual(parseFlags("artifacts pull", []).input, []);
  assert.deepEqual(parseFlags("artifacts pull", ["a", "--print", "b"]).input, ["a", "b"]);
  for (const [name, argv, message] of [
    ["add", [], /<ref> is required/],
    ["add", ["a", "b"], /unexpected argument "b" for `cloister add`/],
    // `--` ends the options only where it is declared; elsewhere it would
    // turn what follows into an argument without saying so.
    ["add", ["--", "github://o/r@main"], /unexpected argument "--" for `cloister add`/],
  ]) {
    assert.throws(() => parseFlags(name, argv), (e) => e instanceof FlagsError && message.test(e.message), JSON.stringify(argv));
  }
});

test("a declared short alias means its flag, and a repeatable flag collects every value", () => {
  assert.equal(parseFlags("artifacts pull", ["-y"]).yes, true);
  assert.throws(() => parseFlags("artifacts pull", ["-y", "--yes"]), /--yes is given more than once/);
  assert.throws(() => parseFlags("artifacts pull", ["-x"]), /unknown option "-x" for `cloister artifacts pull`/);
  assert.deepEqual(parseFlags("add", ["r", "--provides", "a/b/v1", "--provides", "c/d/v1"]).provides, ["a/b/v1", "c/d/v1"]);
});

test("help shows declared arguments, short aliases, repeatable flags and examples from the declaration", () => {
  const add = renderCommandHelp("add");
  assert.match(add, /Arguments:\n {2}<ref> +the input: file:\/\/<abs-path>, .*io\.github\.org\/owner\/repo.* \(required\)/);
  assert.match(add, /--provides <cap> +a capability this input provides, .* \(repeatable\)/);
  assert.match(add, /Examples:\n {2}cloister add github:\/\/anthropic\/skills@main/);
  const pull = renderCommandHelp("artifacts pull");
  assert.match(pull, / {2}<input>\.\.\. +an input whose images to pull/);
  assert.match(pull, / {2}-y, --yes +approve the plan shown/);
});

test("an argument's key is its name in camelCase, without the angle brackets", () => {
  assert.equal(argumentKey("<run-id>"), "runId");
  assert.equal(argumentKey("<ref>"), "ref");
});

test("a flag's key is its name in camelCase", () => {
  assert.equal(flagKey("--min-strength"), "minStrength");
  assert.equal(flagKey("--json"), "json");
});

test("a declared `--` passes what follows through, unparsed", () => {
  const run = COMMANDS.find((c) => c.name === "run");
  assert.ok(run.flags.some((f) => f.flag === "--"), "run declares --");
  const out = parseFlags("run", ["--repo", ".", "--", "some-tool", "--its-own-flag", "x"]);
  assert.equal(out.repo, ".");
  assert.deepEqual(out.passthrough, ["some-tool", "--its-own-flag", "x"]);
  // Without a declared `--`, a stray `--` and what follows are refused as for any argument.
  assert.throws(() => parseFlags("cluster graph", ["--", "x"]), FlagsError);
});
