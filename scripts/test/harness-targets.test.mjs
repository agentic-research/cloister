// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for the declared harness profiles (cloister-742e19, ADR-0057) and the
// rail that keeps provider literals out of code.
//
// The profiles live in cluster.toml under [[gateway.harnessTargets]]; this
// suite reads the SHIPPED file rather than a fixture, so it asserts the real
// declaration is coherent and cannot pass vacuously against invented data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TARGET,
  targetNames,
  loadHarnessConfig,
  resolveTarget,
  serviceFor,
  credentialHeaders,
  UsageError,
} from "../harness-targets.mjs";
import {
  findViolations,
  SCANNED,
  PROVIDER_PATTERNS,
} from "../lint-harness-target-literals.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { targets: TARGETS, services: SERVICES } =
  await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
const byName = (n) => TARGETS.find((t) => t.name === n);

// ── The shipped declaration ───────────────────────────────────────────────

test("both harnesses are declared in cluster.toml", () => {
  assert.deepEqual(targetNames(TARGETS), ["claude-code", "codex"]);
});

test("every target carries the full field set", () => {
  // A third row is then complete by construction rather than by remembering.
  // `entryPoint` is excluded: empty is meaningful (resolve on $PATH).
  for (const t of TARGETS) {
    for (const field of ["name", "service", "apiKeyEnv", "baseUrlEnv", "stateDirEnv", "stateDir"]) {
      assert.ok(t[field], `${t.name} declares ${field}`);
    }
    assert.ok(t.authModes?.length > 0, `${t.name} declares at least one auth mode`);
    assert.ok(
      t.stripEnv?.includes(t.apiKeyEnv),
      `${t.name} strips its own key env — otherwise a confined harness could see ` +
        `the key and bypass the vault proxy entirely`,
    );
  }
});

test("every target names its OWNER concretely", () => {
  // Required, a URL, never empty and never a category word.
  //
  // Empty would be indistinguishable from a row nobody filled in, so absence
  // would silently mean "cloister owns this" — absence carrying meaning is the
  // defect that let a sha256: prefix sit on BLAKE3 bytes. A category label
  // ("first-party") is the same trap one level up: it names the bin, not who to
  // ask when the row is wrong. First- vs third-party is then readable from the
  // org rather than asserted as a second, drift-prone fact.
  for (const t of TARGETS) {
    assert.ok(t.provenance, `${t.name} declares provenance`);
    assert.match(
      t.provenance,
      /^https?:\/\//,
      `${t.name} names an owning project by URL, not a category`,
    );
  }
});

test("targets do NOT restate upstream or injection", () => {
  // Those belong to the vault service. Restating them would be two statements
  // of one fact that can disagree — the defect class this substrate keeps
  // finding, and the reason the earlier JS-table version needed a reconciler.
  for (const t of TARGETS) {
    assert.equal(t.upstream, undefined, `${t.name} does not restate upstream`);
    assert.equal(t.inject, undefined, `${t.name} does not restate injection`);
  }
});

test("names are unique across targets and services", () => {
  // Arrays-of-tables are the TOML blind spot: duplicate KEYS in a table are
  // rejected by the parser per spec, but two [[gateway.harnessTargets]] with
  // the same name are legal and silently wrong, since every consumer .find()s.
  for (const [label, list] of [["targets", TARGETS], ["services", SERVICES]]) {
    const names = list.map((x) => x.name);
    assert.equal(new Set(names).size, names.length, `${label} have unique names`);
  }
});

// ── Resolution ────────────────────────────────────────────────────────────

test("default target resolves with no flag", () => {
  assert.equal(resolveTarget(TARGETS, []).name, DEFAULT_TARGET);
});

test("--target selects a declared profile", () => {
  assert.equal(resolveTarget(TARGETS, ["--target", "codex"]).name, "codex");
});

test("HARNESS_TARGET selects a profile when no flag is given", () => {
  assert.equal(resolveTarget(TARGETS, [], { HARNESS_TARGET: "codex" }).name, "codex");
});

test("an unknown target FAILS rather than falling back to the default", () => {
  // A typo must not silently launch a different provider — that bills the wrong
  // account with nothing indicating anything was wrong.
  assert.throws(() => resolveTarget(TARGETS, ["--target", "clyde"]), UsageError);
  assert.throws(() => resolveTarget(TARGETS, [], { HARNESS_TARGET: "clyde" }), UsageError);
});

test("--target with a missing value is a usage error, not a silent default", () => {
  assert.throws(() => resolveTarget(TARGETS, ["--target"]), UsageError);
  assert.throws(() => resolveTarget(TARGETS, ["--target", "--audit"]), UsageError);
});

test("an empty declaration set fails closed", () => {
  assert.throws(() => resolveTarget([], []), UsageError);
});

// ── The one cross-reference that remains ──────────────────────────────────

test("every declared target resolves to a declared vault service", () => {
  for (const t of TARGETS) {
    assert.doesNotThrow(() => serviceFor(t, SERVICES), `${t.name} resolves its service`);
  }
});

test("a target naming an undeclared service is caught", () => {
  assert.throws(() => serviceFor({ name: "x", service: "nowhere" }, SERVICES), UsageError);
});

// ── Credential shape follows the SERVICE's declaration ────────────────────

test("credential headers derive from the service's injection strategy", () => {
  const anthropic = serviceFor(byName("claude-code"), SERVICES);
  const openai = serviceFor(byName("codex"), SERVICES);
  assert.deepEqual(credentialHeaders(anthropic, "sk-test"), { "x-api-key": "sk-test" });
  assert.deepEqual(credentialHeaders(openai, "sk-test"), { Authorization: "Bearer sk-test" });
});

test("an unsupported injection strategy is a named refusal", () => {
  assert.throws(
    () => credentialHeaders({ name: "weird", injection: "queryParam" }, "k"),
    /does not support/,
  );
});

// ── Auth modes are declared, not assumed ──────────────────────────────────

test("audit is per-target — codex is custody-only", () => {
  assert.ok(byName("claude-code").authModes.includes("audit"));
  assert.ok(!byName("codex").authModes.includes("audit"));
});

// ── The rail ──────────────────────────────────────────────────────────────

test("rail: the shipped tree has no provider literals in code", () => {
  assert.deepEqual(findViolations(ROOT), []);
});

test("rail: it actually scans something, and for real patterns", () => {
  // Guards the vacuous-pass failure mode: a rail that looked at nothing.
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
  // Usage examples naming both harnesses are documentation worth keeping; a
  // rail that forced deleting them would earn a blanket suppression.
  const file = resolve(ROOT, SCANNED[0]);
  const original = readFileSync(file, "utf8");
  t.after(() => writeFileSync(file, original));

  writeFileSync(file, original + '\n// example: export ANTHROPIC_BASE_URL=...\n/* openai too */\n');
  assert.deepEqual(findViolations(ROOT), []);
});
