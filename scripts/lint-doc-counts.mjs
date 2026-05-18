#!/usr/bin/env node
/**
 * scripts/lint-doc-counts.mjs — assert "N numbered ADRs" / "next free
 * ADR-NNNN" claims in markdown match ground truth on disk.
 *
 * Why this exists (cloister-9d14f2, doc-friend audit P4):
 *
 *   ADR-count drift was endemic before the 963bf6 audit: README said
 *   "21 numbered ADRs" when there were 24; CLAUDE.md + docs/README.md
 *   both said "next free is ADR-0022" when 0026 was next. Every new
 *   ADR re-opens the drift. Without an automated gate, the bug ships
 *   in N places at once each cycle.
 *
 *   This lint pinpoints two narrowly-scoped, slow-moving claim shapes
 *   that have a single source of truth (the `docs/adr/` directory):
 *
 *     (1) "N numbered ADRs"        — exact = `ls docs/adr/*.md | wc -l`
 *     (2) "next free ADR-NNNN"     — exact = max(ADR number) + 1
 *
 *   Both are linted with collect-all semantics — the lint identifies
 *   every offending line:col so the operator can fix the whole drift
 *   class at once, not one-error-restart-repeat.
 *
 * Out of scope (intentional):
 *
 *   - "N tests passing" — drifts on every PR; running `vitest --list`
 *     at lint time is too slow for the inner-loop gate. Deferred to a
 *     follow-on bead if/when the test-count drift becomes painful.
 *   - "cloister-XXXXXX bead exists" — different threat class (stale
 *     bead refs, not stale counts); needs the rsry MCP at lint time.
 *
 * Wire:
 *
 *   Exit 0 — every "N ADRs" + "next free ADR-NNNN" claim matches ground truth.
 *   Exit 1 — at least one violation.
 *   Exit 2 — toolchain error (docs/adr/ missing, no ADR files, etc.).
 *
 * Env:
 *
 *   DOC_COUNTS_ROOT — override repo root (used by tests).
 *   DOC_COUNTS_ADR_DIR — override ADR dir (used by tests).
 *   DOC_COUNTS_SCAN_DIR — override scan dir (used by tests; defaults to
 *                        DOC_COUNTS_ROOT).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.DOC_COUNTS_ROOT
  ? resolve(process.env.DOC_COUNTS_ROOT)
  : resolve(HERE, "..");

const ADR_DIR = process.env.DOC_COUNTS_ADR_DIR
  ? resolve(process.env.DOC_COUNTS_ADR_DIR)
  : resolve(REPO_ROOT, "docs/adr");

const SCAN_DIR = process.env.DOC_COUNTS_SCAN_DIR
  ? resolve(process.env.DOC_COUNTS_SCAN_DIR)
  : REPO_ROOT;

// Directories to skip entirely while walking. Vendored content + the
// ADR dir itself (the ADRs ARE the ground truth — they don't cite
// counts of themselves) + transient state.
const SKIP_DIRS = new Set([
  ".git",
  ".claude",       // session scratch — includes worktree copies of CLAUDE.md
  "node_modules",
  ".beads",
  "target",
  "dist",
  "build",
  ".pnpm-store",
  ".wrangler",
  ".turbo",
]);

// Paths (relative to scan root) that contain historical narrative.
// Cycle reports + archived plans freeze the world at a point in time;
// they MUST be allowed to cite old counts without tripping the lint.
const SKIP_PATH_PREFIXES = [
  "docs/adr/",
  "docs/security/adversarial-cycles/",
  "docs/plans/archive/",
  "docs/prompts/",
];

class ToolchainError extends Error {}

// ── Ground truth ─────────────────────────────────────────────────────────

function adrFiles() {
  if (!existsSync(ADR_DIR) || !statSync(ADR_DIR).isDirectory()) {
    throw new ToolchainError(`ADR dir not found at ${ADR_DIR}`);
  }
  return readdirSync(ADR_DIR)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort();
}

function groundTruth() {
  const files = adrFiles();
  if (files.length === 0) {
    throw new ToolchainError(`no ADR files matched ^\\d{4}-.+\\.md$ in ${ADR_DIR}`);
  }
  const numbers = files.map((f) => Number.parseInt(f.slice(0, 4), 10));
  return {
    count:    files.length,
    maxNum:   Math.max(...numbers),
    nextFree: Math.max(...numbers) + 1,
  };
}

// ── Walk + match ─────────────────────────────────────────────────────────

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

function isSkippedPath(absPath) {
  const rel = relative(REPO_ROOT, absPath);
  return SKIP_PATH_PREFIXES.some((p) => rel.startsWith(p));
}

// Patterns: each has `name`, `regex` (must have ONE capture group with the
// asserted number), and `expected` (function over ground-truth → number).
//
// Patterns are case-insensitive. The `\b` anchors prevent matching mid-word.
// Spaces in the regex use `\s+` so reflowed prose still matches.
const PATTERNS = [
  {
    name:        "N numbered ADRs",
    regex:       /\b(\d+)\s+numbered\s+ADRs\b/gi,
    expected:    (gt) => gt.count,
    description: 'phrase: "N numbered ADRs"',
  },
  {
    name:        "next free ADR-NNNN",
    // Matches: "next free is ADR-0022", "next free number is ADR-0022",
    // "next free ADR is 0022", "next free ADR number 0022", etc.
    // The captured digits MUST be 3-4 long (ADR ids are zero-padded 4 today;
    // tolerate 3 for legacy doc text).
    regex:       /next\s+free(?:\s+number)?(?:\s+ADR)?(?:\s+is)?\s+ADR-(\d{3,4})\b/gi,
    expected:    (gt) => gt.nextFree,
    description: 'phrase: "next free ADR-NNNN"',
  },
];

function lineColOf(content, charIndex) {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < charIndex; i++) {
    if (content[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, col: charIndex - lastNewline };
}

function checkFile(path, gt) {
  const violations = [];
  const content = readFileSync(path, "utf8");
  for (const pattern of PATTERNS) {
    for (const m of content.matchAll(pattern.regex)) {
      const asserted = Number.parseInt(m[1], 10);
      const expected = pattern.expected(gt);
      if (asserted !== expected) {
        const { line, col } = lineColOf(content, m.index);
        violations.push({
          path,
          line,
          col,
          pattern:   pattern.name,
          asserted,
          expected,
          excerpt:   m[0],
        });
      }
    }
  }
  return violations;
}

// ── Run ──────────────────────────────────────────────────────────────────

let gt;
try {
  gt = groundTruth();
} catch (e) {
  if (e instanceof ToolchainError) {
    console.error(`lint-doc-counts: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const allViolations = [];
for (const path of walkMarkdown(SCAN_DIR)) {
  if (isSkippedPath(path)) continue;
  allViolations.push(...checkFile(path, gt));
}

if (allViolations.length === 0) {
  console.log(
    `lint-doc-counts: OK — ${gt.count} numbered ADRs (max ADR-${String(gt.maxNum).padStart(4, "0")}; ` +
    `next free ADR-${String(gt.nextFree).padStart(4, "0")})`,
  );
  process.exit(0);
}

console.error(`lint-doc-counts: ${allViolations.length} violation(s) (cloister-9d14f2)`);
console.error(`  ground truth: ${gt.count} numbered ADRs; max ADR-${String(gt.maxNum).padStart(4, "0")}; next free ADR-${String(gt.nextFree).padStart(4, "0")}`);
console.error("");
for (const v of allViolations) {
  const relPath = relative(REPO_ROOT, v.path);
  console.error(`  ${String.fromCodePoint(0x2717)} ${relPath}:${v.line}:${v.col}`);
  console.error(`      ${v.pattern}: asserted ${v.asserted}, expected ${v.expected}`);
  console.error(`      excerpt: ${v.excerpt}`);
}
process.exit(1);
