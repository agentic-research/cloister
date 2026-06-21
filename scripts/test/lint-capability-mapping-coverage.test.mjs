// scripts/test/lint-capability-mapping-coverage.test.mjs
//
// Run with:  pnpm exec tsx --test scripts/test/lint-capability-mapping-coverage.test.mjs
//
// Unit tests for `parseLane3FromSection4`, `listExpectedLane3Ids`, and
// `collectMissingRows` — pure functions, no I/O on the parser itself —
// plus integration tests that synthesize a temp spec tree + mapping
// doc and invoke the lint as a subprocess.
//
// Per cloister-137642 (cred-iso audit R-2).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseLane3FromSection4,
  listExpectedLane3Ids,
  collectMissingRows,
} from "../lint-capability-mapping-coverage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(
  REPO_ROOT,
  "scripts/lint-capability-mapping-coverage.mjs",
);

// ── Unit: parseLane3FromSection4 ─────────────────────────────────────────

test("parseLane3FromSection4: extracts lane-3 IDs from a real-shaped §4 table", () => {
  const doc = [
    "# Header",
    "",
    "## §3 Other section",
    "Stuff with `cloister/should-not-count/v1` outside §4.",
    "",
    "## §4 Crosswalk table",
    "",
    "| Lane-1 | Lane-3 | Notes |",
    "|--------|--------|-------|",
    "| `urn:signet:cap:read:bead-store` | `cloister/bead-store/v1` | Read-only. |",
    "| `urn:signet:cap:read:credential-isolation` | `cloister/credential-isolation/v1` | Vault. |",
    "| n/a (substrate-internal) | `cloister/mcp-tool/v1` | Build-time hint. |",
    "",
    "## §5 Next section",
    "Should not parse `cloister/post-section/v1` here.",
  ].join("\n");
  const ids = parseLane3FromSection4(doc);
  assert.equal(ids.size, 3);
  assert.ok(ids.has("cloister/bead-store/v1"));
  assert.ok(ids.has("cloister/credential-isolation/v1"));
  assert.ok(ids.has("cloister/mcp-tool/v1"));
  assert.ok(!ids.has("cloister/should-not-count/v1"));
  assert.ok(!ids.has("cloister/post-section/v1"));
});

test("parseLane3FromSection4: returns empty when §4 missing", () => {
  const doc = "# Header\n## §3 Only this\nNo crosswalk.";
  assert.equal(parseLane3FromSection4(doc).size, 0);
});

test("parseLane3FromSection4: skips header + separator rows", () => {
  const doc = [
    "## §4 Section",
    "| H1 | H2 |",
    "|----|----|",
    "| `urn:x` | `cloister/a/v1` |",
    "## §5",
  ].join("\n");
  const ids = parseLane3FromSection4(doc);
  assert.equal(ids.size, 1);
  assert.ok(ids.has("cloister/a/v1"));
});

test("parseLane3FromSection4: rejects malformed lane-3 cells", () => {
  const doc = [
    "## §4 Section",
    "| H1 | H2 | H3 |",
    "|----|----|----|",
    "| `urn:x` | not-backticked cloister/a/v1 | Bad. |",
    "| `urn:x` | `cloister/a/notdigits` | Bad version. |",
    "| `urn:x` | `cloister/b/v` | Empty version. |",
    "| `urn:x` | `not-cloister/c/v1` | Wrong prefix. |",
    "| `urn:x` | `cloister/d/v2` | Good. |",
    "## §5",
  ].join("\n");
  const ids = parseLane3FromSection4(doc);
  assert.equal(ids.size, 1);
  assert.ok(ids.has("cloister/d/v2"));
});

test("parseLane3FromSection4: accepts multi-digit versions", () => {
  const doc = [
    "## §4 Section",
    "| H1 | H2 |",
    "|----|----|",
    "| `urn:x` | `cloister/x/v10` |",
    "| `urn:x` | `cloister/y/v100` |",
    "## §5",
  ].join("\n");
  const ids = parseLane3FromSection4(doc);
  assert.equal(ids.size, 2);
  assert.ok(ids.has("cloister/x/v10"));
  assert.ok(ids.has("cloister/y/v100"));
});

// ── Unit: listExpectedLane3Ids + collectMissingRows ──────────────────────

