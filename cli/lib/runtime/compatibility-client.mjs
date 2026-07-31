#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { constants, accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstallLayout } from "../install-layout.mjs";
import {
  readProviderRecord,
  resolveProviderArtifact,
  RuntimeProviderError,
} from "./provider-record.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveHostRuntime({ env = process.env } = {}) {
  if (env.CLOISTER_HOST_RUNTIME_BIN) {
    if (!isExecutable(env.CLOISTER_HOST_RUNTIME_BIN)) {
      throw new RuntimeProviderError(
        `CLOISTER_HOST_RUNTIME_BIN is not executable: ${env.CLOISTER_HOST_RUNTIME_BIN}`,
      );
    }
    return { command: env.CLOISTER_HOST_RUNTIME_BIN, source: "explicit override" };
  }

  const layout = resolveInstallLayout({ env, checkoutRoot: REPO_ROOT });
  const record = readProviderRecord(layout);
  const command = resolveProviderArtifact(record, "hostRuntime");
  if (!isExecutable(command)) {
    throw new RuntimeProviderError(`installed host runtime is not executable: ${command}`);
  }
  return { command, source: "compatibility provider", record };
}

export class CompatibilityRuntimeError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = "CompatibilityRuntimeError";
    Object.assign(this, evidence);
  }
}

export function runCompatibilityJson(args, deps = {}) {
  const env = deps.env ?? process.env;
  const spawn = deps.spawnSync ?? spawnSync;
  const binary = resolveHostRuntime({ env });
  const result = spawn(binary.command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const evidence = {
    command: binary.command,
    provider: binary.source,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stderr: result.stderr ?? "",
    spawnError: result.error,
  };

  if (result.error) {
    throw new CompatibilityRuntimeError(
      `unable to execute ${binary.command}: ${result.error.message}`,
      evidence,
    );
  }
  if (result.signal) {
    throw new CompatibilityRuntimeError(
      `compatibility runtime terminated by ${result.signal}`,
      evidence,
    );
  }
  if (result.status !== 0) {
    const detail = evidence.stderr.trim();
    throw new CompatibilityRuntimeError(
      `compatibility runtime exited with status ${result.status}${detail ? `: ${detail}` : ""}`,
      evidence,
    );
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (cause) {
    throw new CompatibilityRuntimeError(
      `compatibility runtime returned invalid JSON: ${cause.message}`,
      { ...evidence, cause },
    );
  }
  return {
    data,
    command: binary.command,
    provider: binary.source,
    record: binary.record,
  };
}

export function runHostRuntime(args, deps = {}) {
  const env = deps.env ?? process.env;
  const errLog = deps.errLog ?? console.error;
  const spawn = deps.spawn ?? spawnSync;
  let binary;
  try {
    binary = resolveHostRuntime({ env });
  } catch (error) {
    if (!(error instanceof RuntimeProviderError)) throw error;
    errLog(`cloister: ${error.message}`);
    if (!/cloister runtime install/.test(error.message)) {
      errLog("Run: cloister runtime install");
    }
    return 2;
  }
  const result = spawn(binary.command, args, { stdio: "inherit", env });
  if (result.error) {
    errLog(
      `cloister: unable to execute ${binary.command}: ${result.error.message}`,
    );
    errLog("Run: cloister runtime install");
    return 2;
  }
  if (result.signal) {
    errLog(`cloister: host runtime terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}
