#!/usr/bin/env node
// scripts/lint-capability-mapping-coverage.mjs
//
// Capability-mapping coverage gate per ADR-0028 §4 + cred-iso audit R-2
// (`cloister-137642`). Companion to lint-capability-scheme.mjs.
//
// What this lint enforces
// -----------------------
// ADR-0028 §4 (crosswalk table) MUST list every `cloister/<name>/v<n>`
// interface the substrate publishes — otherwise the cert verifier
// has no way to bridge a lane-1 grant to the lane-3 interface, and
// new spec dirs can land silently without anyone noticing.
//
// `lint-capability-scheme.mjs` enforces lane discipline at USE sites
// (cluster.toml `[inputs.*]`); this lint enforces row coverage at the
// PUBLISH side (`cloister-spec/<name>/v<n>/` dirs).
//
// Rule: every directory matching `cloister-spec/<name>/v<n>/` that
// contains a README.md MUST appear as a lane-3 entry in
// `cloister-spec/_capability-mapping.md` §4.
//
// Empty lane-1 columns are explicitly permitted by §4 ("Empty row
// policy"): rows for substrate-internal or transport-mediated
// capabilities use `n/a (...)` in the lane-1 cell.
//
// Per project convention (cloister-6f06cc resolution): NO REGEX. All
// shape checks use substring + character-range probes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, "..");

const SPEC_ROOT = "cloister-spec";
const MAPPING_DOC = "cloister-spec/_capability-mapping.md";
const SECTION_HEADER = "## §4";
const NEXT_SECTION_HEADER = "## §5";
const LANE_3_PREFIX = "cloister/";

// ── Mapping-doc parser (§4 row extraction, no regex) ─────────────────────

/**
 * Parses the lane-3 column of every data row in `## §4` of the
 * crosswalk doc. Returns a Set of `cloister/<name>/v<n>` strings.
 *
 * Exported for tests. Pass the raw doc text.
 */
export function parseLane3FromSection4(docText) {
  const lines = docText.split("\n");
  let inSection = false;
  let sectionStartIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith(SECTION_HEADER)) {
      inSection = true;
      sectionStartIdx = i;
      continue;
    }
    if (inSection && line.startsWith(NEXT_SECTION_HEADER)) {
      return collectLane3IdsFromTableLines(lines.slice(sectionStartIdx, i));
    }
  }
  if (inSection) {
    return collectLane3IdsFromTableLines(lines.slice(sectionStartIdx));
  }
  return new Set();
}

function collectLane3IdsFromTableLines(sectionLines) {
  const ids = new Set();
  for (const raw of sectionLines) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;

    // Skip the header row and the separator row. The separator row is
    // composed only of "|", "-", ":", and whitespace.
    if (isSeparatorRow(line)) continue;

    const cols = splitMarkdownRow(line);
    if (cols.length < 2) continue;

    const lane3Cell = cols[1].trim();
    // Header row's lane-3 cell reads "Lane-3 interface ...". Skip it
    // by requiring the lane-3 cell to actually contain a backtick-quoted
    // cloister/<name>/v<n> string.
    const id = extractLane3IdFromCell(lane3Cell);
    if (id !== null) {
      ids.add(id);
    }
  }
  return ids;
}

function isSeparatorRow(line) {
  // Strip leading/trailing "|" then check the remaining chars are all
  // separator-shape (hyphen, colon, pipe, whitespace).
  for (const ch of line) {
    if (ch !== "|" && ch !== "-" && ch !== ":" && ch !== " " && ch !== "\t") {
      return false;
    }
  }
  return line.includes("-");
}

