// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint:spec-citation (cloister-e83a33).
//
// The rail has two halves split by portability — a shape check that runs
// everywhere and an existence check that needs the ley-line-open checkout.
// Both are exercised here; the existence half skips when LLO is absent, which
// is the normal case on CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findCitations,
  resolveCitation,
  lloRoot,
  SPEC_ALIAS,
  SPEC_REAL_SUBPATH,
  ALLOW_MARKER,
} from "../lint-spec-citation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ── Shape: portable, runs everywhere ──────────────────────────────────────

test("the shipped tree actually contains citations to check", () => {
  // Guards the vacuous pass: a rail reporting clean because it scanned nothing
  // is the failure mode this repo keeps finding.
  const citations = findCitations(ROOT);
  assert.ok(citations.length > 10, `found ${citations.length} citations, expected many`);
});

test("every citation uses the declared alias root", () => {
  for (const c of findCitations(ROOT)) {
    assert.ok(c.path.startsWith(SPEC_ALIAS), `${c.file}:${c.line} uses ${SPEC_ALIAS}`);
  }
});

test("citations resolve under LLO's real subpath, not a guessed one", () => {
  const abs = resolveCitation(`${SPEC_ALIAS}build-cache/v1/README.md`, "/x");
  assert.equal(abs, join("/x", SPEC_REAL_SUBPATH, "build-cache/v1/README.md"));
});

test("CLOISTER_LLO_ROOT overrides the default checkout location", () => {
  assert.equal(lloRoot({ CLOISTER_LLO_ROOT: "/somewhere/else" }), "/somewhere/else");
  assert.ok(lloRoot({}).startsWith(homedir()));
});

// ── The allow marker ──────────────────────────────────────────────────────

test("a citation carrying the allow marker is flagged as allowed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spec-cite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(
    join(dir, "docs/plan.md"),
    `some prose\n<!-- ${ALLOW_MARKER} planned, not shipped -->\n(\`${SPEC_ALIAS}not-real/v1/\`)\n`,
  );
  const hits = findCitations(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].allowed, true);
});

test("a citation WITHOUT the marker is not allowed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spec-cite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs/plan.md"), `(\`${SPEC_ALIAS}not-real/v1/\`)\n`);
  const hits = findCitations(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].allowed, false);
});

// ── Parsing prose correctly ───────────────────────────────────────────────

test("a citation ending a sentence does not swallow the period", (t) => {
  // Citations live in prose; treating the trailing '.' as part of the path
  // would make every sentence-final citation dangle.
  const dir = mkdtempSync(join(tmpdir(), "spec-cite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/x.ts"),
    `// Spec: ${SPEC_ALIAS}build-cache/v1/wire/digest-encoding.md.\n`,
  );
  const hits = findCitations(dir);
  assert.equal(hits.length, 1);
  assert.ok(!hits[0].path.endsWith("."), `path should not end with a period: ${hits[0].path}`);
});

// ── Existence: local cross-check against the real upstream ────────────────

test("every non-allowed citation in the shipped tree resolves", (t) => {
  const llo = lloRoot();
  if (!existsSync(join(llo, SPEC_REAL_SUBPATH))) {
    t.skip(`no ley-line-open checkout at ${llo} (expected on CI)`);
    return;
  }
  const unresolved = findCitations(ROOT)
    .filter((c) => !c.allowed)
    .filter((c) => !existsSync(resolveCitation(c.path, llo)));
  assert.deepEqual(
    unresolved.map((c) => `${c.file}:${c.line} ${c.path}`),
    [],
    "citations must resolve — a pointer to nothing reads as 'the spec is local' (ADR-0035)",
  );
});
