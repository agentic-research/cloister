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

import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { writeGeneratedFile } from "../atomic-write.mjs";
import { carryRootfs } from "../runtime/rootfs-lock.mjs";

/**
 * Carry recorded rootfs rows (one per platform) from the lock currently at
 * `lockfilePath` into `doc` (mutated, returned). See `carryRootfs` for when
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
    if (row?.oci) carryRootfs(previous?.inputs?.[name]?.oci, row.oci);
  }
  return doc;
}

/** Write a regenerated lock document: carry recorded rootfs, then atomically. */
export function writeLockfile(lockfilePath, doc) {
  carryRootfsFromPreviousLock(lockfilePath, doc);
  writeGeneratedFile(lockfilePath, stringifyToml(doc));
}
