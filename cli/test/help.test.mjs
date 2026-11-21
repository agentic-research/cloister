// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `--help` answers for every declared command, with no configuration at all,
// from the declaration (cli/help.mjs). Several commands used to check their
// configuration first: `runtime inspect --help` asked for an LLO control
// socket, and `install --help` ran the install bootstrap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { helpFor } from "../help.mjs";
import { COMMANDS, renderCommandHelp, renderHelp } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const empty = mkdtempSync(join(tmpdir(), "cloister-help-"));

/** The CLI as a user starts it, from an empty directory, with no configuration. */
const cloister = (args) => spawnSync(process.execPath, [resolve(ROOT, "bin/cloister.mjs"), ...args], {
  cwd: empty,
  encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: empty },
  timeout: 20_000,
});

test("every declared command answers --help and -h from its declaration, with nothing configured", () => {
  assert.ok(COMMANDS.length > 20, "the surface was read");
  for (const c of COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      const r = cloister([...c.name.split(" "), flag]);
      assert.equal(r.status, 0, `${c.name} ${flag}: ${r.stderr}`);
      assert.equal(r.stdout, `${renderCommandHelp(c.name)}\n`, `${c.name} ${flag}`);
    }
  }
});

test("--help answers wherever it sits among the command's own arguments", () => {
  const r = cloister(["runtime", "inspect", "some-run-id", "--json", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${renderCommandHelp("runtime inspect")}\n`);
});

test("a group answers --help with its commands", () => {
  for (const group of ["cluster", "runtime", "runtime storage", "skills", "dev"]) {
    const text = helpFor([...group.split(" "), "--help"]);
    assert.ok(text, group);
    for (const c of COMMANDS.filter((x) => x.name.startsWith(`${group} `))) assert.ok(text.includes(`cloister ${c.name} ...`), `${group}: ${c.name}`);
  }
});

test("the top-level help answers as it did", () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const r = cloister(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${renderHelp()}\n`, args.join(" "));
  }
});

test("--help after `--` belongs to whatever follows, not to cloister", () => {
  assert.equal(helpFor(["run", "--", "some-tool", "--help"]), undefined);
  assert.equal(helpFor(["cluster", "graph", "--env", "prod"]), undefined);
  assert.equal(helpFor(["no-such-command", "--help"]), undefined, "an unknown command is reported as unknown");
});