function splitMarkdownRow(line) {
  // Strip leading and trailing pipes, then split on "|".
  let s = line;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

/**
 * From a single markdown cell, extract the first backtick-quoted
 * cloister/<name>/v<n> identifier, if any. Returns null otherwise.
 *
 * This is permissive on what the lane-1 column carries (URN, n/a,
 * anything) but strict on the lane-3 column: it MUST be a
 * backtick-quoted cloister/<name>/v<n> string for the row to count.
 */
function extractLane3IdFromCell(cell) {
  const openTickIdx = cell.indexOf("`");
  if (openTickIdx === -1) return null;
  const closeTickIdx = cell.indexOf("`", openTickIdx + 1);
  if (closeTickIdx === -1) return null;
  const inner = cell.slice(openTickIdx + 1, closeTickIdx);
  if (!inner.startsWith(LANE_3_PREFIX)) return null;
  // Confirm `/v<digit>+` suffix without regex.
  const lastSlashIdx = inner.lastIndexOf("/v");
  if (lastSlashIdx <= LANE_3_PREFIX.length - 1) return null;
  const version = inner.slice(lastSlashIdx + 2);
  if (version.length === 0) return null;
  for (const ch of version) {
    if (ch < "0" || ch > "9") return null;
  }
  return inner;
}

// ── Spec-dir walker ───────────────────────────────────────────────────────

/**
 * Walks `cloister-spec/<name>/v<n>/` and returns the expected lane-3
 * IDs for every dir whose `README.md` exists.
 *
 * Skips dirs whose name starts with `_` (the mapping doc itself plus
 * any other reserved siblings).
 *
 * Exported for tests. Pass the absolute path to `cloister-spec/`.
 */
export function listExpectedLane3Ids(specRootAbs) {
  const ids = [];
  let topEntries;
  try {
    topEntries = readdirSync(specRootAbs);
  } catch (e) {
    throw new Error(
      `cannot read spec root at ${specRootAbs}: ${e.message}`,
    );
  }
  for (const name of topEntries.sort()) {
    if (name.startsWith("_")) continue;
    const namePath = join(specRootAbs, name);
    let nameStat;
    try {
      nameStat = statSync(namePath);
    } catch {
      continue;
    }
    if (!nameStat.isDirectory()) continue;
    for (const version of readdirSync(namePath).sort()) {
      if (!version.startsWith("v")) continue;
      const versionDigits = version.slice(1);
      if (versionDigits.length === 0) continue;
      let allDigits = true;
      for (const ch of versionDigits) {
        if (ch < "0" || ch > "9") {
          allDigits = false;
          break;
        }
      }
      if (!allDigits) continue;
      const versionPath = join(namePath, version);
      let versionStat;
      try {
        versionStat = statSync(versionPath);
      } catch {
        continue;
      }
      if (!versionStat.isDirectory()) continue;
      const readmePath = join(versionPath, "README.md");
      let readmeStat;
      try {
        readmeStat = statSync(readmePath);
      } catch {
        continue;
      }
      if (!readmeStat.isFile()) continue;
      ids.push({
        id: `cloister/${name}/${version}`,
        readmePath,
      });
    }
  }
  return ids;
}

// ── Coverage check ────────────────────────────────────────────────────────

/**
 * Returns the list of expected IDs that are NOT in the §4 set.
 *
 * Exported for tests.
 */
export function collectMissingRows(expected, sectionIds) {
  const missing = [];
  for (const item of expected) {
    if (!sectionIds.has(item.id)) {
      missing.push(item);
    }
  }
  return missing;
}

// ── CLI ──────────────────────────────────────────────────────────────────

function runLint() {
  const specRoot = process.env.CLOISTER_SPEC_ROOT ?? resolve(REPO, SPEC_ROOT);
  const mappingDocPath =
    process.env.CLOISTER_MAPPING_DOC ?? resolve(REPO, MAPPING_DOC);

  let docText;
  try {
    docText = readFileSync(mappingDocPath, "utf-8");
  } catch (e) {
    console.error(`lint-capability-mapping-coverage: ${e.message}`);
    process.exit(2);
  }

  const sectionIds = parseLane3FromSection4(docText);
  if (sectionIds.size === 0) {
    console.error(
      `lint-capability-mapping-coverage: parsed 0 rows from ${mappingDocPath} §4 — ` +
        `is the section header still "${SECTION_HEADER}"?`,
    );
    process.exit(2);
  }

  let expected;
  try {
    expected = listExpectedLane3Ids(specRoot);
  } catch (e) {
    console.error(`lint-capability-mapping-coverage: ${e.message}`);
    process.exit(2);
  }
  if (expected.length === 0) {
    console.error(
      `lint-capability-mapping-coverage: walked ${specRoot} but found no ` +
        `<name>/v<n>/README.md directories — sanity-check the spec root`,
    );
    process.exit(2);
  }

  const missing = collectMissingRows(expected, sectionIds);

  if (missing.length) {
    console.error(
      `\n✗ lint-capability-mapping-coverage: ${missing.length} spec dir(s) ` +
        `missing from ${MAPPING_DOC} §4\n`,
    );
    for (const item of missing) {
      console.error(`  ${item.id}`);
      console.error(`    README: ${item.readmePath}`);
      console.error(
        `    Fix: add a row to §4 of cloister-spec/_capability-mapping.md.`,
      );
      console.error(
        `         If no lane-1 grant analog exists, the lane-1 cell ` +
          `reads "n/a (...)" per §4's empty-row policy.`,
      );
    }
    console.error("");
    console.error(
      "Crosswalk coverage per ADR-0028 §4: every cloister-spec/<name>/v<n>/",
    );
    console.error(
      "  capability MUST have a row in _capability-mapping.md §4 so the cert",
    );
    console.error(
      "  verifier can bridge a lane-1 grant to the lane-3 interface.",
    );
    console.error("");
    process.exit(1);
  }

  console.log(`lint-capability-mapping-coverage: clean ✓`);
  console.log(`  ${expected.length} spec dir(s) walked`);
  console.log(`  ${sectionIds.size} §4 row(s) parsed`);
}

// Only run when invoked directly; test imports skip this block.
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  runLint();
}
