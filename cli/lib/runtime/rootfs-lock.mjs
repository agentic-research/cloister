// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/runtime/rootfs-lock.mjs — the imported microVM rootfs, recorded in
// cluster.lock.toml next to the image it was imported from, one row per guest
// platform (cloister-991e65, cloister-1c4ef5).
//
// A bundle's image is pinned by `[inputs.<bundle>.oci] digest` (sha256, an OCI
// fact, often a multi-platform index). The microVM tier runs a CAS rootfs
// named by `blake3-256:` over its manifest — a different identity, derived
// from the image by LLO's importer FOR ONE PLATFORM: the importer selects the
// host's platform from the index. So the lock records one row per platform:
//
//   [inputs.<bundle>.oci]
//   identifier = "…"
//   digest = "sha256:…"              # the image (resolver / pin)
//
//   [[inputs.<bundle>.oci.rootfs]]
//   platform = "linux/arm64"         # as LLO reported it from the image config
//   digest = "blake3-256:…"          # what `runtime import --bundle` produced …
//   image = "sha256:…"               # … from THIS image
//   symlinks = "resolve"             # only when not the default "preserve"
//
// `platform` is never typed: `runtime import` records what LLO reports for the
// image it imported (`image.platform`, from the digest-verified config), and
// `runtime plan` / `cluster up` select the row this host's guest platform
// admits (platform.mjs, guest-platform.mjs). Importing on one platform adds or replaces only
// that platform's row.
//
// `image` binds a row to the image it came from by VALUE, not by position: a
// hand-edited `digest` can never run an old rootfs under a new image name,
// because plan / up compare the two and refuse when they differ. `symlinks` is
// recorded because the symlink policy changes the tree, hence the rootfs
// digest; "preserve" (links kept as links, rootfs manifest v2) is the
// importer's default since LLO v0.30.0 and is omitted.
//
// The flat shape before cloister-1c4ef5 (`rootfs = "blake3-256:…"`,
// `rootfsImage`, `rootfsSymlinks`) is refused by name and never migrated: it
// does not say which platform its rootfs is for. A re-import replaces it.
//
// The source of the import is an on-disk OCI layout or the pinned image pulled
// from its registry (cloister-727354). The source changes where the blobs come
// from, not this record: both give the same rootfs.

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { isPlatform, platformAdmits, platformsOverlap } from "./platform.mjs";

export const ROOTFS_KEY = "rootfs";
export const DEFAULT_SYMLINKS = "preserve";
export const SYMLINK_MODES = Object.freeze(["preserve", "refuse", "resolve"]);
/** Keys of the flat, platform-less shape before cloister-1c4ef5. */
export const LEGACY_KEYS = Object.freeze(["rootfsImage", "rootfsSymlinks"]);

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

/** The flat, platform-less keys `oci` carries (`rootfsImage`, `rootfsSymlinks`). */
function legacyKeysIn(oci) {
  return LEGACY_KEYS.filter((k) => oci?.[k] !== undefined);
}

/** True when `oci` carries the flat, platform-less rootfs shape and no rows. */
function isLegacyShape(oci) {
  return !Array.isArray(oci?.[ROOTFS_KEY]) &&
    (typeof oci?.[ROOTFS_KEY] === "string" || legacyKeysIn(oci).length > 0);
}

/**
 * Refuse rows AND flat keys in one `[inputs.<bundle>.oci]`. Neither shape can
 * be trusted over the other (a hand merge, or an old writer touching a new
 * lock), and an import must not collapse them: that would drop other
 * platforms' rows.
 */
function assertNotMixed(oci, bundle) {
  const stray = legacyKeysIn(oci);
  if (Array.isArray(oci?.[ROOTFS_KEY]) && stray.length > 0) {
    throw new Error(
      `bundle "${bundle}" records BOTH [[inputs.${bundle}.oci.${ROOTFS_KEY}]] rows and the old flat ` +
        `key(s) ${stray.join(", ")} in [inputs.${bundle}.oci]. A lock holds one shape; the rows are ` +
        `the current one. Remove ${stray.join(" and ")} from [inputs.${bundle}.oci] by hand, after ` +
        `checking the rows are what you expect.`,
    );
  }
}

