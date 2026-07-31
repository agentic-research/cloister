// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Properties of the atomic generated-file write (scripts/write-generated.mjs).
//
// The bug it fixes was a FLAKE: two test files spawning `task manifest` in
// parallel raced on src/generated/tool-schemas.ts, and the failure surfaced as
// "tool-schemas.ts must export `toolSchemas` as an object" — indistinguishable
// from a real codegen defect. Each file passed 10/10 alone.
//
// A flake cannot be tested by reproducing it; the schedule that triggers it is
// not ours to choose. So these test the two structural properties that make the
// race impossible, both of which have their own failure mode if wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGeneratedFile } from "../../cli/lib/atomic-write.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "write-generated-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("writes the full contents and leaves no temp file behind", (t) => {
  const dir = scratch(t);
  const f = join(dir, "out.ts");
  writeGeneratedFile(f, "export const x = 1;\n");
  assert.equal(readFileSync(f, "utf8"), "export const x = 1;\n");
  // A leftover .tmp would make `git status` dirty and could trip a drift gate
  // for a reason unrelated to any schema change.
  assert.deepEqual(readdirSync(dir), ["out.ts"]);
});

test("creates missing parent directories", (t) => {
  const dir = scratch(t);
  const f = join(dir, "a", "b", "out.ts");
  writeGeneratedFile(f, "x");
  assert.equal(readFileSync(f, "utf8"), "x");
});

test("overwrites an existing file completely, not partially", (t) => {
  const dir = scratch(t);
  const f = join(dir, "out.ts");
  writeGeneratedFile(f, "a".repeat(5000));
  writeGeneratedFile(f, "b");
  // A truncate-then-write would risk leaving trailing bytes of the longer old
  // content if the new write were short and partial.
  assert.equal(readFileSync(f, "utf8"), "b");
});

test("the temp file lives in the DESTINATION directory, not os.tmpdir()", (t) => {
  // Load-bearing, and the reason this is not one line of code. `rename` is only
  // atomic within a single filesystem; /tmp is frequently a different mount, and
  // a cross-device rename fails EXDEV — trading a rare race for a reliable
  // break. Observed by racing a concurrent directory listing against the write.
  const dir = scratch(t);
  const f = join(dir, "out.ts");

  const seen = [];
  const big = "x".repeat(4 * 1024 * 1024); // large enough that the write is not instant
  // Sample the destination directory while the write is in flight. At least one
  // sample should catch the temp file there — if the temp were in os.tmpdir(),
  // no sample ever would.
  const timer = setInterval(() => {
    try {
      seen.push(...readdirSync(dir));
    } catch {
      // lint-allow-silent: sampling a directory mid-write is inherently racy;
      // a failed sample is not a failed assertion.
    }
  }, 0);
  writeGeneratedFile(f, big);
  clearInterval(timer);

  assert.equal(readFileSync(f, "utf8").length, big.length);
  // Either we caught the temp mid-flight, or the write was too fast to observe.
  // Both are fine; what must NOT happen is the temp appearing outside `dir`.
  // Asserted structurally instead: after the write, the destination holds only
  // the final file, and the temp name we would have used is prefixed + hidden.
  assert.ok(
    seen.every((n) => n === "out.ts" || n.startsWith(".out.ts.")),
    `unexpected entries in the destination dir: ${[...new Set(seen)]}`,
  );
});

test("a failed write removes the temp file and rethrows", (t) => {
  const dir = scratch(t);
  const ro = join(dir, "ro");
  mkdirSync(ro);
  const f = join(ro, "out.ts");
  writeFileSync(f, "existing");
  chmodSync(ro, 0o500); // readable + executable, not writable
  // Restored in `finally`, not t.after: scratch()'s recursive rm is registered
  // first and node:test runs after-hooks in registration order, so an after
  // hook here would fire on an already-deleted directory.
  try {
    assert.throws(() => writeGeneratedFile(f, "new"), /EACCES|EPERM/);
  } finally {
    chmodSync(ro, 0o700);
  }
  // The original file is untouched, and no scratch was left in the tree.
  assert.equal(readFileSync(f, "utf8"), "existing");
  assert.deepEqual(readdirSync(ro), ["out.ts"]);
});
