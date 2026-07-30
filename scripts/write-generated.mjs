// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Atomic write for generated files.
//
// `writeFileSync` TRUNCATES and then fills, so between those two syscalls the
// file on disk is short or empty. Any concurrent reader observes that partial
// state — and a partially-written TypeScript module does not throw a helpful
// error, it fails whatever assertion happens to depend on its contents.
//
// The measured failure. `scripts/test/build-manifest-row-shape.test.mjs` and
// `scripts/test/e2e-manifest-pipeline.test.mjs` both spawn `task manifest`,
// node:test runs test FILES in parallel, and `task manifest` depends on `task
// tool-schemas` — so two processes wrote src/generated/tool-schemas.ts while a
// third imported it. The observable result was:
//
//     task: [manifest] node --import tsx scripts/build-manifest.mjs
//     build-manifest: validation failed — src/generated/tool-schemas.ts must
//                     export `toolSchemas` as an object
//     build-tool-schemas: wrote src/generated/tool-schemas.ts   ← after the read
//
// which reads exactly like a real codegen defect. Each test passes 10/10 in
// isolation; the suite fails only at a parallelism the scheduler picks. That is
// the worst shape a gate failure can take, because the natural response is to
// re-run and move on.
//
// A rename within the same filesystem is atomic on POSIX and on Windows via
// ReplaceFile, so a concurrent reader sees either the complete old file or the
// complete new one — never a half-written one. This is not a test-only
// concern: the same exposure exists whenever CI regenerates while another step
// reads, which is the normal shape of a parallel build.
//
// `task cluster:zod` and `task cluster:go` already do this in shell (write to
// $TMPDIR, then mv). This is the same discipline for the Node generators, so
// the property does not depend on which language a given generator is in.

import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/**
 * Write `text` to `file` atomically.
 *
 * The temp file is created in the DESTINATION directory, not os.tmpdir():
 * rename is only atomic within one filesystem, and /tmp is frequently a
 * different mount. A cross-device rename fails with EXDEV, which would trade a
 * rare race for a reliable break.
 *
 * @param {string} file absolute path to write
 * @param {string} text full contents
 */
export function writeGeneratedFile(file, text) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  // pid + a counter keeps concurrent writers in the same directory from
  // colliding on the temp name itself.
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${counter++}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    // Leaving a .tmp behind would make the next `git status` look dirty and
    // could trip a drift gate for a reason unrelated to the schema.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // lint-allow-silent: cleanup of a temp file on an already-failing path.
      // The original error below is what the caller needs; a failure to remove
      // scratch must not replace it.
    }
    throw e;
  }
}

let counter = 0;
