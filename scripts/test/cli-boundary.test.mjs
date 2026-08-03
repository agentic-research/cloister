// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OPERATOR_TASKS = [
  "install",
  "uninstall",
  "dev:bootstrap",
  "dev",
  "init",
  "add",
  "inputs:pull",
  "cluster:toml",
  "cluster:emit",
  "cluster:resolve",
  "cluster:up",
  "cluster:down",
  "harness:dev",
  "harness:dev:setup",
  "runtime:plan",
  "runtime:build",
  "runtime:doctor",
  "runtime:run",
  "runtime:storage:init",
  "runtime:storage:status",
  "runtime:storage:gc",
];

function taskBody(taskfile, name) {
  const lines = taskfile.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `Taskfile has no ${name} task`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^  [a-zA-Z0-9:_-]+:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

test("operator Taskfile commands are aliases to the first-party CLI", () => {
  const taskfile = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
  const failures = [];
  for (const name of OPERATOR_TASKS) {
    const body = taskBody(taskfile, name);
    if (!body.includes("bin/cloister.mjs")) failures.push(`${name}: does not invoke bin/cloister.mjs`);
    if (/\b(?:scripts|tools)\//.test(body)) failures.push(`${name}: invokes repository implementation code`);
  }
  assert.deepEqual(failures, []);
});

test("product modules do not import repository scripts or spawn Task", () => {
  const failures = [];
  for (const file of [...sourceFiles(resolve(ROOT, "bin")), ...sourceFiles(resolve(ROOT, "cli"))]) {
    const name = relative(ROOT, file);
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)) {
      const specifier = match[2];
      if (/(?:^|\/)\.\.\/(?:scripts|tools)(?:\/|$)/.test(specifier)) {
        failures.push(`${name}: imports ${specifier}`);
      }
    }
    if (/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["']task["']/.test(source)) {
      failures.push(`${name}: spawns task`);
    }
  }
  assert.deepEqual(failures, []);
});

test("source-tree compatibility paths stay confined to named adapters", () => {
  const allowed = new Set([
    "cli/lib/dev/test-runner.mjs",
    "cli/lib/runtime/install-compatibility.mjs",
  ]);
  const offenders = [];
  for (const file of sourceFiles(resolve(ROOT, "cli"))) {
    const name = relative(ROOT, file);
    const source = withoutComments(readFileSync(file, "utf8"));
    if (source.includes("tools/harness-sandbox") && !allowed.has(name)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);

  const client = readFileSync(resolve(ROOT, "cli/lib/runtime/compatibility-client.mjs"), "utf8");
  assert.doesNotMatch(withoutComments(client), /krunvm/);
  assert.ok(existsSync(resolve(ROOT, "cli/lib/runtime/install-compatibility.mjs")));
});