/**
 * The recorded rootfs rows for `bundle`: `[{platform, digest, image,
 * symlinks}]`, empty when none is recorded.
 *
 * Checked here, for every row: that `rootfs` is a list; that `platform` is
 * `os/architecture[/variant]` and appears once; and that `symlinks` is a
 * known mode — so a hand-edited value is refused before it is echoed into a
 * command line. NOT checked here: `digest` (blake3-256) and `image` (equal to
 * the pin), which `runtime plan` checks on the row it selects.
 *
 * Refuses by name the flat pre-cloister-1c4ef5 shape (with the command that
 * replaces it) and a mix of rows and flat keys.
 */
export function lockedRootfsRows(lock, bundle, { dir } = {}) {
  const oci = lockedOci(lock, bundle);
  assertNotMixed(oci, bundle);
  if (!oci || oci[ROOTFS_KEY] === undefined && !isLegacyShape(oci)) return [];
  if (isLegacyShape(oci)) {
    const symlinks = SYMLINK_MODES.includes(oci.rootfsSymlinks) ? oci.rootfsSymlinks : DEFAULT_SYMLINKS;
    throw new Error(
      `bundle "${bundle}" records its rootfs in the old flat shape ([inputs.${bundle}.oci] ` +
        `${ROOTFS_KEY} = "…" / rootfsImage), which does not say which platform it is for, so it ` +
        `is not migrated. Re-import on each platform you run it on; that replaces it with ` +
        `[[inputs.${bundle}.oci.${ROOTFS_KEY}]] rows:\n  ${importCommand(bundle, dir, symlinks)}`,
    );
  }
  const rows = oci[ROOTFS_KEY];
  if (!Array.isArray(rows)) {
    throw new Error(`bundle "${bundle}"'s [inputs.${bundle}.oci] ${ROOTFS_KEY} must be a list of rows`);
  }
  const seen = new Set();
  return rows.map((row, i) => {
    const where = `[[inputs.${bundle}.oci.${ROOTFS_KEY}]] row ${i + 1}`;
    if (!isPlatform(row?.platform)) {
      throw new Error(`${where} has platform ${JSON.stringify(row?.platform)}, not os/architecture[/variant]`);
    }
    if (seen.has(row.platform)) {
      throw new Error(`${where} repeats platform ${row.platform}; each platform has one row`);
    }
    seen.add(row.platform);
    const symlinks = row.symlinks ?? DEFAULT_SYMLINKS;
    if (!SYMLINK_MODES.includes(symlinks)) {
      throw new Error(
        `${where} records symlinks = ${JSON.stringify(symlinks)}; it must be one of ${SYMLINK_MODES.join(", ")}`,
      );
    }
    return { platform: row.platform, digest: row.digest, image: row.image ?? null, symlinks };
  });
}

/**
 * The row this host's guest platform runs, or null when there is none.
 * Refuses when more than one row is admitted (`linux/arm64` and
 * `linux/arm64/v8` both recorded): picking one would be a guess.
 */
