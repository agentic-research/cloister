#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:harness-target-literals — provider strings live in ONE file.
//
// cloister-742e19 / ADR-0057. A harness is a lattice participant, not a target
// the substrate special-cases: Claude Code and Codex are two
// `[[gateway.harnessTargets]]` rows in cluster.toml — the operator surface —
// not two branches in the harness path. This rail keeps that true by failing
// when a provider literal reappears in code.
//
// The declaration lives in cluster.toml rather than a JS table on purpose: a
// table in a script is still a config surface an operator cannot reach without
// editing JavaScript, which is the same defect one file over. Adding a harness
// is writing TOML.
//
// Without it the declaration model decays the ordinary way — someone adds
// `?? "claude"` or reads `process.env.ANTHROPIC_API_KEY` "just here", the
// declaration stops being the source of truth, and adding a third harness
// becomes a code change again. That is the drift this repo keeps rediscovering:
// an invariant with no rail is a comment.
//
// Exit 0 clean, 1 on violations, 2 on usage error.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one file allowed to name providers. */
export const DECLARATION_FILE = "cluster.toml ([[gateway.harnessTargets]] + [[gateway.vaultProxyServices]])";

/**
 * Paths scanned — files, or directories walked recursively. The harness path,
 * where a literal would actually bite. `cli/lib/harness` is a DIRECTORY on
 * purpose: the harness logic moved there from scripts/harness-dev.mjs, and a
 * rail that enumerates files goes blind to the next one added beside them.
 */
export const SCANNED = [
  "scripts/harness-dev.mjs",
  "src/harness-shim/index.ts",
  "cli/lib/harness",
];

/** Source extensions read inside a scanned directory. */
const SOURCE_EXT = /\.(?:m?js|ts)$/;

/**
 * SCANNED expanded to the source files that exist under `root`, sorted.
 * @param {string} root
 * @returns {string[]} paths relative to root
 */
export function scannedFiles(root = ROOT) {
  const out = [];
  const walk = (abs) => {
    if (!existsSync(abs)) return; // a scanned path may legitimately not exist yet
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
    } else if (SOURCE_EXT.test(abs)) {
      out.push(relative(root, abs));
    }
  };
  for (const rel of SCANNED) walk(resolve(root, rel));
  return out;
}

// Provider-identifying substrings. Case-insensitive. Deliberately narrow:
// matching bare "claude" would fire on every mention of Claude Code in prose,
// and a rail that cries wolf gets suppressed. These are the tokens that only
// appear when code is hardcoding a provider rather than reading a declaration.
export const PROVIDER_PATTERNS = [
  "anthropic",
  "openai",
  "api.anthropic.com",
  "api.openai.com",
  "x-api-key",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  '"claude"',
  "'claude'",
  '"codex"',
  "'codex'",
];

/**
 * @param {string} root
 * @returns {{file: string, line: number, pattern: string, text: string}[]}
 */
export function findViolations(root = ROOT) {
  const hits = [];
  for (const rel of scannedFiles(root)) {
    const raw = readFileSync(resolve(root, rel), "utf8");
    // Comments are exempt, deliberately. A comment cannot hardcode behavior,
    // and the useful thing operators read is usage examples naming both
    // harnesses ("Codex: OPENAI_BASE_URL=…"). Flagging those would force
    // deleting real documentation to satisfy a lint — which is how a rail
    // earns a blanket suppression and stops protecting anything.
    const rawLines = raw.split("\n");
    stripComments(raw).split("\n").forEach((text, i) => {
      if (!text.trim()) return;
      for (const pattern of PROVIDER_PATTERNS) {
        if (text.toLowerCase().includes(pattern.toLowerCase())) {
          hits.push({ file: rel, line: i + 1, pattern, text: rawLines[i].trim() });
          break; // one finding per line is enough to act on
        }
      }
    });
  }
  return hits;
}

/**
 * `src` with every comment blanked and every string, template and regex
 * literal left intact; newlines are preserved so line numbers still line up.
 *
 * This has to be a scan, not a per-line `indexOf("//")`: the `//` in
 * `"https://api.anthropic.com"` is not a comment, and treating it as one let
 * exactly the literal this rail exists for pass clean (cloister-742e19).
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  // Last significant (non-space, non-comment) character emitted — decides
  // whether a `/` opens a regex literal or is division.
  let prev = "";
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      const stop = literalEnd(src, i, c);
      out += src.slice(i, stop);
      prev = c;
      i = stop;
    } else if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      const stop = regexEnd(src, i);
      out += src.slice(i, stop);
      prev = "/";
      i = stop;
    } else {
      out += c;
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
  }
  return out;
}

/** Index just past the string/template literal opened by `quote` at `start`. */
function literalEnd(src, start, quote) {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === quote) return i + 1;
    // An unterminated '…' or "…" ends at the line; only a template spans lines.
    else if (c === "\n" && quote !== "`") return i;
    else i += 1;
  }
  return i;
}

/** Index just past the regex literal opened at `start` (handles `[/]` classes). */
function regexEnd(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === "\n") return i;
    else if (c === "[") (inClass = true), (i += 1);
    else if (c === "]") (inClass = false), (i += 1);
    else if (c === "/" && !inClass) return i + 1;
    else i += 1;
  }
  return i;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log(`lint-harness-target-literals: clean ✓`);
    console.log(`  ${scannedFiles().length} file(s) scanned, ${PROVIDER_PATTERNS.length} provider pattern(s)`);
    console.log(`  provider literals confined to ${DECLARATION_FILE} (cloister-742e19)`);
    return 0;
  }
  console.error(`lint-harness-target-literals: ${violations.length} provider literal(s) outside ${DECLARATION_FILE}\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  matched ${JSON.stringify(v.pattern)}`);
    console.error(`    ${v.text}`);
  }
  console.error(`\n  Provider-specific values belong in cluster.toml as a`);
  console.error(`  [[gateway.harnessTargets]] row (or its [[gateway.vaultProxyServices]]`);
  console.error(`  entry), read through TARGET.<field> / SVC.<field>. Adding a harness must`);
  console.error(`  not require editing code (cloister-742e19, ADR-0057).`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
