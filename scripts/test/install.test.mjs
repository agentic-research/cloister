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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { installCliLink, uninstallCliLink } from "../../cli/commands/install.mjs";
import { resolveInstallLayout } from "../../cli/lib/install-layout.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const PROJECT_FILES = [
  "Taskfile.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "bin",
  "cli",
  "rs/Cargo.toml",
  "rs/Taskfile.yml",
  "recipes/Taskfile.yml",
  "tools/harness-sandbox/Cargo.toml",
  "cluster.toml",
  "cloister.capnp",
  "manifest",
  "scripts",
  "src",
];

function makeFreshProject() {
  const root = mkdtempSync(join(tmpdir(), "cloister-install-"));
  for (const relativePath of PROJECT_FILES) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(REPO_ROOT, relativePath), destination, { recursive: true });
  }
  return root;
}

function makePnpmShim(root, shimDir) {
  const shim = join(shimDir, "pnpm");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/usr/bin/env node
import { appendFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";

const source = process.env.CLOISTER_TEST_SOURCE_NODE_MODULES;
if (!source) throw new Error("CLOISTER_TEST_SOURCE_NODE_MODULES is required");
if (process.argv.slice(2).join(" ") !== "install --frozen-lockfile") {
  throw new Error("unexpected pnpm arguments: " + process.argv.slice(2).join(" "));
}
appendFileSync(process.env.CLOISTER_TEST_TOOL_LOG, "pnpm " + process.argv.slice(2).join(" ") + "\\n");
symlinkSync(source, resolve(process.cwd(), "node_modules"), "dir");
`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  return shim;
}

function makeCargoShim(shimDir) {
  const shim = join(shimDir, "cargo");
  writeFileSync(shim, `#!/usr/bin/env node
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
appendFileSync(process.env.CLOISTER_TEST_TOOL_LOG, "cargo " + args.join(" ") + "\\n");
const manifestAt = args.indexOf("--manifest-path");
const manifest = manifestAt >= 0 ? args[manifestAt + 1] : "";
let output;
if (manifest === "tools/harness-sandbox/Cargo.toml") {
  output = "tools/harness-sandbox/target/release/cloister-harness";
} else if (manifest === "rs/Cargo.toml" && args.includes("cloister-host-runtime")) {
  output = "rs/target/release/cloister-host-runtime";
} else {
  throw new Error("unexpected cargo arguments: " + args.join(" "));
}
const path = resolve(process.cwd(), output);
mkdirSync(resolve(path, ".."), { recursive: true });
writeFileSync(path, "#!/bin/sh\\nexit 0\\n");
chmodSync(path, 0o755);
`, { mode: 0o755 });
  chmodSync(shim, 0o755);
  return shim;
}

test("Task install is only an alias for the first-party installer", () => {
  // lint-allow-rawparse: command ownership is a literal Taskfile property; a
  // YAML parser would discard the shell/block shape this regression checks.
  const taskfile = readFileSync(join(REPO_ROOT, "Taskfile.yml"), "utf8");
  const block = taskfile.match(/^  install:\n([\s\S]*?)(?=^  [\w:-]+:|^\S)/m)?.[1] ?? "";
  assert.match(block, /cmds:\n\s+- node bin\/cloister\.mjs install\n/);
  assert.doesNotMatch(block, /deps:|ln -s|pnpm|cargo/);

  const uninstall = taskfile.match(/^  uninstall:\n([\s\S]*?)(?=^  [\w:-]+:|^\S)/m)?.[1] ?? "";
  assert.match(uninstall, /cmds:\n\s+- node bin\/cloister\.mjs uninstall\n/);
  assert.doesNotMatch(uninstall, /rm |unlink|readlink/);

  const runtime = taskfile.match(/^  runtime:build:\n([\s\S]*?)(?=^  [\w:-]+:|^\S)/m)?.[1] ?? "";
  assert.match(runtime, /cmds:\n\s+- node bin\/cloister\.mjs runtime install\n/);
  assert.doesNotMatch(runtime, /rs:host-runtime:build|cargo|rs\/target/);
});

test("uninstall removes only this checkout's symlink and keeps runtime files", () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-uninstall-"));
  const layout = resolveInstallLayout({
    env: {
      CLOISTER_BIN_DIR: join(root, "installed/bin"),
      CLOISTER_LIBEXEC_DIR: join(root, "installed/libexec"),
    },
    home: root,
    checkoutRoot: root,
  });
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin/cloister.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    chmodSync(join(root, "bin/cloister.mjs"), 0o755);
    mkdirSync(layout.libexecDir, { recursive: true });
    writeFileSync(join(layout.libexecDir, "keep-me"), "runtime state\n");

    installCliLink(layout);
    assert.ok(existsSync(layout.cliLink));
    assert.deepEqual(uninstallCliLink(layout), { removed: true, reason: "owned" });
    assert.equal(existsSync(layout.cliLink), false);
    assert.ok(existsSync(join(layout.libexecDir, "keep-me")));

    mkdirSync(layout.binDir, { recursive: true });
    writeFileSync(layout.cliLink, "unrelated command\n");
    assert.throws(() => installCliLink(layout), /refusing to overwrite/);
    assert.throws(() => uninstallCliLink(layout), /refusing to remove/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task install bootstraps dependencies before exposing a usable CLI", () => {
  const root = makeFreshProject();
  const binDir = join(root, ".install", "bin");
  const libexecDir = join(root, ".install", "libexec");
  const shimDir = join(root, "shim");
  const toolLog = join(root, "tool.log");
  makePnpmShim(root, shimDir);
  makeCargoShim(shimDir);

  try {
    assert.equal(existsSync(join(root, "node_modules")), false, "fixture must start dependency-free");
    assert.ok(
      statSync(join(root, "bin", "cloister.mjs")).mode & 0o111,
      "the package executable bit must survive a fresh checkout",
    );

    const install = spawnSync("task", ["-d", root, "install"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLOISTER_BIN_DIR: binDir,
        CLOISTER_LIBEXEC_DIR: libexecDir,
        CLOISTER_TEST_SOURCE_NODE_MODULES: resolve(REPO_ROOT, "node_modules"),
        CLOISTER_TEST_TOOL_LOG: toolLog,
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
    const record = JSON.parse(readFileSync(join(libexecDir, "runtime-provider.json"), "utf8"));
    assert.equal(record.schema, "cloister/runtime-provider/v1");
    assert.equal(record.provider, "compatibility");
    assert.equal(record.maturity, "experimental");
    for (const artifact of ["nativeHelper", "hostRuntime"]) {
      assert.match(record.artifacts[artifact].sha256, /^[0-9a-f]{64}$/);
      const installed = join(libexecDir, record.artifacts[artifact].file);
      assert.ok(statSync(installed).mode & 0o111, `${artifact} must be executable`);
    }
    assert.equal(readFileSync(toolLog, "utf8"), [
      "pnpm install --frozen-lockfile",
      "cargo build --release --manifest-path tools/harness-sandbox/Cargo.toml",
      "cargo build --release --manifest-path rs/Cargo.toml -p cloister-host-runtime",
      "",
    ].join("\n"));

    const smoke = [
      { args: ["--help"], stdout: /cloister/i },
      { args: ["skills", "list", "--dir", root, "--state-dir", join(root, ".state")], stdout: /skill/i },
      { args: ["cluster", "generate", "--check", "--dir", root], stdout: /all projections match/ },
      { args: ["run", "--dry-run", "--repo", root], stdout: /DRY RUN/ },
    ];
    for (const check of smoke) {
      const cli = spawnSync(join(binDir, "cloister"), check.args, {
        cwd: root,
        env: {
          ...process.env,
          CLOISTER_BIN_DIR: binDir,
          CLOISTER_LIBEXEC_DIR: libexecDir,
          PATH: `${shimDir}:${process.env.PATH}`,
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(
        cli.status,
        0,
        `installed CLI failed: ${check.args.join(" ")}\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
      assert.match(cli.stdout, check.stdout);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
