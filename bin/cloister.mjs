#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GlobalOptionsError, parseGlobalOptions } from "../cli/lib/global-options.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function bootstrapInstall(argv, io) {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    io.stderr.write(
      `cloister install: Node 22 or newer is required; this is Node ${process.versions.node}.\n`,
    );
    return 2;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  } catch (error) {
    io.stderr.write(`cloister install: cannot read package.json: ${error.message}\n`);
    return 2;
  }
  const packageManager = String(packageJson.packageManager || "");
  if (!/^pnpm@\d/.test(packageManager)) {
    io.stderr.write(
      `cloister install: package.json must pin pnpm, got ${JSON.stringify(packageManager)}.\n`,
    );
    return 2;
  }

  const installed = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: ROOT,
    env: io.env ?? process.env,
    stdio: "inherit",
  });
  if (installed.error) {
    io.stderr.write(
      `cloister install: could not start pnpm (${packageManager}): ${installed.error.message}\n`,
    );
    return 2;
  }
  if (installed.status !== 0) {
    io.stderr.write(`cloister install: pnpm exited ${installed.status ?? "without a status"}.\n`);
    return installed.status ?? 1;
  }

  const { main } = await import("../cli/commands/install.mjs");
  return main(["install", ...argv.slice(1)], {
    stdout: io.stdout,
    stderr: io.stderr,
    env: io.env,
    log: (value) => io.stdout.write(`${value}\n`),
    errLog: (value) => io.stderr.write(`${value}\n`),
    root: ROOT,
  });
}

export async function run(argv = process.argv.slice(2), io = process) {
  try {
    // `install` must work before node_modules exists, but global flags may sit
    // before or after the command. Parse with the dependency-free extractor so
    // bootstrap detection does not become a second, narrower CLI grammar.
    let bootstrapArgv;
    try {
      bootstrapArgv = parseGlobalOptions(argv, io.env ?? process.env).argv;
    } catch (cause) {
      if (!(cause instanceof GlobalOptionsError)) throw cause;
      io.stderr.write(`cloister: ${cause.message}\n`);
      return 2;
    }
    if (bootstrapArgv[0] === "install") return await bootstrapInstall(bootstrapArgv, io);
    const { main } = await import("../cli/index.mjs");
    return await main(argv, {
      stdout: io.stdout,
      stderr: io.stderr,
      env: io.env,
    });
  } catch (error) {
    io.stderr.write(`cloister: ${error.message}\n`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))
);

if (invokedDirectly) {
  process.exitCode = await run();
}
