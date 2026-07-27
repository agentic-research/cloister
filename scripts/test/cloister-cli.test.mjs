// Contract tests for the package-level `cloister` command dispatcher.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PACKAGE = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
const CLI = resolve(REPO_ROOT, PACKAGE.bin.cloister);

function run(args) {
  return spawnSync("node", [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("top-level help names the real command surface", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cloister init/);
  assert.match(r.stdout, /cloister add/);
  assert.match(r.stdout, /cloister artifacts pull/);
  assert.match(r.stdout, /cloister runtime plan/);
  assert.match(r.stdout, /cloister runtime storage init/);
});

test("runtime storage init dispatches to a non-mutating preview", () => {
  const r = run(["runtime", "storage", "init", "--print"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /krunvm storage plan/);
  assert.match(r.stdout, /host storage unchanged/);
});

test("unknown top-level command fails with usage", () => {
  const r = run(["surprise"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test("artifacts pull dispatches to the lockfile-backed preview", () => {
  const r = run(["artifacts", "pull", "--print"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Artifacts requested by cluster\.lock\.toml/);
  assert.match(r.stdout, /mache.*sha256:/);
});

test("runtime plan emits the digest-pinned Mache microVM contract", () => {
  const r = run(["runtime", "plan", "mache", "--workspace", REPO_ROOT]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.bundle, "mache");
  assert.equal(plan.mode, "microvm");
  assert.equal(plan.artifact.entrypoint, "/usr/local/bin/mache");
  assert.match(plan.artifact.digest, /^sha256:[0-9a-f]{64}$/);
});
