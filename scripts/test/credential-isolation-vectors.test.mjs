// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Integrity half of `cloister/credential-isolation/v1` conformance (cloister-7c9312).
//
// LLO publishes ten conformance vectors for this capability and states the bar
// in its README: "anyone building a second implementation ... If you reach the
// same digests on the test vectors, you're conformant." Cloister IS that second
// implementation — src/routes/vault-proxy.ts is 770 lines against this contract
// — and until now consumed none of them.
//
// This file asserts the vendored copies are byte-identical to what LLO
// published. The behavioural half — feeding the cases through cloister's
// production path — lives in test/routes/credential-isolation-conformance.test.ts,
// which runs under workerd where the handler does.
//
// ── Why vendored rather than read from a checkout ────────────────────────────
//
// Cloister CI has no ley-line-open checkout; rs/crates/cas/tests/confinement_digest.rs
// inlines confinement/v1's manifest for exactly that reason. A vendored copy
// under its upstream digest is not a second source of truth: if it drifts from
// what LLO published, the assertion below fails loudly. That is the whole point.
//
// ── The manifest is the test list ────────────────────────────────────────────
//
// The cases are driven from the vendored VECTORS.sha256 rather than a
// hand-written list of filenames. Ten files is enough that an eleventh landing
// upstream would be easy to vendor and forget to check; deriving the list from
// the manifest means a file we vendored without listing, or listed without
// vendoring, is a failure rather than a silent gap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VECTOR_DIR = join(ROOT, "test/fixtures/llo-credential-isolation-v1");
const MANIFEST = join(VECTOR_DIR, "VECTORS.sha256");

/**
 * Parse LLO's `VECTORS.sha256` — `<64 hex>  <relative path>` per line, `#`
 * comments and blanks skipped. The format is sha256sum(1)'s, so it is parsed
 * rather than hand-matched (lint:structured-parse's rule, and cheap here).
 */
export function parseManifest(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const m = /^([0-9a-f]{64})\s+(\S.*)$/.exec(trimmed);
    if (!m) throw new Error(`unparseable VECTORS.sha256 line: ${line}`);
    rows.push({ sha256: m[1], path: m[2] });
  }
  return rows;
}

const manifest = parseManifest(readFileSync(MANIFEST, "utf8"));

test("the vendored manifest lists the vectors LLO published", () => {
  // Guards the suite against passing vacuously: an empty or comment-only
  // manifest would satisfy every per-file assertion below by iterating nothing.
  assert.ok(
    manifest.length >= 10,
    `expected at least the ten published vectors, got ${manifest.length}`,
  );
  for (const row of manifest) {
    assert.match(row.path, /^test-vectors\/[a-z0-9-]+\.json$/, row.path);
  }
});

for (const { sha256, path } of manifest) {
  test(`${path} matches LLO's published digest`, () => {
    const bytes = readFileSync(join(VECTOR_DIR, path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      sha256,
      `${path} drifted from ley-line-open's published vector`,
    );
  });
}

test("nothing is vendored that the manifest does not cover", () => {
  // The other direction: a file copied in but left out of VECTORS.sha256 would
  // never be digest-checked, and would look covered because it sits alongside
  // files that are.
  const listed = new Set(manifest.map((row) => row.path.replace(/^test-vectors\//, "")));
  const onDisk = readdirSync(join(VECTOR_DIR, "test-vectors"))
    .filter((name) => name.endsWith(".json"));

  assert.deepEqual(
    onDisk.filter((name) => !listed.has(name)),
    [],
    "vendored vector file is absent from VECTORS.sha256",
  );
});

test("every vector carries the contract version it belongs to", () => {
  // Cheap structural check that we vendored credential-isolation vectors and
  // not, say, execution/v1's — the filenames alone would not catch that.
  for (const { path } of manifest) {
    const doc = JSON.parse(readFileSync(join(VECTOR_DIR, path), "utf8"));
    assert.equal(doc.version, "cloister/credential-isolation/v1", path);
    assert.ok(Array.isArray(doc.vectors) && doc.vectors.length > 0, `${path} has no cases`);
  }
});