test("listExpectedLane3Ids: walks <name>/v<n>/README.md only", () => {
  const root = mkdtempSync(join(tmpdir(), "cspec-"));
  try {
    mkdirSync(join(root, "alpha/v1"), { recursive: true });
    writeFileSync(join(root, "alpha/v1/README.md"), "# alpha");
    mkdirSync(join(root, "beta/v2"), { recursive: true });
    writeFileSync(join(root, "beta/v2/README.md"), "# beta");
    // No README → skipped
    mkdirSync(join(root, "gamma/v1"), { recursive: true });
    // Reserved name → skipped
    mkdirSync(join(root, "_capability-mapping/v1"), { recursive: true });
    writeFileSync(join(root, "_capability-mapping/v1/README.md"), "ignored");
    // Non-v<n> dir → skipped
    mkdirSync(join(root, "delta/draft"), { recursive: true });
    writeFileSync(join(root, "delta/draft/README.md"), "ignored");

    const ids = listExpectedLane3Ids(root).map((i) => i.id);
    assert.deepEqual(ids.sort(), [
      "cloister/alpha/v1",
      "cloister/beta/v2",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectMissingRows: identifies expected IDs absent from the §4 set", () => {
  const expected = [
    { id: "cloister/a/v1", readmePath: "/x/a/v1/README.md" },
    { id: "cloister/b/v1", readmePath: "/x/b/v1/README.md" },
    { id: "cloister/c/v1", readmePath: "/x/c/v1/README.md" },
  ];
  const sectionIds = new Set(["cloister/a/v1", "cloister/c/v1"]);
  const missing = collectMissingRows(expected, sectionIds);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, "cloister/b/v1");
});

test("collectMissingRows: returns empty when everything covered", () => {
  const expected = [{ id: "cloister/a/v1", readmePath: "/x/a/v1/README.md" }];
  const sectionIds = new Set(["cloister/a/v1"]);
  assert.deepEqual(collectMissingRows(expected, sectionIds), []);
});

// ── Integration: invoke the script as a subprocess ───────────────────────

function spawnLint(env) {
  return spawnSync(process.execPath, [LINT_SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

test("integration: passes when every spec dir has a §4 row", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cmap-pass-"));
  try {
    const specRoot = join(tmp, "spec");
    mkdirSync(join(specRoot, "alpha/v1"), { recursive: true });
    writeFileSync(join(specRoot, "alpha/v1/README.md"), "# alpha");
    mkdirSync(join(specRoot, "beta/v1"), { recursive: true });
    writeFileSync(join(specRoot, "beta/v1/README.md"), "# beta");

    const doc = [
      "## §4 Crosswalk table",
      "| H1 | H2 | H3 |",
      "|----|----|----|",
      "| `urn:x` | `cloister/alpha/v1` | A. |",
      "| `urn:x` | `cloister/beta/v1` | B. |",
      "## §5",
    ].join("\n");
    const docPath = join(tmp, "mapping.md");
    writeFileSync(docPath, doc);

    const result = spawnLint({
      CLOISTER_SPEC_ROOT: specRoot,
      CLOISTER_MAPPING_DOC: docPath,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("clean ✓"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration: fails with actionable message when a spec dir is missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cmap-fail-"));
  try {
    const specRoot = join(tmp, "spec");
    mkdirSync(join(specRoot, "alpha/v1"), { recursive: true });
    writeFileSync(join(specRoot, "alpha/v1/README.md"), "# alpha");
    mkdirSync(join(specRoot, "uncovered/v1"), { recursive: true });
    writeFileSync(join(specRoot, "uncovered/v1/README.md"), "# uncovered");

    const doc = [
      "## §4 Crosswalk table",
      "| H1 | H2 | H3 |",
      "|----|----|----|",
      "| `urn:x` | `cloister/alpha/v1` | A. |",
      "## §5",
    ].join("\n");
    const docPath = join(tmp, "mapping.md");
    writeFileSync(docPath, doc);

    const result = spawnLint({
      CLOISTER_SPEC_ROOT: specRoot,
      CLOISTER_MAPPING_DOC: docPath,
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("cloister/uncovered/v1"));
    assert.ok(result.stderr.includes("Fix: add a row to §4"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration: bails (exit 2) when §4 missing entirely", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cmap-no4-"));
  try {
    const specRoot = join(tmp, "spec");
    mkdirSync(join(specRoot, "alpha/v1"), { recursive: true });
    writeFileSync(join(specRoot, "alpha/v1/README.md"), "# alpha");

    const docPath = join(tmp, "mapping.md");
    writeFileSync(docPath, "# Just a header\n\nNo §4 here.\n");

    const result = spawnLint({
      CLOISTER_SPEC_ROOT: specRoot,
      CLOISTER_MAPPING_DOC: docPath,
    });
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("parsed 0 rows"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
