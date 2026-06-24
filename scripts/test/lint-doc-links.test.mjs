// scripts/test/lint-doc-links.test.mjs
//
// Run with:  node --test scripts/test/lint-doc-links.test.mjs
//
// Contract tests for scripts/lint-doc-links.mjs — the drift gate that
// catches the PR-#94 class of bug where a doc page deletion leaves
// dangling [foo](foo.md) references in sibling pages. Tests synthesize
// a tmpdir, populate it with markdown files, and point
// LINT_DOC_LINKS_REPO_ROOT at it.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-doc-links.mjs");

function makeRepo(files) {
  const dir = mkdtempSync(resolve(tmpdir(), "doc-links-lint-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  for (const [relPath, body] of Object.entries(files)) {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return {
    dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function runLint(repoRoot) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, LINT_DOC_LINKS_REPO_ROOT: repoRoot },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test("all links resolve → exit 0", () => {
  const repo = makeRepo({
    "README.md":          "# repo\nSee [getting-started](GETTING-STARTED.md) and [docs](docs/README.md).\n",
    "GETTING-STARTED.md": "# getting started\nBack to [README](README.md).\n",
    "docs/README.md":     "# docs\nLinks to [one](one.md) and [up](../README.md).\n",
    "docs/one.md":        "# one\n",
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /all relative links resolve/);
  } finally {
    repo.cleanup();
  }
});

test("dangling link to deleted sibling → exit 1 with broken path", () => {
  const repo = makeRepo({
    "docs/README.md": "# docs\nSee [lsp-mcp](lsp-mcp.md) for details.\n",
    // Note: lsp-mcp.md intentionally not created — the PR-#94 case.
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /1 broken link/);
    assert.match(r.stderr, /docs\/README\.md → lsp-mcp\.md/);
  } finally {
    repo.cleanup();
  }
});

test("http(s)://, mailto:, # anchors all skipped → exit 0", () => {
  const repo = makeRepo({
    "README.md": "# repo\n[ext](https://example.com)\n[mail](mailto:x@y.z)\n[anchor](#section)\n[proto](//cdn.example.com/x)\n",
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    repo.cleanup();
  }
});

test("links inside fenced code blocks are NOT flagged", () => {
  const repo = makeRepo({
    "docs/README.md": "# docs\nExample syntax:\n\n```\n[example](does-not-exist.md)\n```\n\nAnd inline `[also](nope.md)` is skipped too.\n",
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /all relative links resolve/);
  } finally {
    repo.cleanup();
  }
});

test("link with #fragment resolves against the path before #", () => {
  const repo = makeRepo({
    "docs/README.md":    "# docs\nSee [section](one.md#a-heading).\n",
    "docs/one.md":       "# one\n## A Heading\n",
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    repo.cleanup();
  }
});

test("multiple broken links across files → all reported, exit 1", () => {
  const repo = makeRepo({
    "README.md":        "# repo\n[a](missing-a.md) and [b](docs/missing-b.md)\n",
    "docs/README.md":   "# docs\n[c](missing-c.md)\n",
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /3 broken link/);
    assert.match(r.stderr, /missing-a\.md/);
    assert.match(r.stderr, /missing-b\.md/);
    assert.match(r.stderr, /missing-c\.md/);
  } finally {
    repo.cleanup();
  }
});

test("relative ../ resolves correctly", () => {
  const repo = makeRepo({
    "README.md":           "# top\n",
    "docs/sub/page.md":    "# sub\nBack to [top](../../README.md).\n",
  });
  try {
    const r = runLint(repo.dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
  } finally {
    repo.cleanup();
  }
});
