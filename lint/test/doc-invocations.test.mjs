// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/doc-invocations.mjs holds every `cloister …` and `task …` line in the
// docs to the CLI's declaration and to Task's own task list. The first test is
// the property on the shipped tree, with a floor so it cannot pass by finding
// nothing; the rest pin what each part of the reading does.

import { test } from "node:test";
import assert from "node:assert/strict";

import { cloisterArgs, cloisterProblem, problems, shellFences, simpleCommands, taskNames, taskProblem } from "../doc-invocations.mjs";
import { COMMANDS } from "../../cli/surface.mjs";

test("every documented invocation in the shipped docs holds, and there are many", () => {
  const { found, checked } = problems();
  assert.deepEqual(found.map((p) => `${p.file}:${p.line}: ${p.problem}`), []);
  assert.ok(checked >= 100, `only ${checked} invocations were read; the gate is reading less than the docs hold`);
});

test("a shell fence is read as commands: continuations joined, console prompts stripped, output skipped", () => {
  const md = [
    "text",
    "```sh",
    "cloister inspect --terraform plan.json \\",
    "  --env prod",
    "```",
    "```console",
    "$ cloister cluster graph --env prod",
    "2 edges for env \"prod\"",
    "```",
    "```yaml",
    "cloister: not a command",
    "```",
  ].join("\n");
  assert.deepEqual(shellFences(md).map((c) => [c.line, c.text]), [
    [3, "cloister inspect --terraform plan.json    --env prod"],
    [7, "cloister cluster graph --env prod"],
  ]);
});

test("a shell line is split by a shell tokenizer, not on spaces", () => {
  assert.deepEqual(simpleCommands('FOO=1 cloister cluster graph --env "my env" > out.txt && task bundle # note'), [
    ["cloister", "cluster", "graph", "--env", "my env"],
    ["task", "bundle"],
  ]);
  // `2>&1`: the 2 is a file descriptor, not an argument.
  assert.deepEqual(simpleCommands("task helper:start > /tmp/x.log 2>&1 &"), [["task", "helper:start"]]);
  assert.deepEqual(simpleCommands("cat a | grep b; echo $HOME"), [["cat", "a"], ["grep", "b"], ["echo", "$HOME"]]);
});

test("cloister is found however a document runs it", () => {
  assert.deepEqual(cloisterArgs(["cloister", "inspect"]), ["inspect"]);
  assert.deepEqual(cloisterArgs(["node", "cloister.mjs", "inspect"]), ["inspect"]);
  assert.deepEqual(cloisterArgs(["node", "dist/cloister.mjs", "--help"]), ["--help"]);
  assert.deepEqual(cloisterArgs(["npx", "cloister", "run"]), ["run"]);
  assert.deepEqual(cloisterArgs(["pnpm", "exec", "cloister", "run"]), ["run"]);
  assert.equal(cloisterArgs(["node", "gen/bundle.mjs"]), null);
  assert.equal(cloisterArgs(["echo", "cloister"]), null);
});

test("a cloister invocation is held to the declared commands and flags", () => {
  assert.equal(cloisterProblem(["cluster", "graph", "--env", "prod", "--json"]), null);
  assert.equal(cloisterProblem(["cluster", "graph", "--env=prod"]), null);
  assert.equal(cloisterProblem([]), null);
  assert.equal(cloisterProblem(["--help"]), null);
  assert.equal(cloisterProblem(["cluster", "--help"]), null, "a group asked for help");
  assert.match(cloisterProblem(["clster", "graph"]), /`cloister clster graph` is not a declared command/);
  assert.match(cloisterProblem(["cluster"]), /`cloister cluster` is not a declared command/, "a group alone runs nothing");
  assert.match(cloisterProblem(["cluster", "graph", "--destroy"]), /`cloister cluster graph` declares no flag --destroy/);
  // A flag's value is not read as a flag, and what follows `--` is not cloister's.
  assert.equal(cloisterProblem(["cluster", "graph", "--env", "--json"]), null);
  const run = COMMANDS.find((c) => c.name === "run");
  assert.ok(run.flags, "run declares its flags");
  assert.equal(cloisterProblem(["run", "--repo", ".", "--", "some-tool", "--its-own-flag"]), null);
});

test("a task invocation names tasks Task knows, including a scaffold's", () => {
  const names = taskNames();
  assert.ok(names.has("lint") && names.has("bundle"), "the repository's tasks");
  assert.ok(names.has("up") && names.has("down"), "the tasks cloister init gives a scaffold");
  assert.equal(taskProblem(["lint"], names), null);
  assert.equal(taskProblem(["test", "--", "-run", "X"], names), null);
  assert.equal(taskProblem(["init", "--", "--recipe", "x"], names), null);
  assert.match(taskProblem(["plan:bundle"], names), /`task plan:bundle` is not a task/);
});

test("every declared flag is a bare --name, with its placeholder in `value`", () => {
  // `{ flag: "--layout <dir>" }` was how runtime import declared its flags,
  // which no parser or gate can match against `--layout`. `--` alone is the
  // declared end of options: what follows is passed through (`cloister run`).
  for (const c of COMMANDS) {
    for (const f of c.flags ?? []) {
      if (f.flag === "--") continue;
      assert.match(f.flag, /^--[a-z0-9][a-z0-9-]*$/, `${c.name}: ${JSON.stringify(f.flag)}`);
    }
  }
});
