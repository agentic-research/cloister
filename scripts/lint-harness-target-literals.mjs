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

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one file allowed to name providers. */
export const DECLARATION_FILE = "cluster.toml ([[gateway.harnessTargets]] + [[gateway.vaultProxyServices]])";

/** Files scanned. The harness path — where a literal would actually bite. */
export const SCANNED = [
  "scripts/harness-dev.mjs",
  "src/harness-shim/index.ts",
];

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
  for (const rel of SCANNED) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue; // a scanned file may legitimately not exist yet
    const lines = readFileSync(abs, "utf8").split("\n");
    let inBlockComment = false;
    lines.forEach((raw, i) => {
      // Comments are exempt, deliberately. A comment cannot hardcode behavior,
      // and the useful thing operators read is usage examples naming both
      // harnesses ("Codex: OPENAI_BASE_URL=…"). Flagging those would force
      // deleting real documentation to satisfy a lint — which is how a rail
      // earns a blanket suppression and stops protecting anything.
      const text = stripComment(raw, inBlockComment);
      inBlockComment = nextBlockState(raw, inBlockComment);
      if (!text.trim()) return;
      for (const pattern of PROVIDER_PATTERNS) {
        if (text.toLowerCase().includes(pattern.toLowerCase())) {
          hits.push({ file: relative(root, abs), line: i + 1, pattern, text: raw.trim() });
          break; // one finding per line is enough to act on
        }
      }
    });
  }
  return hits;
}

/** Code portion of a line, with `//` and `/* … *\/` comment text removed. */
function stripComment(line, inBlock) {
  if (inBlock) {
    const end = line.indexOf("*/");
    return end === -1 ? "" : line.slice(end + 2);
  }
  let out = line;
  const block = out.indexOf("/*");
  if (block !== -1) out = out.slice(0, block);
  const lineComment = out.indexOf("//");
  if (lineComment !== -1) out = out.slice(0, lineComment);
  return out;
}

/** Whether the NEXT line begins inside a block comment. */
function nextBlockState(line, inBlock) {
  if (inBlock) return line.indexOf("*/") === -1;
  const open = line.lastIndexOf("/*");
  if (open === -1) return false;
  return line.indexOf("*/", open) === -1;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log(`lint-harness-target-literals: clean ✓`);
    console.log(`  ${SCANNED.length} file(s) scanned, ${PROVIDER_PATTERNS.length} provider pattern(s)`);
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
