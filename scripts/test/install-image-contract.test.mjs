import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("the clean image excludes every local dependency and build cache", () => {
  const ignored = read(".dockerignore");
  for (const entry of [
    ".git", "node_modules", ".pnpm-store", ".task", ".wrangler",
    ".env.local", ".dev.vars", ".fastembed_cache", ".cloister", ".beads", "dist", "rs/target",
    "tools/*/target", "cloister*.tar",
  ]) {
    assert.match(ignored, new RegExp(`^${entry.replaceAll("*", ".*")}$`, "m"), entry);
  }
});

test("the image runs the real first-time install and installed confinement binary", () => {
  const dockerfile = read("test/install-image/Dockerfile");
  assert.match(dockerfile, /^FROM node:22-bookworm$/m);
  assert.match(dockerfile, /task install/);
  assert.match(dockerfile, /pnpm@10\.30\.3/);
  assert.match(dockerfile, /chalk.*smol-toml.*tsx/s);
  assert.match(dockerfile, /cloister skills list/);
  assert.match(dockerfile, /cloister cluster generate --check/);
  assert.match(dockerfile, /cloister run .*--dry-run/);
  assert.match(dockerfile, /CLOISTER_REQUIRE_CONFINEMENT=1/);
});

test("every supported environment declares the Node 22 runtime Wrangler requires", () => {
  assert.equal(JSON.parse(read("package.json")).engines.node, ">=22");
  assert.match(read("bin/cloister.mjs"), /major < 22/);
  assert.match(read("bin/cloister.mjs"), /Node 22 or newer is required/);

  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/generated-drift.yml"]) {
    assert.doesNotMatch(read(workflow), /node-version:\s*["']?20["']?/);
  }
});

test("the binary conformance test can require an installed binary without skips", () => {
  const conformance = read("tools/harness-sandbox/test/cloister-harness-binary.test.mjs");
  assert.match(conformance, /process\.env\.CLOISTER_HARNESS_BIN/);
  assert.match(conformance, /process\.env\.CLOISTER_REQUIRE_CONFINEMENT/);
  assert.match(conformance, /confinement prerequisite/);
});

test("Task and CI expose the clean image gate", () => {
  assert.match(read("Taskfile.yml"), /test:install:image:[\s\S]*docker build/);
  assert.match(read(".github/workflows/ci.yml"), /install-image:[\s\S]*task test:install:image/);
});
