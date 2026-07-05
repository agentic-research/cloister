// scripts/test/lint-doc-counts.test.mjs
//
// Run with:  node --test scripts/test/lint-doc-counts.test.mjs
//
// Contract tests for scripts/lint-doc-counts.mjs — asserts that
// "N numbered ADRs" + "next free ADR-NNNN" claims in markdown match
// ground truth on disk (the count + max number under docs/adr/).
//
// Tests synthesize a tmpdir with a fake docs/adr/ + fake markdown
// files, then spawn the lint script with DOC_COUNTS_ROOT pointing at
// the fixture root.
//
// Per cloister-9d14f2 / doc-friend audit P4.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-doc-counts.mjs");

function makeFixture({ adrNumbers, markdownFiles }) {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-counts-lint-"));
  const adrDir = resolve(dir, "docs/adr");
  mkdirSync(adrDir, { recursive: true });
  for (const n of adrNumbers) {
    const padded = String(n).padStart(4, "0");
    writeFileSync(resolve(adrDir, `${padded}-fixture.md`), `# ADR ${padded}\n`);
  }
  for (const [relPath, content] of Object.entries(markdownFiles)) {
    const full = resolve(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function runLint(rootDir) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, DOC_COUNTS_ROOT: rootDir },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test("happy path: ADR count + next-free match → exit 0", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3, 4, 5],
    markdownFiles: {
      "README.md": "This repo has 5 numbered ADRs and the next free is ADR-0006.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /5 numbered ADRs/);
    assert.match(r.stdout, /next free ADR-0006/);
  } finally {
    fx.cleanup();
  }
});

test("ADR count drift: README cites 4 when 5 exist → exit 1", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3, 4, 5],
    markdownFiles: {
      "README.md": "This repo has 4 numbered ADRs.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /asserted 4, expected 5/);
    assert.match(r.stderr, /README\.md:1/);
  } finally {
    fx.cleanup();
  }
});

test("next-free ADR drift: cited 0003 when 0006 is next → exit 1", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3, 4, 5],
    markdownFiles: {
      "docs/README.md": "Next free ADR is ADR-0003.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /asserted 3, expected 6/);
  } finally {
    fx.cleanup();
  }
});

test("multiple drifts in one file: both reported in one run", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3],
    markdownFiles: {
      "CLAUDE.md":
        "We have 5 numbered ADRs (wrong; really 3).\n" +
        "Next free is ADR-0099 (also wrong; really 0004).\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 violation\(s\)/);
    assert.match(r.stderr, /asserted 5, expected 3/);
    assert.match(r.stderr, /asserted 99, expected 4/);
  } finally {
    fx.cleanup();
  }
});

test("ADR dir itself is skipped — ADR text may cite old numbers", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3],
    markdownFiles: {
      // Bury a stale citation INSIDE the adr dir — it should be ignored.
      "docs/adr/0001-fixture.md":
        "# ADR 0001\n\nHistorical context: at the time, we had 9999 numbered ADRs.\n",
      "README.md":
        "We have 3 numbered ADRs.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});

test("adversarial-cycles/ + plans/archive/ + archive/ are skipped (historical narrative)", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2],
    markdownFiles: {
      "docs/security/adversarial-cycles/2026-05-13-cycle.md":
        "At the time of this cycle, the repo had 17 numbered ADRs.\n",
      "docs/plans/archive/2026-01-old-plan.md":
        "Frozen at: 7 numbered ADRs.\n",
      "docs/archive/prompts/example.md":
        "Tell the agent: 'we have 99 numbered ADRs'.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});

test("case-insensitive — 'NUMBERED ADRS' still matches", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2],
    markdownFiles: {
      "loud.md": "WE HAVE 9 NUMBERED ADRS.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /asserted 9, expected 2/);
  } finally {
    fx.cleanup();
  }
});

test("next-free phrasing variants — 'next free number is ADR-NNNN'", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3],
    markdownFiles: {
      "phrase-a.md": "next free is ADR-0099\n",
      "phrase-b.md": "next free number is ADR-0099\n",
      "phrase-c.md": "next free ADR-0099\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    // All three phrasings should be caught — confirms regex variants
    // don't drop matches.
    assert.match(r.stderr, /3 violation\(s\)/);
  } finally {
    fx.cleanup();
  }
});

test("3-digit ADR id (e.g. ADR-022 legacy) is still matched", () => {
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3],
    markdownFiles: {
      "legacy.md": "next free is ADR-022\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /asserted 22, expected 4/);
  } finally {
    fx.cleanup();
  }
});

test("no ADRs in dir → exit 2 (toolchain error)", () => {
  const fx = makeFixture({
    adrNumbers:    [],
    markdownFiles: {
      "README.md": "0 numbered ADRs\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no ADR files matched/);
  } finally {
    fx.cleanup();
  }
});

test("missing docs/adr/ dir → exit 2", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-counts-no-adr-"));
  try {
    writeFileSync(resolve(dir, "README.md"), "1 numbered ADRs\n");
    const r = runLint(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ADR dir not found/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("count claim with wrong unit shape ('the 5 ADRs') is NOT matched (too permissive would flag every count)", () => {
  // The lint is intentionally narrow: only "N numbered ADRs" matches.
  // "5 ADRs" without "numbered" doesn't, because non-ADR contexts
  // ("5 ADRs ago", "the 5 ADRs we deprecated") shouldn't trip the lint.
  const fx = makeFixture({
    adrNumbers:    [1, 2, 3],
    markdownFiles: {
      "narrow.md": "We have shipped 5 ADRs since launch.\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fx.cleanup();
  }
});
