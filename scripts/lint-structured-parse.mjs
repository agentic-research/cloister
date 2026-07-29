#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:structured-parse — do not hand-match a format that has a parser.
//
// ── The bug this is made of ───────────────────────────────────────────────
//
// `lint-binding-parity` originally extracted wrangler.toml bindings with a
// line-anchored `name = "X"` regex. It silently missed every Durable Object
// binding, because wrangler declares them as INLINE tables:
//
//     bindings = [ { name = "BEAD_STORE", class_name = "BeadStore" }, ... ]
//
// The rail then reported four violations that did not exist. That direction
// is the cheap one — a phantom finding gets investigated. The expensive
// direction is the same mistake in the other polarity: a pattern that
// under-matches reports CLEAN, and a phantom pass gets trusted.
//
// TOML has a parser. JSON has a parser. Use them.
//
// ── What this flags, and what it deliberately does not ────────────────────
//
// Flagged: reading a `.toml` / `.json` / `.yaml` file and applying regex or
// string surgery to the raw text, when a parser for that format is already a
// dependency. There is no reason to hand-match a format the tree can already
// parse correctly.
//
// NOT flagged:
//   - `.capnp` — no JS parser without a `capnp eval` toolchain dependency, so
//     pattern-matching is the honest option. Where it is used, the shape
//     assumption must be STATED and a non-vacuity floor must guard the
//     under-match direction (see bindingsInConfigCapnp).
//   - `.md`, `.ts`, `.mjs`, logs, and prose — regex is the right tool for
//     unstructured text. `lint-spec-citation` scans markdown with regex and
//     is correct to.
//   - Regex in general. This rule is about FORMATS WITH PARSERS, not about
//     regex being bad.
//
// Escape hatch, same convention as `lint-allow-silent` / `lint-allow-unresolved`:
//
//     lint-allow-rawparse: <why a parser will not do here>
//
// Exit 0 clean, 1 on violations.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ALLOW_MARKER = "lint-allow-rawparse:";

/** Lines above a read that may carry its allow marker + reason. */
export const ALLOW_LOOKBACK = 5;

/** Formats a parser already exists for in this tree. */
export const PARSEABLE = /\.(toml|json|ya?ml)\b/;

/** Reads whose result is handed straight to a parser — the correct shape. */
const PARSED_WRAP = /(?:parseToml|TOML\.parse|JSON\.parse|parse|load)\s*\(\s*readFileSync/;

/** Regex or string-surgery operations applied to text. */
const RAW_OPS = /\.(?:match|matchAll|split|indexOf|substring|slice)\s*\(|new RegExp\b/;

const SKIP_DIR = new Set(["node_modules", "generated", ".git", "archive"]);

/**
 * This rail's own test file, skipped by name.
 *
 * Its fixtures are SYNTHETIC violations written as template-literal strings —
 * the ones that prove the rail bites. Scanning them flags the proof rather
 * than the problem. Narrow and explicit: only this file, only because its
 * string contents are deliberately-wrong code samples.
 */
const SELF_TEST = "lint-structured-parse.test.mjs";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(mjs|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * A violation is a readFileSync of a parseable format whose result is NOT
 * handed to a parser, in a file that also does raw text operations.
 *
 * Line-scoped deliberately: a file may legitimately parse one format and
 * pattern-match another (lint-binding-parity does exactly that — TOML through
 * a parser, capnp by pattern). Flagging the file would punish the correct
 * case, which is how a rule starts getting weakened.
 */
export function findViolations(root = ROOT, dirs = ["scripts", "src"]) {
  const out = [];
  for (const dir of dirs) {
    for (const abs of walk(resolve(root, dir))) {
      if (abs.endsWith(SELF_TEST)) continue;
      const lines = readFileSync(abs, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (!/readFileSync\s*\(/.test(text)) return;
        if (!PARSEABLE.test(text)) return;
        if (PARSED_WRAP.test(text)) return;                    // parsed — correct
        // Look back a few lines: a reasoned marker sits ABOVE its explanation,
        // and a one-line lookback would reject exactly the well-documented
        // exemptions this convention is meant to encourage.
        const preceding = lines.slice(Math.max(0, i - ALLOW_LOOKBACK), i + 1).join("\n");
        const allowed = preceding.includes(ALLOW_MARKER);
        if (allowed) return;
        // Only a problem if the raw text is then operated on. A read that is
        // returned, hashed, or written elsewhere is not hand-parsing.
        const window = lines.slice(i, i + 12).join("\n");
        if (!RAW_OPS.test(window)) return;
        out.push({ file: relative(root, abs), line: i + 1, text: text.trim() });
      });
    }
  }
  return out;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log("lint-structured-parse: clean ✓");
    console.log("  no parseable format is being hand-matched");
    return 0;
  }
  console.error(`lint-structured-parse: ${violations.length} hand-parsed structured file(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(`\n  This format has a parser. Hand-matching it silently misses shapes the`);
  console.error(`  format allows — inline tables, nested arrays, quoting — and the failure`);
  console.error(`  is invisible: an under-matching pattern reports CLEAN.`);
  console.error(`  Use the parser, or add "${ALLOW_MARKER} <reason>" if one genuinely will not do.`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
