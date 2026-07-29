// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint:structured-parse (cloister-2fb46a follow-on).
//
// This rail is CLEAN on the tree it ships with, which is the easiest kind of
// rail to be vacuous. So the tests carry the weight: a synthetic violation
// must be caught, the correct shape must not be flagged, and each exemption
// class must behave as documented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { findViolations, ALLOW_MARKER } from "../lint-structured-parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Build a throwaway tree with one scripts/ file. */
function withScript(t, body) {
  const dir = mkdtempSync(resolve(tmpdir(), "structured-parse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(resolve(dir, "scripts"));
  writeFileSync(resolve(dir, "scripts/x.mjs"), body);
  return dir;
}

// ── The rail holds on the shipped tree ────────────────────────────────────

test("the shipped tree hand-parses no format that has a parser", () => {
  assert.deepEqual(findViolations(ROOT).map((v) => `${v.file}:${v.line}`), []);
});

// ── It catches the bug it is made of ──────────────────────────────────────

test("regexing raw TOML text is a violation", () => {
  // This is verbatim the shape that produced four phantom findings in
  // lint-binding-parity: read the file, pattern-match the text.
  const dir = withScript(test, `
    const text = readFileSync("wrangler.toml", "utf8");
    for (const m of text.matchAll(/name = "([A-Z_]+)"/g)) names.add(m[1]);
  `);
  const v = findViolations(dir, ["scripts"]);
  assert.equal(v.length, 1, "the hand-parsed read must be flagged");
});

test("string-surgery on raw JSON is a violation too", () => {
  const dir = withScript(test, `
    const text = readFileSync("server.json", "utf8");
    const name = text.split('"name":')[1];
  `);
  assert.equal(findViolations(dir, ["scripts"]).length, 1);
});

// ── It does not flag the correct shapes ───────────────────────────────────

test("parsing then operating on the parsed value is NOT a violation", () => {
  const dir = withScript(test, `
    const doc = parseToml(readFileSync("wrangler.toml", "utf8"));
    const names = Object.keys(doc.vars).filter(k => k.match(/^[A-Z]/));
  `);
  assert.deepEqual(findViolations(dir, ["scripts"]), []);
});

test("pattern-matching capnp is NOT a violation — no parser exists without a toolchain", () => {
  const dir = withScript(test, `
    const text = readFileSync("config.capnp", "utf8");
    const names = [...text.matchAll(/name = "([A-Z_]+)"/g)];
  `);
  assert.deepEqual(findViolations(dir, ["scripts"]), []);
});

test("reading a parseable file without operating on the text is NOT a violation", () => {
  // Hashing, copying, or forwarding raw bytes is not hand-parsing.
  const dir = withScript(test, `
    const bytes = readFileSync("cluster.toml", "utf8");
    await writeFileSync(dest, bytes);
  `);
  assert.deepEqual(findViolations(dir, ["scripts"]), []);
});

// ── The escape hatch works, and only with a marker ────────────────────────

test("the allow marker exempts, including above a multi-line reason", () => {
  // The first implementation looked back exactly ONE line, which rejected
  // precisely the well-documented exemptions the convention exists to
  // encourage. Pinned so the lookback cannot silently narrow again.
  const dir = withScript(test, `
    // ${ALLOW_MARKER} asserting on emitted TEXT, not extracting data —
    // a parser would confirm semantics, but this checks what was written.
    // (third line of reason, to exercise the lookback)
    const text = readFileSync("cluster.toml", "utf8");
    assert.match(text, /\\[metadata\\]/);
  `);
  assert.deepEqual(findViolations(dir, ["scripts"]), []);
});

test("a bare comment without the marker does NOT exempt", () => {
  const dir = withScript(test, `
    // this is fine, trust me
    const text = readFileSync("cluster.toml", "utf8");
    assert.match(text, /\\[metadata\\]/);
  `);
  assert.equal(findViolations(dir, ["scripts"]).length, 1);
});
