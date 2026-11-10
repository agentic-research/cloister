// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { arch as hostArch } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

/**
 * Where Homebrew puts libkrunfw. Probed ONCE, at install, and the resolved path
 * and digest are recorded — so the run-time grant names a file the operator saw
 * named here, never a path guessed per run (host-runtime main.rs refuses to
 * guess for the same reason: the path is granted into the worker's
 * confinement). `CLOISTER_LIBKRUNFW` overrides.
 */
export const LIBKRUNFW_CANDIDATES = [
  "/opt/homebrew/lib/libkrunfw.5.dylib",
  "/usr/local/lib/libkrunfw.5.dylib",
];

function defaultFindLibkrunfw(env) {
  const candidates = env.CLOISTER_LIBKRUNFW ? [env.CLOISTER_LIBKRUNFW] : LIBKRUNFW_CANDIDATES;
  const found = candidates.find((c) => existsSync(c));
  return found ? realpathSync(found) : null;
}

async function defaultFetchKrunWorker(root, target) {
  const { ensureBinary } = await import(resolve(root, "scripts/fetch-schema-bridge.mjs"));
  return ensureBinary("leyline-krun-worker", { target });
}

/**
 * Provide the microVM tier: LLO's krun worker (digest-pinned release asset),
 * the content store and run roots, and the libkrunfw the guest kernel comes
 * from (cloister-991e65). Before this, `runtime install` built a host runtime
 * whose microVM backend looked for a worker at /usr/local/libexec and a store
 * under /var/lib that nothing created, so `doctor` answered microvm=false on
 * every install.
 *
 * Returns the record section, or `{ unavailable: reason }`. A host that cannot
 * have the tier still gets the harness lane; the reason is printed, never
 * swallowed.
 */
async function installMicrovm({ root, layout, platform, arch, env, fetchKrunWorker, findLibkrunfw }) {
  if (platform !== "darwin" || arch !== "arm64") {
    return { unavailable: `LLO publishes leyline-krun-worker for darwin-arm64 only (this host is ${platform}-${arch})` };
  }
  const libkrunfw = findLibkrunfw(env);
  if (!libkrunfw) {
    const looked = env.CLOISTER_LIBKRUNFW
      ? `CLOISTER_LIBKRUNFW=${env.CLOISTER_LIBKRUNFW} does not exist`
      : `looked in ${LIBKRUNFW_CANDIDATES.join(", ")}`;
    return {
      unavailable: `libkrunfw not found (${looked}). ` +
        "Install it (brew install libkrunfw) or set CLOISTER_LIBKRUNFW, then re-run cloister runtime install",
    };
  }
  let fetched;
  try {
    fetched = await fetchKrunWorker(root, "darwin-arm64");
  } catch (error) {
    throw new CompatibilityInstallError(
      `could not provide leyline-krun-worker: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A plain byte copy keeps the embedded code signature, which carries the
  // com.apple.security.hypervisor entitlement the worker needs.
  copyExecutableAtomic(fetched, layout.krunWorker);
  for (const dir of [layout.casRoot, layout.runRoot]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return {
    section: {
      krunWorker: { file: basename(layout.krunWorker), sha256: sha256File(layout.krunWorker) },
      libkrunfw: { path: libkrunfw, sha256: sha256File(libkrunfw) },
      casRoot: layout.casRoot,
      runRoot: layout.runRoot,
    },
  };
}

export async function installCompatibilityProvider({
  root,
  layout,
  spawn = defaultSpawn,
  platform = process.platform,
  arch = hostArch(),
  env = process.env,
  fetchKrunWorker = defaultFetchKrunWorker,
  findLibkrunfw = defaultFindLibkrunfw,
  log = () => {},
} = {}) {
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

  const microvm = await installMicrovm({
    root, layout, platform, arch, env, fetchKrunWorker, findLibkrunfw,
  });
  if (microvm.unavailable) log(`microVM tier unavailable: ${microvm.unavailable}`);

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
    ...(microvm.section ? { microvm: microvm.section } : {}),
  };

  // The record is the selection point. Publish it only after every executable
  // copy and every digest is complete, so a partial install is never chosen.
  writeGeneratedFile(layout.providerRecord, `${JSON.stringify(record, null, 2)}\n`);
  return readProviderRecord(layout);
}
