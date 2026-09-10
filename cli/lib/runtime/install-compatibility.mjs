// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { writeGeneratedFile } from "../atomic-write.mjs";
import { PROVIDER_SCHEMA, readProviderRecord, sha256File } from "./provider-record.mjs";

export class CompatibilityInstallError extends Error {}

async function defaultSpawn(command, args, options) {
  return spawnSync(command, args, { ...options, stdio: "inherit" });
}

function describeBuild(args) {
  return args.includes("cloister-host-runtime")
    ? "cloister-host-runtime"
    : "cloister-harness";
}

async function runBuild(spawn, root, args) {
  const name = describeBuild(args);
  const result = await spawn("cargo", args, { cwd: root });
  if (result?.error) {
    throw new CompatibilityInstallError(`could not build ${name}: ${result.error.message}`);
  }
  if (result?.signal) {
    throw new CompatibilityInstallError(`could not build ${name}: cargo ended on ${result.signal}`);
  }
  if (result?.status !== 0) {
    throw new CompatibilityInstallError(
      `could not build ${name}: cargo exited ${result?.status ?? "without a status"}`,
    );
  }
}

function copyExecutableAtomic(source, destination) {
  if (!existsSync(source)) {
    throw new CompatibilityInstallError(`build succeeded but did not produce ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function installCompatibilityProvider({
  root,
  layout,
  spawn = defaultSpawn,
  platform = process.platform,
} = {}) {
  void platform;
  const nativeArgs = [
    "build", "--release", "--manifest-path", "tools/harness-sandbox/Cargo.toml",
  ];
  const hostArgs = [
    "build", "--release", "--manifest-path", "rs/Cargo.toml",
    "-p", "cloister-host-runtime",
    "--features", "llo-execution",
  ];

  await runBuild(spawn, root, nativeArgs);
  await runBuild(spawn, root, hostArgs);

  copyExecutableAtomic(
    join(root, "tools/harness-sandbox/target/release/cloister-harness"),
    layout.nativeHelper,
  );
  copyExecutableAtomic(
    join(root, "rs/target/release/cloister-host-runtime"),
    layout.hostRuntime,
  );

  const record = {
    schema: PROVIDER_SCHEMA,
    provider: "compatibility",
    maturity: "experimental",
    transport: "subprocess",
    apiVersion: "cloister/compatibility-runtime/v1",
    backends: ["nativeNonoCompatibility", "krunvmCompatibility"],
    artifacts: {
      nativeHelper: {
        file: "cloister-harness",
        sha256: sha256File(layout.nativeHelper),
      },
      hostRuntime: {
        file: "cloister-host-runtime",
        sha256: sha256File(layout.hostRuntime),
      },
    },
  };

  // The record is the selection point. Publish it only after both executable
  // copies and both digests are complete, so a partial install is never chosen.
  writeGeneratedFile(layout.providerRecord, `${JSON.stringify(record, null, 2)}\n`);
  return readProviderRecord(layout);
}
