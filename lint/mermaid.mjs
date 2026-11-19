// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/mermaid.mjs — every mermaid diagram in a tracked markdown file draws.
//
// Two checks, because they catch different things:
//
//   1. The diagram PARSES, by mermaid's own parser. A diagram that does not
//      parse is shown on GitHub as an error box where the picture should be,
//      and nothing else in the repository notices.
//   2. Three shapes that parse and still go wrong on GitHub, found by hand
//      matching (the README ATTEST/TRUST bug, 2026-05-09): an edge to a node
//      that was never declared (mermaid invents an empty box for it), a
//      style/class line naming such a node, and an unquoted bracket inside an
//      edge label.
//
// The parser runs in Node against a jsdom window: mermaid sanitises label
// text through DOMPurify, which needs one. Nothing is rendered and no browser
// is started. The earlier version of this file did check 2 only, on two named
// files, because a real parse was thought to need a browser.
//
// Usage: node lint/mermaid.mjs [file.md ...]
//   With no files, every tracked markdown file is checked.
// Exits non-zero on any error; logs file:line context.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDENT = "[A-Za-z_][A-Za-z0-9_-]*";

/** Every tracked markdown file, relative to the repository root. */
export function trackedMarkdown(root = ROOT) {
  return execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** The mermaid blocks of one markdown text: `{ line, lines }`, `line` 1-based. */
export function mermaidBlocks(text) {
  const blocks = [];
  let open = null;
  text.split("\n").forEach((l, i) => {
    if (!open && l.trim() === "```mermaid") open = { line: i + 2, lines: [] };
    else if (open && l.trim() === "```") { blocks.push(open); open = null; }
    else if (open) open.lines.push(l);
  });
  return blocks;
}

let parser;
/** mermaid's parser, loaded once. It reads `window` and `document` at import. */
async function mermaidParser() {
  if (parser) return parser;
  const { JSDOM } = await import("jsdom");
  const { window } = new JSDOM("<!doctype html><body></body>");
  globalThis.window = window;
  globalThis.document = window.document;
  for (const name of ["Element", "HTMLElement", "Node", "DOMParser"]) globalThis[name] = window[name];
  parser = (await import("mermaid")).default;
  return parser;
}

/**
 * The problems in one markdown text, as `L<line>: <what>` strings.
 * @param {string} text
 * @returns {Promise<string[]>}
 */
export async function lintMarkdown(text) {
  const errors = [];
  const mermaid = await mermaidParser();
  for (const block of mermaidBlocks(text)) {
    try {
      await mermaid.parse(block.lines.join("\n"));
    } catch (error) {
      // The parser's message is several lines: the line, a caret, what it expected.
      const [first, ...rest] = String(error?.message ?? error).split("\n");
      const at = first.match(/line (\d+)/)?.[1];
      const line = at ? block.line + Number(at) - 1 : block.line;
      errors.push(`L${line}: does not parse: ${[first, ...rest.slice(0, 3)].join(" | ")}`);
      continue; // the hand checks below assume a diagram that parses
    }
    errors.push(...lintBlock(block.lines, block.line));
  }
  return errors;
}

async function main(argv) {
  const files = argv.length ? argv : trackedMarkdown();
  let total = 0;
  let diagrams = 0;
  let withDiagrams = 0;
  for (const file of files) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    const count = mermaidBlocks(text).length;
    if (count === 0) continue;
    diagrams += count;
    withDiagrams += 1;
    const errors = await lintMarkdown(text);
    if (errors.length > 0) {
      console.error(`\n${file}: ${errors.length} issue(s)`);
      for (const e of errors) console.error(`  ${e}`);
      total += errors.length;
    }
  }
  if (total > 0) {
    console.error(`\n${total} mermaid issue(s) — see above`);
    return 1;
  }
  console.log(`mermaid lint clean (${diagrams} diagrams in ${withDiagrams} files)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
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

  // ── Pass 2.5: edge labels with special chars need quoting ─────────────
  //
  // GitHub's mermaid parser rejects `|... (foo) ...|` — unquoted parens
  // inside edge labels. The fix is `|"... (foo) ..."|`. Local renderers
  // are more permissive, but GH's strict mode is the ground truth we
  // care about for README display.
  for (let i = 0; i < lines.length; i++) {
    const line = stripComments(lines[i]);
    // Match pipe-delimited edge labels: |...|
    // If the content contains an unquoted ( ) [ ] or { },
    // flag it. Already-quoted (`|"..."|`) is fine.
    for (const m of line.matchAll(/\|([^|]*)\|/g)) {
      const content = m[1];
      const trimmed = content.trim();
      const isQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
      const hasSpecial = /[()\[\]{}]/.test(content);
      if (hasSpecial && !isQuoted) {
        errors.push(`L${startLineNo + i}: edge label \`|${content}|\` contains special chars (parens/brackets/braces) — wrap with double quotes \`|"..."|\` for GitHub mermaid render`);
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
