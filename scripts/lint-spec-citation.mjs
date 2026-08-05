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
import { readInputVersion } from "./lint-upstream-pins.mjs";
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

/**
 * A mirror declaring which SPEC VERSION it mirrors — `confinement/v1 @ v0.7.3`.
 *
 * cloister hand-mirrors LLO specs into typed operator surfaces
 * (`manifest/cluster.capnp`'s `struct Confinement`), and those mirrors state the
 * version they were written against. Nothing compared that statement to the
 * version the tree actually pins, so the confinement mirror sat at v0.7.3 while
 * the tree moved to v0.17.0 — nine minor releases, during which the spec gained
 * a dimension (§6 `unixSocket.allow`) and renumbered three sections underneath
 * ~20 citations that all silently became wrong (cloister-d303b2).
 *
 * `lint:upstream-pins` already enforces ONE ley-line-open version across the
 * input ref, the Cargo pins and the generator lock. A mirror's declared version
 * is a fourth hand-stated channel it did not know about. This is that channel.
 *
 * Deliberately the PORTABLE half: it compares two strings inside cloister and
 * needs no sibling checkout, so unlike the existence check it runs everywhere —
 * which matters, because this is the failure that took nine releases to notice.
 */
/** This rail's own definition and test — see the filter in `mirrorVersionDrift`. */
export const RAIL_OWN_FILES = new Set([
  "scripts/lint-spec-citation.mjs",
  "scripts/test/lint-spec-citation.test.mjs",
]);

export const MIRROR_VERSION_RE = /([a-z][\w-]*\/v\d+)\s*@\s*v?(\d+\.\d+\.\d+)/g;

/**
 * Every mirror-version declaration in the tree, with where it was found.
 * @returns {{file: string, line: number, spec: string, declared: string}[]}
 */
export function collectMirrorVersions(root = ROOT) {
  const files = [
    ...SCAN_DIRS.flatMap((d) => walk(resolve(root, d))),
    ...SCAN_FILES.map((f) => resolve(root, f)).filter(existsSync),
  ];
  const out = [];
  for (const abs of files) {
    readFileSync(abs, "utf8").split("\n").forEach((text, i) => {
      for (const m of text.matchAll(new RegExp(MIRROR_VERSION_RE.source, "g"))) {
        out.push({ file: relative(root, abs), line: i + 1, spec: m[1], declared: m[2] });
      }
    });
  }
  return out;
}

/**
 * Mirror declarations that disagree with the pinned ley-line-open version.
 * @returns {{file: string, line: number, spec: string, declared: string, pinned: string}[]}
 */
export function mirrorVersionDrift(root = ROOT, pinned = pinnedLloVersion()) {
  if (!pinned) return [];
  return collectMirrorVersions(root)
    // The files that DEFINE and TEST this rail name versions by way of example
    // — the docstring explains the drift it catches, the test fixture has to
    // reproduce it. Same carve-out `lint:origin-derivation` makes for its owner,
    // and for the same reason: the module that defines a vocabulary has to be
    // able to write it down, and so does the test that proves it fires.
    .filter((m) => !RAIL_OWN_FILES.has(m.file))
    .filter((m) => m.declared !== pinned)
    .map((m) => ({ ...m, pinned }));
}

function pinnedLloVersion() {
  try {
    const [first] = readInputVersion();
    return first?.version ?? null;
  } catch {
    // lint-allow-silent: an unreadable cluster.toml is lint:upstream-pins' to
    // report. Returning null here disables only the comparison, which is the
    // correct degradation: we cannot claim drift against a version we could
    // not read.
    return null;
  }
}

/** Where ley-line-open is checked out, if it is. */
export function lloRoot(env = process.env) {
  const explicit = env.CLOISTER_LLO_ROOT;
  if (explicit) return explicit;
  return join(homedir(), "remotes/art/ley-line-open");
}

/** Files scanned: anything that can carry a normative citation. */
// `manifest` and `cli` carry the hand-mirrored operator surfaces — `struct
// Confinement` in cluster.capnp and the harness builders — which is exactly
// where a mirror states the spec version it was written against. Their absence
// is why the v0.7.3 declaration went nine releases unnoticed: the rail that
// would have caught it was not looking at the file that had it.
export const SCAN_DIRS = ["src", "docs", "scripts", "manifest", "cli"];
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

  // ── Mirror-version agreement (cloister-d303b2) ──────────────────────────
  //
  // Runs FIRST and unconditionally, because it is the portable half: it
  // compares two strings inside cloister and needs no sibling checkout. The
  // existence check below degrades to a skip without LLO; this one must not,
  // since a CI runner with no LLO is exactly where a stale mirror would
  // otherwise sit unnoticed — which is how v0.7.3 survived to v0.17.0.
  const drift = mirrorVersionDrift();
  if (drift.length > 0) {
    console.error(
      `lint-spec-citation: ${drift.length} mirror(s) declare a spec version the tree does not pin\n`,
    );
    for (const d of drift) {
      console.error(`  ${d.file}:${d.line}`);
      console.error(`    declares ${d.spec} @ v${d.declared}, tree pins v${d.pinned}`);
    }
    console.error(`\n  A hand-mirrored operator surface states the spec version it was`);
    console.error(`  written against. Nothing compared that to the pinned version, so the`);
    console.error(`  confinement mirror sat at v0.7.3 while the tree moved to v0.17.0 —`);
    console.error(`  during which the spec gained a dimension and renumbered three sections`);
    console.error(`  underneath ~20 citations that all silently became wrong.`);
    console.error(`\n  Re-read the spec at the pinned version, update the mirror AND its`);
    console.error(`  section citations, then move the declared version. Moving the version`);
    console.error(`  alone converts a detectable lag into an undetectable lie.`);
    return 1;
  }

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
