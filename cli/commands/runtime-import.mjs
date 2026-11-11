// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister runtime import --bundle <name> [--dir <cluster>] [--layout <dir>]
//  [--image sha256:…] [--symlinks refuse|resolve]` (cloister-991e65).
//
// With --layout the image comes from an on-disk OCI layout; without it, the
// lock's pinned `identifier@sha256:…` is pulled from its registry through
// LLO's in-process importer (anonymous HTTPS; cloister-727354). Either way it
// lands in the CAS the provider record names, re-attached first.
//
// Imports the bundle's PINNED image (from a layout or its registry) into the
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

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { runCompatibilityJson } from "../lib/runtime/compatibility-client.mjs";
import { prepareCas } from "../lib/runtime/cas-root.mjs";
import { writeGeneratedFile } from "../lib/atomic-write.mjs";
import { isSha256Digest } from "../lib/oci-artifact.mjs";
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
  // No --layout: pull the pinned image from its registry (cloister-727354).
  if (!SYMLINK_MODES.includes(out.symlinks)) {
    throw new ImportUsageError(`--symlinks must be one of ${SYMLINK_MODES.join(", ")}`);
  }
  return out;
}

/**
 * The registry reference for a lock-pinned image: `identifier@digest`. Only a
 * digest pin is pulled: the identifier must be a bare repository name (no tag,
 * no digest of its own) and the digest a full sha256, so what is fetched is
 * exactly what the lock pins. LLO pulls anonymously over HTTPS; a private
 * image is refused by its registry and reported as such (no credentials in
 * this slice).
 */
export function registryReference(bundle, oci) {
  const identifier = typeof oci.identifier === "string" ? oci.identifier.trim() : "";
  if (!identifier) {
    throw new Error(`bundle "${bundle}" has no [inputs.${bundle}.oci] identifier to pull from`);
  }
  const lastSegment = identifier.slice(identifier.lastIndexOf("/") + 1);
  if (identifier.includes("@") || lastSegment.includes(":")) {
    throw new Error(
      `bundle "${bundle}"'s identifier ${JSON.stringify(identifier)} carries a tag or digest of its own; ` +
        `a registry pull uses only the bare repository name plus the locked digest`,
    );
  }
  if (!isSha256Digest(oci.digest)) {
    throw new Error(
      `bundle "${bundle}" is not pinned by an immutable sha256 digest (${JSON.stringify(oci.digest)}); ` +
        `an unpinned or tag-only image is never pulled`,
    );
  }
  return `${identifier}@${oci.digest}`;
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
    // The CAS the import lands in: the recorded one, re-attached if a reboot
    // detached it; a disagreeing CLOISTER_CAS_ROOT is refused here, not after
    // a download (cloister-727354).
    (deps.prepareCas ?? prepareCas)({ env, warn: errLog });
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
    const source = args.layout
      ? ["--layout", args.layout, "--image", image]
      : ["--from-registry", registryReference(args.bundle, oci)];
    const record = importOci(["import-oci", ...source, "--symlinks", args.symlinks]);
    const algorithm = record?.rootfs?.algorithm;
    const value = record?.rootfs?.value;
    const rootfs = `${algorithm}:${value}`;
    // The import can take a while. Record into the lock as it is NOW, not the
    // text read before it: if the pin moved meanwhile (a resolve, an edit),
    // recordRootfs refuses — this rootfs is not from the image now pinned.
    const current = readFileSync(lockPath, "utf8");
    if (lockedOci(parseToml(current), args.bundle)?.digest !== image) {
      throw new Error(
        `bundle "${args.bundle}"'s pin changed in cluster.lock.toml while importing ` +
          `(was ${image}); the rootfs was NOT recorded. Re-run the import against the new pin.`,
      );
    }
    const result = recordRootfs(current, { bundle: args.bundle, image, rootfs, symlinks: args.symlinks });
    if (result.changed) {
      writeGeneratedFile(lockPath, result.text);
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
