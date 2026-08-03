// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchSession } from "../../cli/lib/harness/launch.mjs";
import { startLocalRouter } from "../../cli/lib/dev/router.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function fakeChild() {
  return {
    pid: 1234,
    kill() {},
    on() {},
  };
}

test("normal CLI execution names neither Task nor source-tree tools", () => {
  const launchSource = withoutComments(
    readFileSync(resolve(ROOT, "cli/lib/harness/launch.mjs"), "utf8"),
  );
  assert.doesNotMatch(launchSource, /spawn\(["']task["']/);
  assert.doesNotMatch(launchSource, /tools\/harness-shim/);
  assert.doesNotMatch(launchSource, /tools\/harness-sandbox\/target/);
});

test("launchSession starts the local router directly through pnpm", async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, args, options]);
    return fakeChild();
  };
  const plan = {
    root: ROOT,
    shimPort: "8799",
    auth: { mode: "custody" },
    target: {
      name: "fixture",
      baseUrlEnv: "FIXTURE_BASE_URL",
      stripEnv: [],
      apiKeyEnv: "FIXTURE_KEY",
      entryPoint: "fixture",
    },
    baseUrl: "http://127.0.0.1:8799",
    sandbox: null,
  };
  const artifacts = {
    identity: {
      certDerB64Url: "cert",
      ephemeralPrivSeedB64Url: "seed",
      ephemeralPubB64Url: "pub",
    },
    ephemeralPaths: [],
  };

  const session = await launchSession(plan, artifacts, {
    spawn,
    // Exercise the real first-party router function with test-owned config
    // seams; a unit test must not require the developer's ignored .env.local.
    startLocalRouter: (options) => startLocalRouter({
      ...options,
      existsSync: () => true,
      assertConfigSourcesSafe: () => {},
      loadLocalEnv: (_root, env) => env,
    }),
    resolveCompanionWorkers: () => [],
    assertPortsFree: () => {},
    waitForHealth: async () => {},
    waitForPort: async () => {},
    killProcessGroup: () => {},
    errLog: () => {},
  });
  await session.shutdown();

  assert.deepEqual(calls[0].slice(0, 2), [
    "pnpm",
    ["exec", "wrangler", "dev"],
  ]);
  assert.equal(calls[0][2].cwd, ROOT);
  assert.equal(calls[0][2].stdio, "inherit");
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls.some(([command]) => command === "task"), false);
});

test("startLocalRouter loads .env.local without a shell and runs the safety check", () => {
  const calls = [];
  let checked = false;
  const child = startLocalRouter({
    root: "/tmp/cloister-fixture",
    env: { BASE: "kept" },
    existsSync: () => true,
    assertConfigSourcesSafe: () => { checked = true; },
    loadLocalEnv: (_root, env) => ({ ...env, LOCAL: "loaded" }),
    spawn: (...args) => { calls.push(args); return fakeChild(); },
  });

  assert.equal(child.pid, 1234);
  assert.equal(checked, true);
  assert.deepEqual(calls[0].slice(0, 2), ["pnpm", ["exec", "wrangler", "dev"]]);
  assert.deepEqual(calls[0][2].env, { BASE: "kept", LOCAL: "loaded" });
});

test("Vitest reuses the real Wrangler config without loading operator .dev.vars", () => {
  const link = resolve(ROOT, "test/wrangler.vitest.toml");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "test config must remain a single-source symlink");
  assert.equal(readlinkSync(link), "../wrangler.toml");
  const config = readFileSync(resolve(ROOT, "vitest.config.ts"), "utf8");
  assert.match(config, /test\/wrangler\.vitest\.toml/);
});
