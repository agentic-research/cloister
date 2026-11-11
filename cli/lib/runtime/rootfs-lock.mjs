// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/runtime/rootfs-lock.mjs — the imported microVM rootfs, recorded in
// cluster.lock.toml next to the image it was imported from (cloister-991e65).
//
// A bundle's image is pinned by `[inputs.<bundle>.oci] digest` (sha256, an OCI
// fact). The microVM tier runs a CAS rootfs named by `blake3-256:` over its
// manifest — a different identity, derived from the image by LLO's importer.
// The lock records the derivation's result beside its input:
//
//   [inputs.<bundle>.oci]
//   identifier = "…"
//   digest = "sha256:…"            # the image (resolver / pin)
//   rootfs = "blake3-256:…"        # what `runtime import --bundle` produced from it
//   rootfsSymlinks = "resolve"     # only when not the default "refuse"
//
// `rootfsSymlinks` is recorded because the symlink policy changes the tree,
// hence the rootfs digest: the same image imported two ways is two rootfs.
// "refuse" is LLO's and the importer's default, so it is omitted.
//
// The source of the import is an on-disk OCI layout today (LLO v0.28.0 has no
// registry fetch). A registry source (cloister-727354) changes where the blobs
// come from, not this record: the rootfs is still a function of the pinned
// digest and the symlink policy.

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const ROOTFS_KEY = "rootfs";
export const SYMLINKS_KEY = "rootfsSymlinks";
export const DEFAULT_SYMLINKS = "refuse";
export const SYMLINK_MODES = Object.freeze(["refuse", "resolve"]);

const BLAKE3_PREFIX = "blake3-256:";
const HEX = "0123456789abcdef";

/** True for `blake3-256:` + 64 lowercase hex. Char scan, no regex. */
export function isBlake3Digest(value) {
  if (typeof value !== "string" || !value.startsWith(BLAKE3_PREFIX)) return false;
  const hex = value.slice(BLAKE3_PREFIX.length);
  if (hex.length !== 64) return false;
  for (const ch of hex) if (!HEX.includes(ch)) return false;
  return true;
}

/** The hex part of a `blake3-256:` digest — the CAS directory name. */
export function rootfsHex(digest) {
  return digest.slice(BLAKE3_PREFIX.length);
}

/** `[inputs.<bundle>.oci]` from a parsed lock, or null. */
export function lockedOci(lock, bundle) {
  const oci = lock?.inputs?.[bundle]?.oci;
  return oci && typeof oci === "object" ? oci : null;
}

/** The recorded rootfs for `bundle`: `{rootfs, symlinks}` or null. */
export function lockedRootfs(lock, bundle) {
  const oci = lockedOci(lock, bundle);
  if (!oci || oci[ROOTFS_KEY] === undefined) return null;
  return { rootfs: oci[ROOTFS_KEY], symlinks: oci[SYMLINKS_KEY] ?? DEFAULT_SYMLINKS };
}

/** The exact command that records `bundle`'s rootfs, for refusal messages. */
export function importCommand(bundle, dir, symlinks = DEFAULT_SYMLINKS) {
  const parts = ["cloister runtime import", "--bundle", bundle];
  if (dir && dir !== ".") parts.push("--dir", dir);
  parts.push("--layout", "<oci-layout-dir>");
  if (symlinks !== DEFAULT_SYMLINKS) parts.push("--symlinks", symlinks);
  return parts.join(" ");
}

/**
 * Record an import result in the lock text. Pure: returns the new text and
 * whether anything changed (idempotent — re-importing the same image with the
 * same policy yields the same rootfs and an unchanged lock).
 *
 * Refuses when the lock does not pin `bundle`'s image, or the import was of a
 * different image than the one pinned.
 *
 * @param {string} lockText
 * @param {{bundle: string, image: string, rootfs: string, symlinks: string}} rec
 * @returns {{text: string, changed: boolean, previous: string|null}}
 */
export function recordRootfs(lockText, { bundle, image, rootfs, symlinks }) {
  const lock = parseToml(lockText);
  const oci = lockedOci(lock, bundle);
  if (!oci || typeof oci.digest !== "string" || oci.digest === "") {
    throw new Error(
      `cluster.lock.toml pins no image for bundle "${bundle}" ([inputs.${bundle}.oci] digest); ` +
        `resolve or pin it before importing`,
    );
  }
  if (image !== oci.digest) {
    throw new Error(
      `--image ${image} is not bundle "${bundle}"'s locked image ${oci.digest}; ` +
        `the rootfs recorded in the lock must come from the pinned image`,
    );
  }
  if (!isBlake3Digest(rootfs)) {
    throw new Error(`the importer returned rootfs ${JSON.stringify(rootfs)}, not a blake3-256 digest`);
  }
  if (!SYMLINK_MODES.includes(symlinks)) {
    throw new Error(`--symlinks must be one of ${SYMLINK_MODES.join(", ")}, not ${JSON.stringify(symlinks)}`);
  }
  const previous = oci[ROOTFS_KEY] ?? null;
  const previousSymlinks = oci[SYMLINKS_KEY] ?? DEFAULT_SYMLINKS;
  if (previous === rootfs && previousSymlinks === symlinks) {
    return { text: lockText, changed: false, previous };
  }
  oci[ROOTFS_KEY] = rootfs;
  if (symlinks === DEFAULT_SYMLINKS) delete oci[SYMLINKS_KEY];
  else oci[SYMLINKS_KEY] = symlinks;
  return { text: stringifyToml(lock), changed: true, previous };
}

/**
 * Carry a recorded rootfs forward across a lock regeneration (`cluster
 * resolve`), but only while the image it was imported from is unchanged. A new
 * image digest drops it: that rootfs is no longer derived from what is pinned,
 * and `runtime plan` then asks for a fresh import by name.
 *
 * @param {object} previousOci the old lock's `[inputs.<n>.oci]`, or undefined
 * @param {object} nextOci the freshly resolved row (mutated and returned)
 */
export function carryRootfs(previousOci, nextOci) {
  if (!previousOci || !nextOci) return nextOci;
  if (previousOci[ROOTFS_KEY] === undefined) return nextOci;
  if (!nextOci.digest || previousOci.digest !== nextOci.digest) return nextOci;
  nextOci[ROOTFS_KEY] = previousOci[ROOTFS_KEY];
  if (previousOci[SYMLINKS_KEY] !== undefined) nextOci[SYMLINKS_KEY] = previousOci[SYMLINKS_KEY];
  return nextOci;
}
