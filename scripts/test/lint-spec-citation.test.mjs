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
  collectMirrorVersions,
  mirrorVersionDrift,
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

// ── mirror-version agreement (cloister-d303b2) ───────────────────────────
//
// The portable half of the rail. It compares two strings inside cloister and
// needs no sibling checkout — which is the point: a CI runner with no LLO is
// exactly where a stale mirror would otherwise sit unnoticed, and that is how
// `confinement/v1 @ v0.7.3` survived to a v0.17.0 tree.

test("the SHIPPED tree declares mirror versions the tree actually pins", () => {
  assert.deepEqual(
    mirrorVersionDrift(ROOT),
    [],
    "a hand-mirrored operator surface names a spec version the tree does not pin",
  );
});

test("the rail FIRES on a mirror that lags the pin", () => {
  // Non-vacuity. The shipped-tree assertion above passes trivially if the
  // detector never matches anything, and it matched nothing for the first
  // draft of this check because `manifest/` was outside SCAN_DIRS — the rail
  // was not looking at the only file that had the declaration.
  const drift = mirrorVersionDrift(ROOT, "99.0.0");
  assert.ok(drift.length > 0, "with an impossible pin, every declaration must be drift");
  assert.ok(
    drift.some((d) => d.file === "manifest/cluster.capnp"),
    "the confinement mirror carries a declaration and must be seen",
  );
});

test("BOTH copies in cluster.capnp are seen, not just the tidy one", () => {
  // The rail shipped seeing one of the two declarations in the file it was
  // written for. `cluster.capnp` states the mirrored version twice and the copy
  // at line 206 wraps mid-declaration, with a comment prefix landing between the
  // `@` and the version. Update one copy and forget the other and the rail
  // reported clean — the exact two-hand-copies drift it exists to catch.
  //
  // Three regex attempts to see two forms in one file is the honest measure of
  // what this kind of check is: a tripwire for the obvious case, not a proof.
  // This test is the part that keeps it honest.
  const inCapnp = collectMirrorVersions(ROOT)
    .filter((m) => m.file === "manifest/cluster.capnp");
  assert.ok(
    inCapnp.length >= 2,
    `expected both mirror declarations in cluster.capnp, saw ${inCapnp.length}: ` +
      inCapnp.map((m) => `${m.line}@${m.declared}`).join(", "),
  );
  // …and they must AGREE, which is the property the count is protecting.
  assert.equal(new Set(inCapnp.map((m) => m.declared)).size, 1,
    "the two declarations state different versions");
});

test("a matching declaration is not drift", () => {
  // Named explicitly rather than by `.find(spec)`: `collectMirrorVersions`
  // deliberately does NOT apply the rail's own-file exemption (that lives in
  // `mirrorVersionDrift`), so a bare find picks up this file's own fixture.
  const declared = collectMirrorVersions(ROOT)
    .find((m) => m.file === "manifest/cluster.capnp" && m.spec === "confinement/v1");
  assert.ok(declared, "the confinement mirror must declare a version at all");
  assert.deepEqual(
    mirrorVersionDrift(ROOT, declared.declared),
    [],
    "pinning exactly what the mirror declares must be clean",
  );
});

test("an unreadable pin disables the comparison rather than inventing drift", () => {
  // Fail-OPEN here, deliberately and narrowly: we cannot claim a mirror
  // disagrees with a version we could not read. `lint:upstream-pins` owns
  // reporting an unreadable cluster.toml, and reporting it twice in different
  // words sends a reader to the wrong file.
  assert.deepEqual(mirrorVersionDrift(ROOT, null), []);
});
