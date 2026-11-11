#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { constants, accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstallLayout } from "../install-layout.mjs";
import {
  readProviderRecord,
  resolveMicrovm,
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

/**
 * The environment the host runtime is started with (cloister-991e65).
 *
 * cloister-host-runtime reads its microVM deployment facts from env, with
 * defaults (/usr/local/libexec, /var/lib/cloister) that `runtime install` never
 * populated. The installed record now names them, so they are passed here. An
 * explicitly set variable still wins: these are operator facts, and the
 * operator overriding one is a decision, not drift.
 *
 * DYLD_LIBRARY_PATH: libkrun inside the worker loads libkrunfw by bare name
 * ("libkrunfw.5.dylib"), so the granted absolute path is not what dlopen
 * searches, and the VM fails with "Couldn't find or load libkrunfw.5.dylib".
 * LLO's own hypervisor tests set the same variable. Tracked upstream as
 * ley-line-open-a267af; remove this line when the worker loads the path it is
 * granted.
 *
 * @param {any} record @param {Record<string, string|undefined>} env
 */
export function hostRuntimeEnv(record, env) {
  const microvm = resolveMicrovm(record);
  if (!microvm) return env;
  const out = { ...env };
  const set = (key, value) => { if (!out[key]) out[key] = value; };
  set("CLOISTER_KRUN_WORKER", microvm.krunWorker);
  set("CLOISTER_CAS_ROOT", microvm.casRoot);
  // The host runtime re-attaches the CAS volume from here (a reboot or logout
  // detaches it) and checks it is the CLOISTER_CAS_ROOT above.
  if (microvm.casStateDir) set("CLOISTER_CAS_STATE_DIR", microvm.casStateDir);
  set("CLOISTER_EPHEMERAL_ROOT", microvm.runRoot);
  set("CLOISTER_LIBKRUNFW", microvm.libkrunfw);
  set("DYLD_LIBRARY_PATH", dirname(microvm.libkrunfw));
  return out;
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
    env: binary.record ? hostRuntimeEnv(binary.record, env) : env,
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
    if (binary.record) binary.env = hostRuntimeEnv(binary.record, env);
  } catch (error) {
    if (!(error instanceof RuntimeProviderError)) throw error;
    errLog(`cloister: ${error.message}`);
    if (!/cloister runtime install/.test(error.message)) {
      errLog("Run: cloister runtime install");
    }
    return 2;
  }
  const result = spawn(binary.command, args, { stdio: "inherit", env: binary.env ?? env });
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
