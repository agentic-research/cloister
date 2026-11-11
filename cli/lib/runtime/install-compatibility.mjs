// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
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

/**
 * Provision LLO's case-sensitive CAS volume through the just-installed host
 * runtime (`cloister-host-runtime provision-cas --state-dir <dir>`, which
 * calls LLO's in-process `CasVolume::provision`; cloister-727354). Returns the
 * parsed `ProvisionedCas` JSON. As the calling user: LLO uses `hdiutil`
 * unprivileged, so this never needs sudo.
 */
function defaultProvisionCas(hostRuntime, stateDir) {
  const result = spawnSync(hostRuntime, ["provision-cas", "--state-dir", stateDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new CompatibilityInstallError(
      `could not provision the CAS volume: ${result.error?.message ?? (result.stderr || `status ${result.status}`).trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new CompatibilityInstallError(
      `could not provision the CAS volume: the host runtime printed no JSON (${error.message}): ${result.stdout.slice(0, 200)}`,
    );
  }
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
/**
 * Prepare the microVM tier WITHOUT touching the installed files: fetch the
 * worker, and provision the CAS volume with the FRESHLY BUILT host runtime.
 * Nothing is swapped into place here; on any failure the previous install is
 * left exactly as it was (#290 review: provisioning after the swap left a new
 * binary beside the old record, and every command then died on "digest
 * mismatch"). `commit()` copies the worker into place.
 */
async function prepareMicrovm({ root, layout, platform, arch, env, fetchKrunWorker, findLibkrunfw, provisionCas, builtHostRuntime, log }) {
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
  // THE one place the CAS root is decided (cloister-727354): LLO's
  // case-sensitive volume under cloister's state dir. Everything downstream —
  // the host runtime's CLOISTER_CAS_ROOT, `runtime plan`'s presence check,
  // `storage status` — reads it from the record written here. A
  // case-insensitive store (default APFS) refused Debian images that ship
  // names differing only by case (perl's Pod/ and pod/).
  let cas;
  try {
    cas = provisionCas(builtHostRuntime, layout.stateDir);
  } catch (error) {
    throw new CompatibilityInstallError(
      `${error instanceof Error ? error.message : String(error)}\n` +
        "The existing install was left unchanged. The volume is created as you with " +
        "/usr/bin/hdiutil (no sudo): check that hdiutil works for this user and that the " +
        `disk holding ${layout.stateDir} has space, then re-run cloister runtime install.`,
    );
  }
  if (!cas?.casRoot || cas.filesystem?.caseSensitive !== true) {
    throw new CompatibilityInstallError(
      `LLO provisioned a CAS root that is not case-sensitive: ${JSON.stringify(cas)}`,
    );
  }
  log(
    `CAS volume: ${cas.casRoot} (case-sensitive; ${cas.created ? "created" : "existing"}` +
      `${cas.image ? `, image ${cas.image}` : ""})`,
  );
  // Each run's ephemeral rootfs is a copy of a CAS tree, so it must live on a
  // filesystem that keeps the same names apart: a Debian image's Pod/ and pod/
  // collided when the run root was on default APFS ("create ephemeral rootfs
  // directory: File exists", seen live with dolthub/dolt-sql-server). So the
  // run root goes on the same case-sensitive volume, beside the CAS root.
  // Derived from the volume LLO returned.
  if (!cas.mountpoint) {
    throw new CompatibilityInstallError(`LLO provisioned a CAS root with no volume mountpoint: ${JSON.stringify(cas)}`);
  }
  const runRoot = join(cas.mountpoint, "run");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  // The pre-volume store is neither migrated nor deleted: its trees are on a
  // case-insensitive filesystem, and copying them would carry that over.
  if (layout.casRoot !== cas.casRoot && existsSync(layout.casRoot) && readdirSync(layout.casRoot).length > 0) {
    log(
      `The previous store ${layout.casRoot} is no longer used and was left as it is. ` +
        "Re-import each microvm bundle into the new volume (`cloister runtime import --bundle <name> …`); " +
        "`runtime plan` names the exact command. Delete the old directory when you no longer need it.",
    );
  }
  return {
    // A plain byte copy keeps the embedded code signature, which carries the
    // com.apple.security.hypervisor entitlement the worker needs.
    commit: () => copyExecutableAtomic(fetched, layout.krunWorker),
    section: () => ({
      krunWorker: { file: basename(layout.krunWorker), sha256: sha256File(layout.krunWorker) },
      libkrunfw: { path: libkrunfw, sha256: sha256File(libkrunfw) },
      casRoot: cas.casRoot,
      casStateDir: layout.stateDir,
      runRoot,
    }),
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
  provisionCas = defaultProvisionCas,
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

  const builtHostRuntime = join(root, "rs/target/release/cloister-host-runtime");
  // Everything that can fail runs BEFORE anything is swapped into place.
  const microvm = await prepareMicrovm({
    root, layout, platform, arch, env, fetchKrunWorker, findLibkrunfw, provisionCas, builtHostRuntime, log,
  });
  if (microvm.unavailable) log(`microVM tier unavailable: ${microvm.unavailable}`);

  copyExecutableAtomic(
    join(root, "tools/harness-sandbox/target/release/cloister-harness"),
    layout.nativeHelper,
  );
  copyExecutableAtomic(builtHostRuntime, layout.hostRuntime);
  microvm.commit?.();

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
    ...(microvm.section ? { microvm: microvm.section() } : {}),
  };

  // The record is the selection point. Publish it only after every executable
  // copy and every digest is complete, so a partial install is never chosen.
  writeGeneratedFile(layout.providerRecord, `${JSON.stringify(record, null, 2)}\n`);
  return readProviderRecord(layout);
}