export function selectRootfs(rows, guestPlatform, bundle) {
  const admitted = rows.filter((row) => platformAdmits(guestPlatform, row.platform));
  if (admitted.length > 1) {
    throw new Error(
      `bundle "${bundle}" records more than one rootfs this host's guest platform ` +
        `${guestPlatform} runs (${admitted.map((r) => r.platform).join(", ")}); keep one`,
    );
  }
  return admitted[0] ?? null;
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
 * Adds or replaces ONLY the row(s) for `platform`: every row whose platform
 * overlaps it (`linux/arm64` and `linux/arm64/v8`, which one host would both
 * select) is replaced, so a re-import repairs what plan would refuse as
 * ambiguous. Every other platform's row is kept. A flat pre-cloister-1c4ef5
 * record is replaced (the fresh import says which platform it is for; the old
 * one did not). Rows mixed with flat keys are refused, never collapsed.
 *
 * Refuses when the lock does not pin `bundle`'s image, the import was of a
 * different image than the one pinned in THIS text (callers pass the lock as
 * re-read after the import, so a pin that moved meanwhile is caught), or the
 * importer reported no platform.
 *
 * @param {string} lockText
 * @param {{bundle: string, image: string, rootfs: string, symlinks: string, platform: string}} rec
 * @returns {{text: string, changed: boolean, previous: string|null}}
 */
export function recordRootfs(lockText, { bundle, image, rootfs, symlinks, platform }) {
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
  if (!isPlatform(platform)) {
    throw new Error(
      `the importer reported no platform for the rootfs it built (${JSON.stringify(platform)}); ` +
        `the rootfs was NOT recorded, because a row must say which platform it is for`,
    );
  }
  if (!SYMLINK_MODES.includes(symlinks)) {
    throw new Error(`--symlinks must be one of ${SYMLINK_MODES.join(", ")}, not ${JSON.stringify(symlinks)}`);
  }
  const row = { platform, digest: rootfs, image };
  if (symlinks !== DEFAULT_SYMLINKS) row.symlinks = symlinks;

  assertNotMixed(oci, bundle);
  if (isLegacyShape(oci)) {
    const previous = typeof oci[ROOTFS_KEY] === "string" ? oci[ROOTFS_KEY] : null;
    for (const key of LEGACY_KEYS) delete oci[key];
    oci[ROOTFS_KEY] = [row];
    return { text: stringifyToml(lock), changed: true, previous };
  }
  const rows = Array.isArray(oci[ROOTFS_KEY]) ? oci[ROOTFS_KEY] : [];
  const replaced = rows.filter((r) => platformsOverlap(r?.platform, platform));
  const [only] = replaced;
  if (
    replaced.length === 1 &&
    only.platform === platform &&
    only.digest === rootfs &&
    only.image === image &&
    (only.symlinks ?? DEFAULT_SYMLINKS) === symlinks
  ) {
    return { text: lockText, changed: false, previous: only.digest };
  }
  const next = rows.filter((r) => !replaced.includes(r));
  next.push(row);
  next.sort((x, y) => (x.platform < y.platform ? -1 : x.platform > y.platform ? 1 : 0));
  oci[ROOTFS_KEY] = next;
  return {
    text: stringifyToml(lock),
    changed: true,
    previous: replaced.length ? replaced.map((r) => r.digest).join(", ") : null,
  };
}

/**
 * Carry recorded rootfs rows forward across a lock regeneration (`cluster
 * resolve`, `cloister add`, a demo re-pin): EVERY row while the image pin is
 * unchanged, NONE when it moved — a row is a derivation of the pinned image,
 * and `runtime plan` then asks for a fresh import by name. A row that already
 * carries rootfs (a fresh import) is never overwritten. A flat
 * pre-cloister-1c4ef5 record is carried as it is, so plan can refuse it by
 * name rather than report it missing.
 *
 * @param {object} previousOci the old lock's `[inputs.<n>.oci]`, or undefined
 * @param {object} nextOci the freshly built row (mutated and returned)
 */
export function carryRootfs(previousOci, nextOci) {
  if (!previousOci || !nextOci) return nextOci;
  if (nextOci[ROOTFS_KEY] !== undefined) return nextOci;
  if (!nextOci.digest || previousOci.digest !== nextOci.digest) return nextOci;
  for (const key of [ROOTFS_KEY, ...LEGACY_KEYS]) {
    if (previousOci[key] !== undefined) nextOci[key] = structuredClone(previousOci[key]);
  }
  return nextOci;
}
