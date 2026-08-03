#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:schema-claim — claiming a contract means generating it (cloister-3e86e8).
//
// A source file that writes a leyline contract identifier as a STRING LITERAL is
// claiming to speak that contract on the wire. The field names of every such
// contract are owned by ley-line-open and reach cloister through schema-bridge.
// A file that makes the claim without importing generated types is stating a
// wire shape from memory.
//
// This exists because that failed, silently, in one week. PR #260 shipped
//
//     return { schema: "execution/v1", ...policy }
//
// over a hand-written ten-field list. The canonical RunSpec has ELEVEN fields
// and shares NONE of those ten names — the mapping emitted an object the
// contract rejects outright, and `task lint` passed green throughout. Nothing
// could have caught it, because nothing was looking: `lint:spec-citation`
// polices `leyline-schema-spec/...` prose citations, not code-level claims, and
// `type-duplication` polices cluster.capnp's mirror only. Per ADR-0063.
//
// ── The check ────────────────────────────────────────────────────────────────
//
// For each contract in CONTRACTS, any file under cli/ or src/ containing that
// identifier inside a quoted string must import from `src/generated/`.
//
// Quoted-literal only, deliberately. Prose in a comment DISCUSSES a contract;
// a string literal SPEAKS it. This module's own header names execution/v1 nine
// times and is correct to — the distinction is the whole point, and a rail that
// forbade discussion would push the reasoning out of the file that needs it.
//
// Adding a contract here is the cheap half of consuming a new leyline schema.
// Add it in the same change as the first line of code that speaks it.
//
// Exit 0 clean, 1 on violations.

import { readFileSync, globSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Leyline contracts cloister may speak. The identifier as it appears on the wire.
const CONTRACTS = ["execution/v1"];

const GENERATED_IMPORT = /from\s+["'][^"']*\/generated\/|import\(["'][^"']*\/generated\//;

/**
 * Strip comments, keeping string literals intact.
 *
 * Needed because a backtick in JSDoc is markdown, not a template literal — the
 * first cut of this rail failed on its OWN header, which quotes `execution/v1`
 * in prose to explain the distinction it enforces. Scanning for quotes without
 * knowing what is a comment cannot tell discussion from claim, which is the one
 * judgement this rail exists to make.
 *
 * A single pass tracking string/comment state. Not a JS parser: it does not
 * resolve regex-literal-vs-division, the one ambiguity that needs real parsing.
 * A `/`-delimited regex containing a contract identifier would be misread — and
 * would still be a claim, so the failure mode is a false POSITIVE that a human
 * reads and corrects, never a silent miss.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; i += 2; continue; }
      if (c === "\n") out += c; // keep line numbering usable
      i++; continue;
    }
    // inside a string literal
    if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') ||
        (state === "tpl" && c === "`")) state = "code";
    out += c; i++;
  }
  return out;
}

// A contract identifier inside a single-quoted, double-quoted, or template string.
function claimsContract(code, contract) {
  const escaped = contract.replace(/[/.]/g, "\\$&");
  return new RegExp(`["'\`][^"'\`\\n]*${escaped}[^"'\`\\n]*["'\`]`).test(code);
}

const files = globSync("{cli,src}/**/*.{mjs,ts}", { cwd: ROOT })
  .filter((f) => !f.includes("/generated/"));

const violations = [];

for (const rel of files) {
  const text = readFileSync(resolve(ROOT, rel), "utf8");
  const code = stripComments(text);
  for (const contract of CONTRACTS) {
    if (!claimsContract(code, contract)) continue;
    if (GENERATED_IMPORT.test(code)) continue;
    violations.push(
      `${rel}: speaks "${contract}" as a string literal but imports no generated types`,
    );
  }
}

if (violations.length > 0) {
  console.error("lint-schema-claim: FAIL — a contract is claimed but not generated:");
  for (const v of violations) console.error(`  ✘ ${v}`);
  console.error("\n  A contract identifier in a string literal is a wire claim. Its");
  console.error("  field names are owned by ley-line-open and reach cloister through");
  console.error("  schema-bridge — generate them, do not restate them. If the schema");
  console.error("  is not published yet, do not claim the contract yet. Per ADR-0063.");
  process.exit(1);
}

console.log(
  `lint-schema-claim: clean ✓ (${files.length} file(s) scanned, ` +
    `${CONTRACTS.length} contract(s), 0 ungenerated claims)`,
);
