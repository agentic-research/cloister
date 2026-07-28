// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for the declared harness profiles (cloister-742e19, ADR-0057) and the
// rail that keeps provider literals confined to their declaration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TARGETS,
  DEFAULT_TARGET,
  targetNames,
  resolveTarget,
  validateTarget,
  credentialHeaders,
  UsageError,
} from "../harness-targets.mjs";
import {
  findViolations,
  SCANNED,
  PROVIDER_PATTERNS,
} from "../lint-harness-target-literals.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ── Target resolution ─────────────────────────────────────────────────────

test("both harnesses are declared, and adding one needs no control flow", () => {
  assert.deepEqual(targetNames(), ["claude-code", "codex"]);
  // Every target carries the full field set the acceptance criteria names, so
  // a third row is complete by construction rather than by remembering.
  for (const [name, t] of Object.entries(TARGETS)) {
    for (const field of [
      "service", "upstream", "apiKeyEnv", "baseUrlEnv",
      "inject", "stripEnv", "bin", "stateDirEnv", "stateDir", "authModes",
    ]) {
      assert.ok(t[field], `${name} declares ${field}`);
    }
    assert.ok(t.authModes.length > 0, `${name} declares at least one auth mode`);
    assert.ok(t.stripEnv.includes(t.apiKeyEnv), `${name} strips its own key env`);
  }
});

test("default target resolves with no flag", () => {
  const { name } = resolveTarget([]);
  assert.equal(name, DEFAULT_TARGET);
});

test("--target selects a declared profile", () => {
  const { name, target } = resolveTarget(["--target", "codex"]);
  assert.equal(name, "codex");
  assert.equal(target.bin, "codex");
});

test("HARNESS_TARGET env selects a profile when no flag is given", () => {
  const { name } = resolveTarget([], { HARNESS_TARGET: "codex" });
  assert.equal(name, "codex");
});

test("an unknown target FAILS rather than falling back to the default", () => {
  // A typo must not silently launch a different provider — that would bill the
  // wrong account with no indication anything was wrong.
  assert.throws(() => resolveTarget(["--target", "clyde"]), UsageError);
  assert.throws(() => resolveTarget([], { HARNESS_TARGET: "clyde" }), UsageError);
});

test("--target with a missing value is a usage error, not a silent default", () => {
  assert.throws(() => resolveTarget(["--target"]), UsageError);
  assert.throws(() => resolveTarget(["--target", "--audit"]), UsageError);
});

// ── Cross-declaration agreement ───────────────────────────────────────────

test("every declared target matches the shipped cluster.toml vaultProxyServices", async () => {
  // The real tree, not a fixture: the harness's `inject` and the manifest's
  // `injection` are two independent statements of one fact, and this is where
  // they are checked against each other.
  const { cluster } = await import("../../src/generated/cluster.js");
  const services = cluster.gateway?.vaultProxyServices ?? [];
  assert.ok(services.length > 0, "cluster declares vaultProxyServices");
  for (const [name, target] of Object.entries(TARGETS)) {
    assert.doesNotThrow(() => validateTarget(target, services), `${name} agrees with the manifest`);
  }
});

test("an injection mismatch is caught at validate time, not as a runtime 401", () => {
  const target = { ...TARGETS["claude-code"], inject: "authorizationBearer" };
  assert.throws(
    () => validateTarget(target, [{ name: "anthropic", injection: "headerNamed" }]),
    /injection mismatch/,
  );
});

test("a service no manifest entry declares is caught", () => {
  const target = { ...TARGETS["claude-code"], service: "nowhere" };
  assert.throws(() => validateTarget(target, [{ name: "anthropic", injection: "headerNamed" }]), UsageError);
});

// ── Credential shape follows the declaration ──────────────────────────────

test("credential headers derive from the declared injection strategy", () => {
  assert.deepEqual(
    credentialHeaders(TARGETS["claude-code"], "sk-test"),
    { "x-api-key": "sk-test" },
  );
  assert.deepEqual(
    credentialHeaders(TARGETS.codex, "sk-test"),
    { Authorization: "Bearer sk-test" },
  );
});

// ── Auth-mode support is declared, not assumed ────────────────────────────

test("audit is declared per target — codex is custody-only", () => {
  assert.ok(TARGETS["claude-code"].authModes.includes("audit"));
  assert.ok(!TARGETS.codex.authModes.includes("audit"));
});

// ── The rail ──────────────────────────────────────────────────────────────

test("rail: the shipped tree has no provider literals outside the declaration", () => {
  assert.deepEqual(findViolations(ROOT), []);
});

test("rail: it actually scans something, and for real patterns", () => {
  // Guards against the rail passing because it looked at nothing — the
  // vacuous-pass failure mode this repo keeps finding.
  assert.ok(SCANNED.length > 0);
  assert.ok(PROVIDER_PATTERNS.length > 0);
  for (const rel of SCANNED) {
    assert.ok(readFileSync(resolve(ROOT, rel), "utf8").length > 0, `${rel} is non-empty`);
  }
});

test("rail: a provider literal in CODE is caught", (t) => {
  const file = resolve(ROOT, SCANNED[0]);
  const original = readFileSync(file, "utf8");
  t.after(() => writeFileSync(file, original));

  writeFileSync(file, original + '\nconst LEAK = process.env.ANTHROPIC_API_KEY;\n');
  const hits = findViolations(ROOT);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pattern.toLowerCase(), "anthropic");
});

test("rail: a provider name in a COMMENT is exempt", (t) => {
  // Usage examples naming both harnesses are documentation worth keeping. A
  // rail that forced deleting them would get suppressed wholesale.
  const file = resolve(ROOT, SCANNED[0]);
  const original = readFileSync(file, "utf8");
  t.after(() => writeFileSync(file, original));

  writeFileSync(file, original + '\n// example: export ANTHROPIC_BASE_URL=...\n/* openai too */\n');
  assert.deepEqual(findViolations(ROOT), []);
});
