// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  constants,
  accessSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInstallLayout } from "../lib/install-layout.mjs";
import { renderCommandHelp } from "../surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export class InstallError extends Error {}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathInfo(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function linkTarget(link) {
  const target = readlinkSync(link);
  return resolve(dirname(link), target);
}

export function installCliLink(layout) {
  const source = resolve(layout.checkoutRoot, "bin/cloister.mjs");
  if (!isExecutable(source)) {
    throw new InstallError(`the Cloister command is not executable: ${source}`);
  }
  mkdirSync(layout.binDir, { recursive: true });
  const current = pathInfo(layout.cliLink);
  if (current && !current.isSymbolicLink()) {
    throw new InstallError(
      `refusing to overwrite ${layout.cliLink}: it exists and is not a symlink`,
    );
  }
  if (current && linkTarget(layout.cliLink) === source) return source;
  if (current) unlinkSync(layout.cliLink);
  symlinkSync(source, layout.cliLink);
  return source;
}

export function uninstallCliLink(layout) {
  const current = pathInfo(layout.cliLink);
  if (!current) return { removed: false, reason: "absent" };
  if (!current.isSymbolicLink()) {
    throw new InstallError(
      `refusing to remove ${layout.cliLink}: it exists and is not a symlink`,
    );
  }
  const expected = resolve(layout.checkoutRoot, "bin/cloister.mjs");
  const actual = linkTarget(layout.cliLink);
  if (actual !== expected) {
    throw new InstallError(
      `refusing to remove ${layout.cliLink}: it points to ${actual}, not this checkout`,
    );
  }
  unlinkSync(layout.cliLink);
  return { removed: true, reason: "owned" };
}

function verifyInstalledCommand(layout, root, env, spawn, args, label) {
  const result = spawn(layout.cliLink, args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result?.error) {
    throw new InstallError(`${label} could not start: ${result.error.message}`);
  }
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || "").trim();
    throw new InstallError(
      `${label} failed with exit ${result?.status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function binDirIsOnPath(binDir, env) {
  return String(env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry) === resolve(binDir));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? spawnSync;
  const [mode, ...rest] = argv;

  if ((mode === "install" || mode === "uninstall") && rest.some((arg) => arg === "--help" || arg === "-h")) {
    log(renderCommandHelp(mode));
    return 0;
  }
  if ((mode !== "install" && mode !== "uninstall") || rest.length > 0) {
    errLog(`cloister: expected install or uninstall, got ${JSON.stringify(argv.join(" "))}`);
    return 2;
  }

  const root = resolve(deps.root ?? ROOT);
  const layout = resolveInstallLayout({ env, checkoutRoot: root });
  try {
    if (mode === "uninstall") {
      const result = uninstallCliLink(layout);
      log(result.removed
        ? `cloister uninstall: removed ${layout.cliLink}`
        : `cloister uninstall: nothing installed at ${layout.cliLink}`);
      log(`cloister uninstall: kept the runtime files in ${layout.libexecDir}`);
      return 0;
    }

    const generate = deps.generateClusterArtifacts
      ?? (await import("../lib/cluster/generate.mjs")).generateClusterArtifacts;
    await generate({ root, env, warn: errLog });

    const installProvider = deps.installCompatibilityProvider
      ?? (await import("../lib/runtime/install-compatibility.mjs")).installCompatibilityProvider;
    const record = await installProvider({
      root,
      layout,
      spawn: deps.providerSpawn,
      platform: deps.platform,
    });

    const source = installCliLink(layout);
    verifyInstalledCommand(layout, root, env, spawn, ["--help"], "installed help check");
    verifyInstalledCommand(
      layout,
      root,
      env,
      spawn,
      ["run", "--dry-run", "--repo", root],
      "installed confined-run check",
    );

    log(`cloister install: ${layout.cliLink} -> ${source}`);
    log(
      `cloister install: ${record.provider} runtime (${record.maturity}) installed in ` +
      `${layout.libexecDir}`,
    );
    if (binDirIsOnPath(layout.binDir, env)) {
      log("cloister install: ready — try: cloister --help");
    } else {
      errLog(
        `cloister install: ${layout.binDir} is not on PATH. Add it to PATH, ` +
        `or set CLOISTER_BIN_DIR to a directory already there.`,
      );
    }
    return 0;
  } catch (error) {
    errLog(`cloister ${mode}: ${error.message}`);
    return 1;
  }
}
