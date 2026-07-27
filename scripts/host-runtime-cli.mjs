#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { constants, accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BINARY = resolve(
  REPO_ROOT,
  "rs",
  "target",
  "release",
  "cloister-host-runtime",
);

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinary() {
  if (process.env.CLOISTER_HOST_RUNTIME_BIN) {
    return {
      command: process.env.CLOISTER_HOST_RUNTIME_BIN,
      configured: true,
    };
  }
  if (isExecutable(RELEASE_BINARY)) {
    return { command: RELEASE_BINARY, configured: false };
  }
  return { command: "cloister-host-runtime", configured: false };
}

export function runHostRuntime(args) {
  const binary = resolveBinary();
  if (binary.configured && !isExecutable(binary.command)) {
    console.error(
      `cloister: CLOISTER_HOST_RUNTIME_BIN is not executable: ${binary.command}`,
    );
    return 2;
  }
  const result = spawnSync(binary.command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(
      `cloister: unable to execute ${binary.command}: ${result.error.message}`,
    );
    console.error("Build it with `task runtime:build` or set CLOISTER_HOST_RUNTIME_BIN.");
    return 2;
  }
  if (result.signal) {
    console.error(`cloister: host runtime terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}
