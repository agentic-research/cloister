#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:origin-derivation — a Confidence is DERIVED, never declared (ADR-0065
// decision 3, cloister-16f81c).
//
// The ADR's claim is that confidence is a consequence of provenance rather than
// a value someone sets. A type alias cannot enforce that: `const c: Confidence =
// "attested"` type-checks perfectly and is exactly the defect — an artifact
// asserting a property of its own provenance that nothing verified.
//
// So the rule is locality, in the same shape as `lint:lease-gate-source` (the
// root pubkey is read only in its resolver) and `lint:trust-env-locality` (a
// trust secret is read only in its own resolver): the Confidence vocabulary
// lives in ONE module, and everywhere else obtains a value by calling it.
//
// Why this rail and not a propagation check: phase 1 has a single composing
// stage, so a "did you union your inputs' origin sets" check would have nothing
// to compare and would pass vacuously. This one has teeth on day one, and the
// propagation rail becomes checkable when phase 2 adds the second stage.
//
// Exit 0 clean, 1 on violations.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The one module allowed to name the vocabulary. Everything else calls
 * `deriveConfidence` / `mayAttestFully`.
 */
export const OWNER = "src/wire/origin.ts";

/**
 * The Confidence values, deliberately PREFIXED.
 *
 * A first draft matched bare "attested"/"asserted"/"unknown" and fired seven
 * times on the shipped tree — author defaults, error codes, an HTTP fallback —
 * every one a false positive, because "unknown" is a word this codebase already
 * uses for unrelated things. A rail that cries wolf gets an allow-marker pasted
 * over it and stops meaning anything.
 *
 * Prefixing made the vocabulary distinctive instead of widening the exemption
 * list, which is the same fix `lint:schema-claim` needed when LLO adopted a name
 * cloister already owned: when a check collides with ordinary usage, narrow what
 * it OWNS rather than enumerating what it forgives.
 */
export const CONFIDENCE_LITERALS = ["origin-attested", "origin-asserted", "origin-unknown"];

/**
 * Same escape-hatch shape as `lint:silent-swallow`'s `lint-allow-silent:` —
 * explicit, reasoned, greppable, per-line rather than a directory carve-out.
 * Write it on the offending line or the one above.
 */
export const ALLOW_MARKER = "lint-allow-confidence-literal:";

const LITERAL_RE = new RegExp(
  `(["'\`])(${CONFIDENCE_LITERALS.join("|")})\\1`,
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

export function findViolations(root = ROOT) {
  const violations = [];
  for (const file of walk(join(root, "src"))) {
    const rel = relative(root, file).split("\\").join("/");
    if (rel === OWNER) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!LITERAL_RE.test(line)) return;
      // A line that only mentions the word inside a comment is fine; the regex
      // already requires quotes, so this narrows further to actual code.
      const code = line.split("//")[0];
      if (!LITERAL_RE.test(code)) return;
      if (line.includes(ALLOW_MARKER)) return;
      if ((lines[i - 1] ?? "").includes(ALLOW_MARKER)) return;
      violations.push({ file: rel, line: i + 1, text: line.trim() });
    });
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findViolations();
  if (violations.length > 0) {
    console.error(
      `lint:origin-derivation: ${violations.length} declared Confidence value(s).\n` +
      `A Confidence must come from deriveConfidence() in ${OWNER} — a literal is a\n` +
      `claim about provenance that nothing verified, which is the defect ADR-0065\n` +
      `decision 3 exists to remove.\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error(
      `\nIf a literal is genuinely right here (a test fixture, a wire-format\n` +
      `constant), say why on the line or the one above:\n` +
      `  ${ALLOW_MARKER} <reason>`,
    );
    process.exit(1);
  }
  console.log(
    `lint-origin-derivation: OK — Confidence is produced only by ${OWNER}.`,
  );
}
