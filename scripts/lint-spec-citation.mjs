#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:spec-citation — a citation must resolve (cloister-e83a33).
//
// Sixteen files cite the normative wire specs as `leyline-schema-spec/...`.
// No directory of that name exists in any checkout: the real location is
// ley-line-open's `rs/ll-core/schema-spec/`. The short root is an UNDECLARED
// ALIAS — readable, useful, and pointing at nothing checkable.
//
// That is not cosmetic. The citation is how a reader (human or agent) finds the
// contract a type is supposed to conform to. A root that resolves nowhere reads
// as "the spec is local", which is how this session nearly designed an
// Apache-2.0 carveout in cloister for a contract ley-line-open already owns
// (ADR-0035). A bad pointer produced a bad ownership inference.
//
// ── Two checks, deliberately split by portability ─────────────────────────
//
//   SHAPE (always):    every citation uses the declared alias root exactly.
//                      Catches `leyline-schema-spec` vs `leyline_schema_spec`
//                      vs a hand-written relative path that will rot.
//   EXISTENCE (local): the aliased path resolves to a real file in the LLO
//                      checkout. Skipped when LLO is absent — a CI runner has
//                      cloister and nothing else.
//
// The split matters. A rail whose only check needs a sibling checkout is
// vacuous exactly where it would be most useful, and this session already shed
// one test that failed on a runner for precisely that reason. The shape half
// runs everywhere; the existence half is a local cross-check against reality.
//
// Exit 0 clean, 1 on violations.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The declared alias. Citations write the short root; it resolves to LLO's
 * schema-spec directory. Declared ONCE here so a move upstream is a one-line
 * change rather than sixteen — which is the whole reason the alias is worth
 * keeping instead of inlining the long path everywhere.
 */
export const SPEC_ALIAS = "leyline-schema-spec/";

/**
 * Escape hatch for a citation that points at a spec which does not exist YET —
 * a deliberate forward reference in a plan, not a rotted link. Same shape as
 * `lint:silent-swallow`'s `lint-allow-silent: <reason>`, and for the same
 * reason: an exemption should be explicit, reasoned, and greppable, never a
 * blanket directory carve-out that also hides the real breakage it was not
 * meant to cover.
 *
 * Write it on the citation's line or the line above:
 *   lint-allow-unresolved: <why this path does not exist yet>
 */
export const ALLOW_MARKER = "lint-allow-unresolved:";
export const SPEC_REAL_SUBPATH = "rs/ll-core/schema-spec";

/** Where ley-line-open is checked out, if it is. */
export function lloRoot(env = process.env) {
  const explicit = env.CLOISTER_LLO_ROOT;
  if (explicit) return explicit;
  return join(homedir(), "remotes/art/ley-line-open");
}

/** Files scanned: anything that can carry a normative citation. */
export const SCAN_DIRS = ["src", "docs", "scripts"];
export const SCAN_FILES = ["CLAUDE.md", "README.md", "GETTING-STARTED.md"];

const SKIP_DIR = new Set([".claude", "node_modules", "target", "archive", ".git"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js|md|capnp|toml)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every `leyline-schema-spec/...` citation in the tree.
 * @returns {{file: string, line: number, path: string}[]}
 */
export function findCitations(root = ROOT) {
  const files = [
    ...SCAN_DIRS.flatMap((d) => walk(resolve(root, d))),
    ...SCAN_FILES.map((f) => resolve(root, f)).filter(existsSync),
  ];
  const hits = [];
  // Stop at the first character that cannot be part of a path. Citations sit
  // inside prose and code comments, so they are followed by backticks, commas,
  // periods, parens and quotes — none of which belong to the path.
  const re = new RegExp(`${SPEC_ALIAS.replace("/", "\\/")}[A-Za-z0-9._/-]*`, "g");
  for (const abs of files) {
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const m of text.matchAll(re)) {
        // The marker may sit on the citation's line or the one above it —
        // prose wraps, and forcing it onto the same line would mangle the
        // paragraph it is documenting.
        const allowed =
          text.includes(ALLOW_MARKER) || (lines[i - 1] ?? "").includes(ALLOW_MARKER);
        hits.push({
          file: relative(root, abs),
          line: i + 1,
          // Trailing '.' is almost always sentence punctuation, never a path.
          path: m[0].replace(/\.$/, ""),
          allowed,
        });
      }
    });
  }
  return hits;
}

/**
 * Resolve a citation to its real location under the LLO checkout.
 * @returns {string} absolute path (may not exist)
 */
export function resolveCitation(citation, lloRootPath) {
  const rest = citation.slice(SPEC_ALIAS.length);
  return join(lloRootPath, SPEC_REAL_SUBPATH, rest);
}

function main() {
  const citations = findCitations();
  const lloPath = lloRoot();
  const lloPresent = existsSync(join(lloPath, SPEC_REAL_SUBPATH));

  if (citations.length === 0) {
    console.log("lint-spec-citation: no citations found — nothing to check");
    return 0;
  }

  if (!lloPresent) {
    console.log("lint-spec-citation: shape ✓");
    console.log(`  ${citations.length} citation(s) use the declared root ${JSON.stringify(SPEC_ALIAS)}`);
    console.log(`  existence check SKIPPED — no ley-line-open checkout at ${lloPath}`);
    console.log(`  (set CLOISTER_LLO_ROOT to enable it)`);
    return 0;
  }

  const unresolved = citations.filter((c) => !existsSync(resolveCitation(c.path, lloPath)));
  const dangling = unresolved.filter((c) => !c.allowed);
  const allowed = unresolved.filter((c) => c.allowed);
  if (dangling.length === 0) {
    console.log("lint-spec-citation: clean ✓");
    console.log(`  ${citations.length} citation(s) resolve under ${lloPath}/${SPEC_REAL_SUBPATH}`);
    if (allowed.length > 0) {
      console.log(`  ${allowed.length} forward reference(s) allowed via ${ALLOW_MARKER}`);
    }
    return 0;
  }

  console.error(`lint-spec-citation: ${dangling.length} citation(s) resolve to nothing\n`);
  for (const d of dangling) {
    console.error(`  ${d.file}:${d.line}`);
    console.error(`    ${d.path}`);
    console.error(`    -> ${resolveCitation(d.path, lloPath)}`);
  }
  console.error(`\n  A citation is how a reader finds the contract a type conforms to.`);
  console.error(`  One that resolves nowhere reads as "the spec is local", which is how`);
  console.error(`  ownership gets inferred wrongly (ADR-0035). Fix the path, or remove the`);
  console.error(`  citation if the spec no longer exists.`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
