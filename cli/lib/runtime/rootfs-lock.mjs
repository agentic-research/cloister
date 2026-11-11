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
//   rootfs = "blake3-256:…"        # what `runtime import --bundle` produced …
//   rootfsImage = "sha256:…"       # … from THIS image
//   rootfsSymlinks = "resolve"     # only when not the default "refuse"
//
// `rootfsImage` binds the rootfs to the image it came from by VALUE, not by
// position: a hand-edited `digest` can never run an old rootfs under a new
// image name, because plan / up compare the two and refuse when they differ.
// `rootfsSymlinks` is recorded because the symlink policy changes the tree,
// hence the rootfs digest; "refuse" is the importer's default and is omitted.
//
// The source of the import is an on-disk OCI layout or, since LLO v0.29.0, the
// pinned image pulled from its registry (cloister-727354). The source changes
// where the blobs come from, not this record: both give the same rootfs.

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export const ROOTFS_KEY = "rootfs";
export const ROOTFS_IMAGE_KEY = "rootfsImage";
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

/**
 * `[inputs.<bundle>.oci]` from a parsed lock, or null when the lock pins
 * nothing for `bundle`.
 *
 * Refuses (throws) when the bundle is pinned only through a multi-image
 * producer's `[[inputs.<input>.ociBundles]]` row: import / plan / up do not
 * support that shape yet, and treating it as "no pin" would send the operator
 * to resolve something that is already resolved.
 */
export function lockedOci(lock, bundle) {
  const oci = lock?.inputs?.[bundle]?.oci;
  if (oci && typeof oci === "object") return oci;
  for (const [input, row] of Object.entries(lock?.inputs ?? {})) {
    if ((row?.ociBundles ?? []).some((b) => b?.bundle === bundle)) {
      throw new Error(
        `bundle "${bundle}" is pinned through [[inputs.${input}.ociBundles]] (a multi-image ` +
          `producer), which runtime import / runtime plan / cluster up do not support yet`,
      );
    }
  }
  return null;
}

/**
 * The recorded rootfs for `bundle`: `{rootfs, image, symlinks}` or null.
 * `symlinks` is validated here, so a hand-edited value is refused before it
 * is ever echoed into a command line.
 */
export function lockedRootfs(lock, bundle) {
  const oci = lockedOci(lock, bundle);
  if (!oci || oci[ROOTFS_KEY] === undefined) return null;
  const symlinks = oci[SYMLINKS_KEY] ?? DEFAULT_SYMLINKS;
  if (!SYMLINK_MODES.includes(symlinks)) {
    throw new Error(
      `bundle "${bundle}" records ${SYMLINKS_KEY} = ${JSON.stringify(symlinks)} in cluster.lock.toml; ` +
        `it must be one of ${SYMLINK_MODES.join(", ")}`,
    );
  }
  return { rootfs: oci[ROOTFS_KEY], image: oci[ROOTFS_IMAGE_KEY] ?? null, symlinks };
}

/** The exact command that records `bundle`'s rootfs, for refusal messages. */
export function importCommand(bundle, dir, symlinks = DEFAULT_SYMLINKS) {
  const parts = ["cloister runtime import", "--bundle", bundle];
  if (dir && dir !== ".") parts.push("--dir", dir);
  // Optional since cloister-727354: without it the pinned image is pulled
  // from its registry.
  parts.push("[--layout <oci-layout-dir>]");
  if (symlinks !== DEFAULT_SYMLINKS) parts.push("--symlinks", symlinks);
  return parts.join(" ");
}

/**
 * Record an import result in the lock text. Pure: returns the new text and
 * whether anything changed (idempotent — re-importing the same image with the
 * same policy yields the same rootfs and an unchanged lock).
 *
 * Refuses when the lock does not pin `bundle`'s image, or the import was of a
 * different image than the one pinned in THIS text (callers pass the lock as
 * re-read after the import, so a pin that moved meanwhile is caught).
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
  if (previous === rootfs && previousSymlinks === symlinks && oci[ROOTFS_IMAGE_KEY] === image) {
    return { text: lockText, changed: false, previous };
  }
  oci[ROOTFS_KEY] = rootfs;
  oci[ROOTFS_IMAGE_KEY] = image;
  if (symlinks === DEFAULT_SYMLINKS) delete oci[SYMLINKS_KEY];
  else oci[SYMLINKS_KEY] = symlinks;
  return { text: stringifyToml(lock), changed: true, previous };
}

/**
 * Carry a recorded rootfs forward across a lock regeneration (`cluster
 * resolve`, `cloister add`, a demo re-pin), but only while the image it was
 * imported FROM (`rootfsImage`) is still the pinned digest. A moved pin drops
 * it, and `runtime plan` then asks for a fresh import by name. A row that
 * already carries a rootfs (a fresh import) is never overwritten.
 *
 * @param {object} previousOci the old lock's `[inputs.<n>.oci]`, or undefined
 * @param {object} nextOci the freshly built row (mutated and returned)
 */
export function carryRootfs(previousOci, nextOci) {
  if (!previousOci || !nextOci) return nextOci;
  if (nextOci[ROOTFS_KEY] !== undefined) return nextOci;
  if (previousOci[ROOTFS_KEY] === undefined) return nextOci;
  if (!nextOci.digest || previousOci[ROOTFS_IMAGE_KEY] !== nextOci.digest) return nextOci;
  nextOci[ROOTFS_KEY] = previousOci[ROOTFS_KEY];
  nextOci[ROOTFS_IMAGE_KEY] = previousOci[ROOTFS_IMAGE_KEY];
  if (previousOci[SYMLINKS_KEY] !== undefined) nextOci[SYMLINKS_KEY] = previousOci[SYMLINKS_KEY];
  return nextOci;
}
