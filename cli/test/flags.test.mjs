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
import { FlagsError, flagKey, parseFlags } from "../lib/flags.mjs";
import { COMMANDS, renderCommandHelp } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

test("every cluster subcommand that has moved is declared, and the CLI holds it to its flags", () => {
  assert.ok(DECLARED_PARSE.length >= 1);
  for (const sub of DECLARED_PARSE) {
    const command = COMMANDS.find((c) => c.name === `cluster ${sub}`);
    assert.ok(command, `cluster ${sub} is parsed from a declaration it does not have`);
    const r = spawnSync(process.execPath, [resolve(ROOT, "bin/cloister.mjs"), "cluster", sub, "--no-such-flag"], { cwd: resolve(ROOT, "test/e2e/lowered-kind"), encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`unknown option "--no-such-flag" for \`cloister cluster ${sub}\``));
  }
});

test("a flag's key is its name in camelCase", () => {
  assert.equal(flagKey("--min-strength"), "minStrength");
  assert.equal(flagKey("--json"), "json");
});
