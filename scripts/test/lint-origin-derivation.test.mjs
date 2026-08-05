// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Companion test for `lint:origin-derivation` (ADR-0065 decision 3).
//
// Per CLAUDE.md: a rail needs a test asserting the SHIPPED tree satisfies it,
// so the rail cannot pass vacuously — and a test that it FIRES, so it cannot be
// green because it never looks at anything.
//
// The firing half matters unusually much here. The first draft of this rail
// matched bare "attested"/"asserted"/"unknown" and hit seven false positives on
// the real tree; the fix was to prefix the vocabulary. A rail whose vocabulary
// can drift back into collision needs a test that would notice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOW_MARKER,
  CONFIDENCE_LITERALS,
  OWNER,
  findViolations,
} from "../lint-origin-derivation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the SHIPPED tree satisfies the rail", () => {
  assert.deepEqual(
    findViolations(ROOT),
    [],
    "a Confidence literal escaped src/wire/origin.ts",
  );
});

test("the rail FIRES on a declared Confidence — it is not green by never looking", () => {
  const dir = mkdtempSync(join(tmpdir(), "origin-rail-"));
  try {
    mkdirSync(join(dir, "src", "routes"), { recursive: true });
    writeFileSync(
      join(dir, "src", "routes", "sneaky.ts"),
      `export const c = "${CONFIDENCE_LITERALS[0]}";\n`,
    );
    const found = findViolations(dir);
    assert.equal(found.length, 1, "a declared Confidence must be caught");
    assert.equal(found[0].file, "src/routes/sneaky.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owning module is exempt — it is where the vocabulary lives", () => {
  const dir = mkdtempSync(join(tmpdir(), "origin-rail-owner-"));
  try {
    mkdirSync(join(dir, dirname(OWNER)), { recursive: true });
    writeFileSync(
      join(dir, OWNER),
      `export const c = "${CONFIDENCE_LITERALS[0]}";\n`,
    );
    assert.deepEqual(findViolations(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the allow-marker exempts a line, and only a justified one", () => {
  const dir = mkdtempSync(join(tmpdir(), "origin-rail-allow-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "a.ts"),
      `const x = "${CONFIDENCE_LITERALS[1]}"; // ${ALLOW_MARKER} wire constant\n`,
    );
    assert.deepEqual(findViolations(dir), [], "an inline-justified line passes");

    // …and the same line without the marker does not, so the exemption is what
    // is doing the work rather than some other property of the fixture.
    writeFileSync(join(dir, "src", "a.ts"), `const x = "${CONFIDENCE_LITERALS[1]}";\n`);
    assert.equal(findViolations(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the vocabulary stays distinctive — a bare word would collide with the tree", () => {
  // The regression guard for the false-positive round. If someone drops the
  // `origin-` prefix, this fails BEFORE the rail starts crying wolf in CI.
  for (const literal of CONFIDENCE_LITERALS) {
    assert.ok(
      literal.startsWith("origin-"),
      `${literal} must stay prefixed — bare "unknown" hit 7 unrelated sites ` +
        `(author defaults, error codes, an HTTP fallback) on the real tree`,
    );
  }
});
