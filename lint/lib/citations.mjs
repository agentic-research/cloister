// SPDX-License-Identifier: AGPL-3.0-or-later
//
// File citations in prose a rail holds to the tree (Inv 15), and the exits an
// exemption's rationale names (Inv 13, ADR-0080).
//
// A rationale records why something is so, and a citation is its evidence.
// When the cited file is deleted or the cited line is gone, the rationale
// keeps reading as justified while it justifies nothing: two exemptions in
// cluster.toml cited `krunvm.rs:769` as their structural blocker for months
// after #262 deleted krunvm.rs and replaced what it could not do.
//
// A citation is a file name with a known extension, alone or with a path,
// optionally followed by `:<line>`. One written `<repo>:<path>` names another
// repository's file and is not this tree's to check.

const EXTENSIONS = ["rs", "mjs", "js", "ts", "go", "toml", "capnp", "md", "yaml", "yml", "json", "sh"];

// Not inside a larger token on the left (so `repo:path` and `a/b.rs` are read
// whole), and not continued on the right except by sentence punctuation.
const CITATION = new RegExp(
  String.raw`(?<![\w./:-])((?:[\w.-]+/)*[\w.-]+\.(?:${EXTENSIONS.join("|")}))(?::(\d+))?(?![\w/-]|\.\w)`,
  "g",
);

/**
 * The citations in `text` that do not resolve: each as a sentence naming the
 * citation and why. `tracked` is every tracked file's repository-relative
 * path; `lineCount(path)` answers how many lines a tracked file has.
 *
 * @param {string} text
 * @param {string[]} tracked
 * @param {(path: string) => number} lineCount
 * @returns {string[]}
 */
export function staleCitations(text, tracked, lineCount) {
  const problems = [];
  for (const match of text.matchAll(CITATION)) {
    const [cited, path, line] = match;
    const named = path.includes("/")
      ? tracked.filter((file) => file === path)
      : tracked.filter((file) => file.split("/").pop() === path);
    if (named.length === 0) {
      problems.push(
        `${JSON.stringify(cited)}, and no tracked file ${path.includes("/") ? "is at that path" : "has that name"}`,
      );
      continue;
    }
    if (line !== undefined && !named.some((file) => lineCount(file) >= Number(line))) {
      problems.push(`${JSON.stringify(cited)}, and ${named.join(" / ")} has fewer than ${line} lines`);
    }
  }
  return problems;
}

// A work item an exemption's rationale names as its exit (ADR-0080): a bead
// (`cloister-5fe44f`, `ley-line-open-e6b1bb`), an issue in a named repository
// (`ley-line-open#600`) or an ADR (`ADR-0079`). A bare `#262` is not one: it
// names a change already made, not the work that ends an exemption.
const EXIT = /\b(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{6}|[a-z][a-z0-9-]*#\d+|ADR-\d{4})\b/g;

/** The work items `text` names as exits, in order. */
export function namedExits(text) {
  return [...text.matchAll(EXIT)].map((match) => match[0]);
}

// The category labels exemption rationales opened with before ADR-0080. Each
// claimed something about the exemption instead of naming its exit, and
// "structural" and "permanent" claimed that no exit existed.
const RETIRED_LABEL = /^\s*(STRUCTURAL|PERMANENT|CONTINGENT|UNDECIDED)\b/i;

/** The retired label `text` opens with, or null. */
export function retiredLabel(text) {
  return RETIRED_LABEL.exec(text)?.[1] ?? null;
}
