// scripts/lint-mermaid.mjs
//
// Lightweight mermaid linter — catches the breakage classes that
// GitHub's renderer chokes on most often:
//   1. Edge references to undeclared node IDs (the README ATTEST/TRUST
//      bug from 2026-05-09)
//   2. style/class blocks naming a node that doesn't exist
//
// Not a full parser — just enough to catch the regressions we've hit.
// For full mermaid syntax validation we'd need @mermaid-js/mermaid-cli
// (mmdc), which is a ~150MB chromium dep; this script is ~100 lines.
//
// Usage: node scripts/lint-mermaid.mjs <file.md> [file2.md ...]
// Exits non-zero on any error; logs file:line context.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const IDENT = "[A-Za-z_][A-Za-z0-9_-]*";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: lint-mermaid.mjs <file.md> [...]");
  process.exit(2);
}

let totalErrors = 0;
for (const file of files) {
  const errs = lintFile(file);
  if (errs.length > 0) {
    console.error(`\n${file}: ${errs.length} issue(s)`);
    for (const e of errs) console.error(`  ${e}`);
    totalErrors += errs.length;
  }
}

if (totalErrors > 0) {
  console.error(`\n${totalErrors} mermaid issue(s) — see above`);
  process.exit(1);
}
console.log(`mermaid lint clean (${files.length} file${files.length === 1 ? "" : "s"})`);

function lintFile(path) {
  const text = readFileSync(resolve(path), "utf-8");
  const lines = text.split("\n");
  const errors = [];

  let inBlock = false, blockStart = 0, blockLines = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inBlock && l.trim() === "```mermaid") {
      inBlock = true;
      blockStart = i + 2;
      blockLines = [];
    } else if (inBlock && l.trim() === "```") {
      errors.push(...lintBlock(blockLines, blockStart));
      inBlock = false;
    } else if (inBlock) {
      blockLines.push(l);
    }
  }
  return errors;
}

function lintBlock(lines, startLineNo) {
  const errors = [];
  const declared = new Set();

  // ── Pass 1: collect declared node IDs ─────────────────────────────────
  //
  // Mermaid declares nodes via `ID[...]`, `ID(...)`, `ID{...}`, `ID>...]`,
  // `ID(("..."))`, etc. The shape on the LEFT of the bracket-pair is the
  // ID. Also collect subgraph names and bare-ID node-list members.
  for (const raw of lines) {
    const line = stripComments(raw);  // DON'T strip labels here — the brackets are the trigger
    for (const m of line.matchAll(new RegExp(`\\b(${IDENT})\\s*(?:\\[|\\(|\\{|>)`, "g"))) {
      declared.add(m[1]);
    }
    const sg = line.match(new RegExp(`^\\s*subgraph\\s+(${IDENT})`));
    if (sg) declared.add(sg[1]);
  }

  // ── Pass 2: validate edges ─────────────────────────────────────────────
  //
  // Strip labels FIRST so a `-->|label words| TGT` doesn't match `words` as
  // a target. Then look for edge-shape tokens (-->, ==>, -.->, etc.) and
  // grab the IDENT immediately on each side.
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripLabels(stripComments(raw));
    if (/^\s*(subgraph|style|class|classDef|click|direction|end)\b/.test(line)) continue;

    // Edge token catalog (mermaid grammar):
    //   solid arrow:    -->  ---  ----  (etc.)
    //   dotted:         -.->  -.-
    //   thick:          ==>  ===
    //   open arrow:     -->  --o  --x  (with different heads)
    // We capture: <SRC IDENT><optional spaces><edge token><optional spaces><TGT IDENT>.
    // To avoid false-matching word boundaries inside text, only match
    // IDENTs that are immediately adjacent to the edge token (separated
    // only by whitespace).
    const edgeRe = new RegExp(
      `(${IDENT})\\s*(?:-{2,}|={2,}|-\\.+-)(?:o|x|>|)\\s*(${IDENT})`,
      "g",
    );
    for (const m of line.matchAll(edgeRe)) {
      const [, src, tgt] = m;
      for (const id of [src, tgt]) {
        if (!declared.has(id)) {
          errors.push(`L${startLineNo + i}: edge references undeclared node \`${id}\` — github mermaid renderer will fail or auto-stub`);
        }
      }
    }
  }

  // ── Pass 3: style/class blocks ─────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = stripComments(lines[i]);
    const styleMatch = line.match(new RegExp(`^\\s*style\\s+(${IDENT})`));
    if (styleMatch && !declared.has(styleMatch[1])) {
      errors.push(`L${startLineNo + i}: style block names undeclared node \`${styleMatch[1]}\``);
    }
    const classMatch = line.match(new RegExp(`^\\s*class\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*)`));
    if (classMatch) {
      for (const id of classMatch[1].split(",").map(s => s.trim())) {
        if (!declared.has(id)) {
          errors.push(`L${startLineNo + i}: class block names undeclared node \`${id}\``);
        }
      }
    }
  }

  return errors;
}

function stripComments(line) {
  return line.replace(/%%.*$/, "");
}

function stripLabels(line) {
  // Strip edge labels `|...|`, node-shape contents `[...]`, `(...)`,
  // `{...}` so we only see the ID skeletons. Done lazily: we walk
  // the line and replace each balanced group with a placeholder of
  // equal length so column offsets stay roughly stable.
  //
  // Mermaid's actual grammar permits nesting (e.g. `[("text")]`) but
  // for our purposes (catch undeclared edge targets) flat is enough.
  return line
    .replace(/\|[^|]*\|/g, (m) => " ".repeat(m.length))   // edge labels
    .replace(/\[\[[^\]]*\]\]/g, (m) => " ".repeat(m.length))  // [[label]]
    .replace(/\[\([^)]*\)\]/g, (m) => " ".repeat(m.length))   // [(label)]
    .replace(/\[\/[^\\]*\/\]/g, (m) => " ".repeat(m.length))  // [/label/]
    .replace(/\[\\[^/]*\/\]/g, (m) => " ".repeat(m.length))   // [\label/]
    .replace(/\(\([^)]*\)\)/g, (m) => " ".repeat(m.length))   // ((label))
    .replace(/\[[^\]]*\]/g, (m) => " ".repeat(m.length))      // [label]
    .replace(/\([^)]*\)/g, (m) => " ".repeat(m.length))       // (label)
    .replace(/\{[^}]*\}/g, (m) => " ".repeat(m.length))       // {label}
    .replace(/>[^\]]*\]/g, (m) => " ".repeat(m.length));      // >label]
}
