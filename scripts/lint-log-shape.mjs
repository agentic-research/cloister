// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:log-shape — cloister-bd7e51 rail.
//
// On the trust/IO surface, an operational log MUST be structured — one JSON
// object emitted through `logEvent` (src/obs/log.ts) or `console.X(JSON.stringify(…))`.
// This rail forbids the opposite: an ad-hoc STRING log, `console.warn("…")` /
// `console.error(`…`)`, whose first argument is a string or template literal.
//
// Why string logs specifically: they are the cloister-3ad090 class. An
// unstructured message (a) can't be queried on a stable schema (the "silence is
// evidence" audit, §13.2, has to re-parse prose), and (b) interpolates values
// into a string with no redaction seam, so a secret can leak the moment someone
// drops one into the template. `logEvent` gives both — a fixed {target,op,outcome}
// spine and secret-field redaction — so the fix is always "use logEvent".
//
// Structured emits are NOT flagged: the §13.4 denial-audit plane
// (`buildDenialAuditEntry`), the ReceiptEmitter/MetricEmitter `{kind:…}` contract,
// and the credential-isolation/v1 error schema all pass `JSON.stringify(…)` as
// the first argument (not a string literal) and stay on their own schemas.
//
// A genuine exception carries an inline `lint-allow-string-log: <reason>` on the
// call line or within the three lines above it. Edit-stable, self-documenting —
// same annotation discipline as lint:silent-swallow.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// The trust/IO surface: the storage/wire/routes dirs plus the two top-level
// trust DOs. Operational logs here feed the audit; ad-hoc strings must not.
const SCAN_DIRS = ["src/storage", "src/wire", "src/routes"].map((d) => resolve(REPO_ROOT, d));
const SCAN_FILES = ["src/trust-store.ts", "src/vault-store.ts"].map((f) => resolve(REPO_ROOT, f));

const SINKS = [
  "console.warn(",
  "console.error(",
  "console.log(",
  "console.info(",
  "console.debug(",
];
const QUOTE_CHARS = ['"', "'", "`"];
const WHITESPACE = [" ", "\t", "\r", "\n"];
const ALLOW_MARKER = "lint-allow-string-log";

function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listTsFiles(abs));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** 1-based line number for a character index, by counting newlines. Pure. */
function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * True if `lint-allow-string-log` appears on the sink's own line or any of the
 * three lines above it (so the justification can sit in a comment above the call).
 */
function isAllowed(lines, lineNo) {
  const from = Math.max(0, lineNo - 4); // lineNo is 1-based; look back 3 lines
  for (let i = from; i < lineNo; i++) {
    if (lines[i] !== undefined && lines[i].includes(ALLOW_MARKER)) return true;
  }
  return false;
}

/**
 * Find ad-hoc string-log violations in one file's text. A violation is a
 * `console.X(` call whose first argument — the first non-whitespace character
 * after the opening paren, scanning across line breaks — is a string or template
 * literal, and which is not justified by an inline allow marker. Pure; exported
 * for tests. `rel` is the repo-relative POSIX path (for messages).
 */
export function findStringLogs(rel, text) {
  const violations = [];
  const lines = text.split("\n");
  for (const sink of SINKS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(sink, from);
      if (at < 0) break;
      from = at + sink.length;
      // First non-whitespace char after the opening paren (may be on a later line).
      let j = from;
      while (j < text.length && WHITESPACE.includes(text[j])) j++;
      if (j >= text.length) continue;
      if (!QUOTE_CHARS.includes(text[j])) continue; // structured (JSON.stringify/logEvent/var) — OK
      const lineNo = lineNumberAt(text, at);
      if (isAllowed(lines, lineNo)) continue;
      violations.push({ rel, line: lineNo });
    }
  }
  // Stable order for deterministic output.
  violations.sort((a, b) => a.line - b.line);
  return violations;
}

/** Walk the trust/IO surface and collect violations. */
export function collectStringLogs() {
  const violations = [];
  const files = [...SCAN_FILES];
  for (const dir of SCAN_DIRS) files.push(...listTsFiles(dir));
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    violations.push(...findStringLogs(rel, readFileSync(abs, "utf8")));
  }
  return violations;
}

// ── CLI ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = collectStringLogs();
  if (violations.length > 0) {
    console.error("lint-log-shape: FAIL — ad-hoc string logging on the trust/IO surface (cloister-bd7e51):");
    for (const v of violations) console.error(`  ✘ ${v.rel}:${v.line}`);
    console.error("\n  An operational log here must be STRUCTURED — use `logEvent` from src/obs/log.ts");
    console.error("  ({target, op, outcome, …} with secret-field redaction), not an ad-hoc string.");
    console.error("  A string log can't be queried on a stable schema and has no redaction seam —");
    console.error("  the cloister-3ad090 class. Justify a real exception with an inline");
    console.error("  `lint-allow-string-log: <reason>` on or just above the call.");
    process.exit(1);
  }
  console.log("lint-log-shape: OK — no ad-hoc string logging on the trust/IO surface.");
}
