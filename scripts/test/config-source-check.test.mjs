// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for config-source-check.mjs — cloister-21f273 preflight. No regex
// assertions per operator request — substring + structural checks only.
//
// Run with: node --import tsx --test scripts/test/config-source-check.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseDotenv,
  parseWranglerVars,
  wranglerDevEffective,
  findConfigSourceIssues,
  collectConfigSourceIssues,
} from "../config-source-check.mjs";

test("parseDotenv reads KEY=VALUE, skips comments/blanks, strips quotes", () => {
  const m = parseDotenv('# comment\n\nA=1\nB = two\nC="quoted"\nD=env://X\n');
  assert.equal(m.get("A"), "1");
  assert.equal(m.get("B"), "two");
  assert.equal(m.get("C"), "quoted");
  assert.equal(m.get("D"), "env://X");
  assert.equal(m.size, 4);
});

test("parseWranglerVars reads only the [vars] table, handles quotes + trailing comments", () => {
  const toml = [
    "[build]",
    'command = "x"',
    "",
    "[vars]",
    'INTERLACE_ROOT_PUBKEY = ""    # base64 pubkey',
    'LLO_MCP_URL = "http://localhost:8384/mcp"',
    "",
    "[[services]]",
    'binding = "NOTME"',
  ].join("\n");
  const m = parseWranglerVars(toml);
  assert.equal(m.get("INTERLACE_ROOT_PUBKEY"), "");
  assert.equal(m.get("LLO_MCP_URL"), "http://localhost:8384/mcp");
  assert.equal(m.has("command"), false, "must not read the [build] table");
  assert.equal(m.has("binding"), false, "must not read the [[services]] table");
});

test("wranglerDevEffective: .dev.vars wins, then wrangler.toml, process env ignored", () => {
  const devVars = new Map([["K", "from_devvars"]]);
  const wranglerVars = new Map([["K", "from_wrangler"], ["J", "from_wrangler"]]);
  assert.equal(wranglerDevEffective("K", devVars, wranglerVars), "from_devvars");
  assert.equal(wranglerDevEffective("J", devVars, wranglerVars), "from_wrangler");
  assert.equal(wranglerDevEffective("MISSING", devVars, wranglerVars), undefined);
});

test("SHADOWED: a NON-dev .dev.vars drops a .env.local value (the d2db6d bug)", () => {
  const issues = findConfigSourceIssues({
    envLocal: new Map([["INTERLACE_ROOT_PUBKEY", "TrP3realpubkey"]]),
    devVars: new Map([["SOMETHING_ELSE", "x"]]), // exists, non-dev, doesn't set the key
    wranglerVars: new Map([["INTERLACE_ROOT_PUBKEY", ""]]), // empty default
    devVarsExists: true,
  });
  assert.deepEqual(issues, [{ key: "INTERLACE_ROOT_PUBKEY", kind: "shadowed" }]);
});

test("dev-mode SUPPRESSES shadow: CLOISTER_MODE=dev intentionally supersedes the surface", () => {
  // ADR-0042 harness:dev — DEV_CA_MASTER supersedes INTERLACE_ROOT_PUBKEY, so
  // shadowing the prod anchor is by design, not the bug.
  const issues = findConfigSourceIssues({
    envLocal: new Map([["INTERLACE_ROOT_PUBKEY", "real"], ["VAULT_KEK_SOURCE", "env://DEV_VAULT_KEK"]]),
    devVars: new Map([["CLOISTER_MODE", "dev"], ["DEV_CA_MASTER", "m"]]),
    wranglerVars: new Map([["INTERLACE_ROOT_PUBKEY", ""], ["VAULT_KEK_SOURCE", ""]]),
    devVarsExists: true,
  });
  assert.deepEqual(issues, []);
});

test("CONFLICT is flagged even under dev mode (ambiguous ownership regardless)", () => {
  const issues = findConfigSourceIssues({
    envLocal: new Map([["DEV_CA_EPOCH", "1"]]),
    devVars: new Map([["CLOISTER_MODE", "dev"], ["DEV_CA_EPOCH", "2"]]),
    wranglerVars: new Map(),
    devVarsExists: true,
  });
  assert.deepEqual(issues, [{ key: "DEV_CA_EPOCH", kind: "conflict" }]);
});

test("CONFLICT: both files set the key to different values", () => {
  const issues = findConfigSourceIssues({
    envLocal: new Map([["INTERLACE_ROOT_PUBKEY", "real"]]),
    devVars: new Map([["INTERLACE_ROOT_PUBKEY", "ephemeral_dev"]]),
    wranglerVars: new Map(),
    devVarsExists: true,
  });
  assert.deepEqual(issues, [{ key: "INTERLACE_ROOT_PUBKEY", kind: "conflict" }]);
});

test("no issue when .dev.vars also declares the key with the SAME value", () => {
  const issues = findConfigSourceIssues({
    envLocal: new Map([["K", "v"]]),
    devVars: new Map([["K", "v"]]),
    wranglerVars: new Map(),
    devVarsExists: true,
  });
  assert.deepEqual(issues, []);
});

test("no issue without .dev.vars — process env flows through (plain task dev)", () => {
  const issues = findConfigSourceIssues({
    envLocal: new Map([["INTERLACE_ROOT_PUBKEY", "real"]]),
    devVars: new Map(),
    wranglerVars: new Map([["INTERLACE_ROOT_PUBKEY", ""]]),
    devVarsExists: false,
  });
  assert.deepEqual(issues, []);
});

test("empty .env.local value is not a lost secret (no false shadow)", () => {
  const issues = findConfigSourceIssues({
    envLocal: new Map([["OPTIONAL", ""]]),
    devVars: new Map([["CLOISTER_MODE", "dev"]]),
    wranglerVars: new Map(),
    devVarsExists: true,
  });
  assert.deepEqual(issues, []);
});

test("collectConfigSourceIssues on the live repo does not throw and returns an array", () => {
  // In CI there is no .env.local → []. Locally it reflects the real dev files.
  // Either way it must be a clean array (no crash on the real wrangler.toml).
  const issues = collectConfigSourceIssues();
  assert.ok(Array.isArray(issues));
});
