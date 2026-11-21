// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A command declared in manifest/cli.capnp has its flags parsed from that
// declaration (cli/lib/flags.mjs, ADR-0077 Part 3). Until the surface itself
// is generated (Part 2), cli/surface.mjs lists those flags a second time, for
// help and docs; the last test holds the two equal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import TOOLS from "../../src/generated/cli.tools.json" with { type: "json" };
import { FlagsError, flagName, parseFlags } from "../lib/flags.mjs";
import { COMMANDS } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("an absent flag takes its declared default, and a given one its value", () => {
  assert.deepEqual(parseFlags("cluster graph", []), { env: "local", dir: ".", json: false });
  assert.deepEqual(parseFlags("cluster graph", ["--env", "prod", "--json"]), { env: "prod", dir: ".", json: true });
  assert.deepEqual(parseFlags("cluster graph", ["--env=prod"]).env, "prod");
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
    assert.throws(() => parseFlags("cluster graph", argv), message, JSON.stringify(argv));
  }
});

test("a command that is not declared is a programming error, not a usage one", () => {
  assert.throws(() => parseFlags("cluster nope", []), (e) => !(e instanceof FlagsError) && /no command "cluster nope" is declared/.test(e.message));
});

test("the CLI refuses an undeclared flag on a declared command, with exit 2", () => {
  const r = spawnSync(process.execPath, [resolve(ROOT, "bin/cloister.mjs"), "cluster", "graph", "--destroy"], { cwd: resolve(ROOT, "test/e2e/lowered-kind"), encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown option "--destroy" for `cloister cluster graph`/);
});

test("cli/surface.mjs lists exactly the flags each declared command declares", () => {
  assert.ok(TOOLS.length >= 1, "a command is declared");
  for (const tool of TOOLS) {
    const surface = COMMANDS.find((c) => c.name === tool.name);
    assert.ok(surface, `${tool.name} is declared in manifest/cli.capnp but not in cli/surface.mjs`);
    const declared = Object.entries(tool.inputSchema.properties)
      .map(([field, prop]) => [`--${flagName(field)}`, prop.type === "boolean" ? "switch" : "value"])
      .sort();
    const listed = (surface.flags ?? []).map((f) => [f.flag, f.value ? "value" : "switch"]).sort();
    assert.deepEqual(listed, declared, tool.name);
  }
});
