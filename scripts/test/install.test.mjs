// Fresh-install smoke test.
//
// A normal test checkout already has node_modules, which hides a broken
// `task install`. This fixture copies the runnable project surface without
// dependencies, invokes the real root Taskfile, and then executes the CLI
// through the installed symlink.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PROJECT_FILES = [
  "Taskfile.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "rs/Taskfile.yml",
  "recipes/Taskfile.yml",
  "cluster.toml",
  "cloister.capnp",
  "manifest",
  "scripts",
  "src",
];

function makeFreshProject() {
  const root = mkdtempSync(join(tmpdir(), "cloister-install-"));
  for (const relativePath of PROJECT_FILES) {
    cpSync(resolve(REPO_ROOT, relativePath), join(root, relativePath), { recursive: true });
  }
  return root;
}

function makePnpmShim(root, shimDir) {
  const shim = join(shimDir, "pnpm");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/usr/bin/env node
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = process.env.CLOISTER_TEST_SOURCE_NODE_MODULES;
if (!source) throw new Error("CLOISTER_TEST_SOURCE_NODE_MODULES is required");
symlinkSync(source, resolve(process.cwd(), "node_modules"), "dir");
`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  return shim;
}

test("task install bootstraps dependencies before exposing a usable CLI", () => {
  const root = makeFreshProject();
  const binDir = join(root, "bin");
  const shimDir = join(root, "shim");
  const shim = makePnpmShim(root, shimDir);

  try {
    assert.equal(existsSync(join(root, "node_modules")), false, "fixture must start dependency-free");

    const install = spawnSync("task", ["-d", root, "install"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLOISTER_BIN_DIR: binDir,
        CLOISTER_TEST_SOURCE_NODE_MODULES: resolve(REPO_ROOT, "node_modules"),
        PATH: `${shimDir}:${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(
      install.status,
      0,
      `task install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );

    assert.ok(existsSync(join(binDir, "cloister")), "task install must create the CLI symlink");

    const cli = spawnSync(join(binDir, "cloister"), ["--help"], {
      cwd: root,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(
      cli.status,
      0,
      `installed CLI failed\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
    );
    assert.match(cli.stdout, /cloister/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
