// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister runtime import --bundle <name> [--dir <cluster>] --layout <dir>
//  [--image sha256:…] [--symlinks refuse|resolve]` (cloister-991e65).
//
// Imports the bundle's PINNED image from an on-disk OCI layout into the
// microVM CAS (through the host runtime's `import-oci`, i.e. LLO's importer)
// and records the resulting rootfs in cluster.lock.toml beside the image pin,
// which is what `runtime plan` and `cluster up` run.
//
// The image is the lock's `[inputs.<bundle>.oci] digest`. `--image` may be
// omitted (it is derived from the lock); if given it must equal that digest,
// so the recorded rootfs can only ever come from the pinned image.
//
// Idempotent: the same image and symlink policy give the same rootfs, and an
// unchanged lock is not rewritten.
//
// Without --bundle, `runtime import` is the raw importer (cli/index.mjs) and
// writes nothing.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { runCompatibilityJson } from "../lib/runtime/compatibility-client.mjs";
import {
  DEFAULT_SYMLINKS,
  SYMLINK_MODES,
  lockedOci,
  recordRootfs,
} from "../lib/runtime/rootfs-lock.mjs";

export class ImportUsageError extends Error {}

export function parseImportArgs(argv) {
  const out = { bundle: null, dir: ".", layout: null, image: null, symlinks: DEFAULT_SYMLINKS };
  const flags = { "--bundle": "bundle", "--dir": "dir", "--layout": "layout", "--image": "image", "--symlinks": "symlinks" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key) throw new ImportUsageError(`unknown argument ${JSON.stringify(argv[i])}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ImportUsageError(`${argv[i]} requires a value`);
    out[key] = value;
    i += 1;
  }
  if (!out.bundle) throw new ImportUsageError("--bundle is required");
  if (!out.layout) throw new ImportUsageError("--layout <oci-layout-dir> is required");
  if (!SYMLINK_MODES.includes(out.symlinks)) {
    throw new ImportUsageError(`--symlinks must be one of ${SYMLINK_MODES.join(", ")}`);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {{log?, errLog?, env?, importOci?: (args: string[]) => any}} deps
 *   `importOci` runs the host runtime's importer and returns its JSON record
 *   (injected by tests).
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const env = deps.env ?? process.env;
  let args;
  try {
    args = parseImportArgs(argv);
  } catch (error) {
    errLog(`cloister runtime import: ${error.message}`);
    return 2;
  }
  try {
    const lockPath = resolve(args.dir, "cluster.lock.toml");
    if (!existsSync(lockPath)) {
      throw new Error(`no cluster.lock.toml in ${resolve(args.dir)}; --bundle records into the cluster's lock`);
    }
    const lockText = readFileSync(lockPath, "utf8");
    const oci = lockedOci(parseToml(lockText), args.bundle);
    if (!oci?.digest) {
      throw new Error(
        `cluster.lock.toml pins no image for bundle "${args.bundle}" ([inputs.${args.bundle}.oci] digest); ` +
          `resolve or pin it before importing`,
      );
    }
    const image = args.image ?? oci.digest;
    if (image !== oci.digest) {
      throw new Error(
        `--image ${image} is not bundle "${args.bundle}"'s locked image ${oci.digest}; ` +
          `the rootfs recorded in the lock must come from the pinned image`,
      );
    }
    const importOci = deps.importOci ?? ((a) => runCompatibilityJson(a, { env }).data);
    const record = importOci(["import-oci", "--layout", args.layout, "--image", image, "--symlinks", args.symlinks]);
    const algorithm = record?.rootfs?.algorithm;
    const value = record?.rootfs?.value;
    const rootfs = `${algorithm}:${value}`;
    const result = recordRootfs(lockText, { bundle: args.bundle, image, rootfs, symlinks: args.symlinks });
    if (result.changed) {
      writeFileSync(lockPath, result.text);
      log(
        `cloister runtime import: ${args.bundle}: ${image} → ${rootfs}` +
          (result.previous ? ` (replaces ${result.previous})` : "") +
          `; recorded in ${lockPath}`,
      );
    } else {
      log(`cloister runtime import: ${args.bundle}: ${image} → ${rootfs}; already recorded`);
    }
    return 0;
  } catch (error) {
    errLog(`cloister runtime import: ${error.message}`);
    return 1;
  }
}
