// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/lockfile.mjs — the ONE function that writes a regenerated
// cluster.lock.toml (cloister-991e65).
//
// Every writer that rebuilds the lock from scratch (`cluster resolve`,
// `cloister add`, the demo's pin script) goes through `writeLockfile`, so none
// can skip the rootfs carry-forward: a rootfs recorded by `runtime import
// --bundle` is not something a resolver can re-derive, and a writer that
// forgot to carry it silently erased it (`cloister add` did). The write is
// atomic (temp + rename), so a concurrent reader never sees half a lock.
//
// `runtime import --bundle` does not regenerate; it edits one row of the lock
// it re-read after importing, and writes that with the same atomic writer.
//
// The carry rule is core's, not a driver's (ADR-0081): a record a driver
// derives from a pinned image follows that image's digest. A hook the driver
// registered would be skipped by any writer that never loads the driver,
// which is the silent erasure this module exists to prevent.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { writeGeneratedFile } from "../atomic-write.mjs";

/** The microVM driver's rootfs rows, one per guest platform (cli/lib/runtime/rootfs-lock.mjs). */
export const ROOTFS_KEY = "rootfs";
/** That driver's flat, platform-less keys from before cloister-1c4ef5. */
export const LEGACY_ROOTFS_KEYS = Object.freeze(["rootfsImage", "rootfsSymlinks"]);
const DERIVED_KEYS = Object.freeze([ROOTFS_KEY, ...LEGACY_ROOTFS_KEYS]);

/**
 * Carry the records derived from a pinned image across a lock regeneration
 * (`cluster resolve`, `cloister add`, a demo re-pin):
 *   - a row that carries its own rootfs rows (a fresh import) keeps them, and
 *     takes nothing from the old row;
 *   - a pin that moved, or that either row lacks, carries nothing, because
 *     each record is a derivation of the pinned image. The driver that made
 *     it then asks for a fresh one by name (`runtime plan` does);
 *   - otherwise every record the old row holds is carried, and a record the
 *     new row holds wins over the old row's.
 * Nothing else is dropped. A flat pre-cloister-1c4ef5 record is carried as it
 * is, so plan can refuse it by name rather than report it missing.
 *
 * #366 moved this from the microVM driver (`carryRootfs`) and changed its
 * guard to skip the carry when the new row held any derived record, so a row
 * holding only a flat record lost the old row's rootfs rows. The guard is the
 * driver's again. Unlike the driver's version, a record the new row holds is
 * never overwritten; the driver overwrote a flat one.
 *
 * @param {object} previousPin the old lock's pin row (`[inputs.<n>.oci]`, or the
 *   `[[inputs.<input>.ociBundles]]` entry naming the same bundle), or undefined
 * @param {object} nextPin the freshly built row (mutated and returned)
 */
export function carryDerived(previousPin, nextPin) {
  if (!previousPin || !nextPin) return nextPin;
  if (nextPin[ROOTFS_KEY] !== undefined) return nextPin;
  if (!nextPin.digest || previousPin.digest !== nextPin.digest) return nextPin;
  for (const key of DERIVED_KEYS) {
    if (previousPin[key] !== undefined && nextPin[key] === undefined) nextPin[key] = structuredClone(previousPin[key]);
  }
  return nextPin;
}

/**
 * Carry recorded rootfs rows (one per platform) from the lock currently at
 * `lockfilePath` into `doc` (mutated, returned). See `carryDerived` for when
 * rows are kept.
 */
export function carryRootfsFromPreviousLock(lockfilePath, doc) {
  if (!existsSync(lockfilePath)) return doc;
  let previous;
  try {
    previous = parseToml(readFileSync(lockfilePath, "utf8"));
  } catch (e) {
    // The old lock is about to be replaced; an unparseable one carries
    // nothing forward, and saying so beats a silent drop.
    console.error(`cluster.lock.toml: previous lock unreadable, no rootfs carried forward: ${e.message}`);
    return doc;
  }
  for (const [name, row] of Object.entries(doc.inputs ?? {})) {
    const before = previous?.inputs?.[name];
    if (row?.oci) carryDerived(before?.oci, row.oci);
    // A multi-image producer's per-bundle pins hold their bundle's rows (see
    // lockedPin), and carry the same way. They are matched by the bundle each
    // names, never by position: a producer may list its bundles in any order.
    for (const entry of row?.ociBundles ?? []) {
      const prior = (before?.ociBundles ?? []).find((b) => b?.bundle === entry?.bundle);
      carryDerived(prior, entry);
    }
  }
  return doc;
}

/** Write a regenerated lock document: carry recorded rootfs, then atomically. */
export function writeLockfile(lockfilePath, doc) {
  carryRootfsFromPreviousLock(lockfilePath, doc);
  writeGeneratedFile(lockfilePath, stringifyToml(doc));
}
