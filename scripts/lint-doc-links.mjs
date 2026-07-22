#!/usr/bin/env node
// scripts/lint-doc-links.mjs
//
// Drift gate for markdown cross-references — asserts every relative
// link to a `.md` (or other repo path) in the markdown surface
// resolves to an existing file. Motivated by the 2026-06-24 PR #94
// fallout where `docs/tenants/README.md` carried a `[lsp-mcp](lsp-mcp.md)`
// row that pointed at a file deleted in the same PR; nothing caught
// it until the next inner-loop sweep. The same class of bug killed
// the ley-line-mcp tenant doc references later that day.
//
// ── Scope ────────────────────────────────────────────────────────────────
//
//   - Walks `docs/**/*.md` + repo-root canonical docs (README, CHANGELOG,
//     CLAUDE, AGENTS, GETTING-STARTED).
//   - Extracts `[label](url)` links. Skips code-block content (``` fenced +
//     `` inline) so doc snippets showing example markdown don't false-flag.
//   - Resolves each relative URL against `path.dirname(file)`.
//   - Out of scope: http(s)://, mailto:, anchor-only (`#section`), URIs
//     with the protocol-relative `//` form.
//
// ── Run ──────────────────────────────────────────────────────────────────
//
//   pnpm exec tsx scripts/lint-doc-links.mjs
//
// Exit 0 = no broken links / Exit 1 = drift / Exit 2 = toolchain error.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.LINT_DOC_LINKS_REPO_ROOT ?? resolvePath(HERE, "..");

const TOP_LEVEL_DOCS = ["README.md", "CHANGELOG.md", "CLAUDE.md", "AGENTS.md", "GETTING-STARTED.md"];
const DOCS_DIR = "docs";

function walk(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (e.name.endsWith(".md")) files.push(p);
  }
  return files;
}

// Strip fenced (```…```) and inline (`…`) code blocks. Doc snippets
// showing example markdown like `[ADR-0028](adr/0028-…)` (with ellipsis
// placeholder) shouldn't fail the lint just because they look like a
// link to the regex.
function stripCode(body) {
  // fenced first (so we don't strip inline ` inside fenced)
  let out = body.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/`[^`\n]*`/g, "");
  return out;
}

const LINK_RE = /\[(?:[^\]]*)\]\(([^) ]+)\)/g;

function checkFile(absPath, root) {
  const body = stripCode(readFileSync(absPath, "utf-8"));
  const broken = [];
  let m;
  while ((m = LINK_RE.exec(body)) !== null) {
    let url = m[1];
    if (url.startsWith("http://") || url.startsWith("https://")) continue;
    if (url.startsWith("mailto:") || url.startsWith("//"))      continue;
    if (url.startsWith("#"))                                     continue;
    if (url.includes("#")) url = url.split("#")[0];
    if (!url) continue;
    // An absolute filesystem path is NEVER correct in a committed doc — it is
    // machine-dependent. Worse, it produces a FALSE PASS: `resolvePath` ignores
    // the base for an absolute url, so a link like
    // `/Users/<someone>/repo/docs/adr/0007-…md` resolves to itself and
    // `existsSync` is true on the author's machine while failing in CI. That is
    // exactly how a broken link shipped in agent-process-v1.review-changes.md
    // and only surfaced on a CI runner. Reject on shape, not on existence.
    if (url.startsWith("/")) {
      broken.push({
        file: relative(root, absPath),
        url,
        resolved: "ABSOLUTE PATH — machine-dependent; use a repo-relative link",
      });
      continue;
    }
    const resolved = resolvePath(dirname(absPath), url);
    if (!existsSync(resolved)) {
      broken.push({ file: relative(root, absPath), url, resolved: relative(root, resolved) });
    }
  }
  return broken;
}

function main() {
  if (!existsSync(REPO_ROOT) || !statSync(REPO_ROOT).isDirectory()) {
    console.error(`lint-doc-links: REPO_ROOT does not exist or is not a dir: ${REPO_ROOT}`);
    process.exit(2);
  }

  const targets = [];
  for (const name of TOP_LEVEL_DOCS) {
    const p = join(REPO_ROOT, name);
    if (existsSync(p)) targets.push(p);
  }
  targets.push(...walk(join(REPO_ROOT, DOCS_DIR)));

  const broken = [];
  for (const file of targets) {
    broken.push(...checkFile(file, REPO_ROOT));
  }

  if (broken.length > 0) {
    console.error(`lint-doc-links: ${broken.length} broken link(s) across ${targets.length} markdown file(s):`);
    for (const b of broken) {
      console.error(`  ✘ ${b.file} → ${b.url}`);
      console.error(`      resolved: ${b.resolved}`);
    }
    process.exit(1);
  }

  console.log(`lint-doc-links: ok — ${targets.length} markdown file(s) checked, all relative links resolve.`);
}

main();
