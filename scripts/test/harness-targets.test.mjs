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
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../../cli/lib/harness/targets.mjs";
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

// ── harness:dev must be safe to ASK about (cloister-eb33d4 / eb27ae) ───────
//
// Both found by trying to use the script rather than read it. `--help` used to
// fall through and mint an ephemeral dev master + cert, write .dev.vars and
// write a confinement manifest — so asking what a command does performed its
// most security-relevant side effect. And the launch path minted FIRST, then
// discovered a missing .env.local several steps later from `task dev`, leaving
// a stray key per attempt.

test("--help exits 0 and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-help-"));
  try {
    const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/harness-dev.mjs"), "--help"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, HOME: dir },
    });
    assert.equal(r.status, 0, `--help must succeed:\n${r.stderr}`);
    assert.match(r.stdout, /mints nothing, writes nothing/);
    // The load-bearing assertion: no credential, no manifest.
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /minting a fresh ephemeral/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing .env.local fails BEFORE minting, not after", () => {
  // Ordering is the property. Minting is the security-relevant step, so every
  // precondition it depends on has to be checked ahead of it — otherwise each
  // failed attempt leaves a key behind.
  const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/harness-dev.mjs")], {
    cwd: ROOT, encoding: "utf8",
  });
  const out = `${r.stdout}${r.stderr}`;
  if (/\.env\.local is missing/.test(out)) {
    assert.equal(r.status, 1, "a missing prerequisite must be a hard failure");
    assert.doesNotMatch(out, /minting a fresh ephemeral/, "must not mint before failing");
  } else {
    // .env.local exists in this environment, so the branch is unreachable here.
    // Asserted rather than silently skipped so the test cannot rot into a no-op.
    assert.ok(existsSync(resolve(ROOT, ".env.local")), "either the guard fires or the file exists");
  }
});

// ── the selector is not the executable (ADR-0060 / cloister-1011aa) ────────

// The DECLARATION is checkable anywhere — including a CI runner with no harness
// installed. The RESOLUTION is not. An earlier version of this file merged them
// into one test with an anti-vacuity guard that hard-failed when nothing
// resolved; that guard is right for a developer machine and wrong for CI, where
// "no harness installed" is the normal state. It failed the gate.
//
// Splitting them keeps both properties honest: the declaration assertion runs
// everywhere and is what actually catches the bug, and the resolution check
// SKIPS with a named reason (node:test reports skips distinctly from passes, so
// it stays visible) rather than silently passing.

test("a target whose stateDir stem differs from its name MUST declare an executable", async () => {
  // The general form of the bug, and checkable with no binary present — which
  // matters, because the machine most likely to run this has neither harness
  // installed.
  //
  // The tell was already in the row: claude-code declares `stateDir = ".claude"`.
  // A harness names its state directory after ITSELF, so the stem of stateDir is
  // the execution identity. When that stem differs from the selector, the two
  // concerns have come apart and `name` can no longer stand in for the binary —
  // which is precisely the state that shipped broken, with the evidence sitting
  // in the same row nobody read.
  //
  // codex: stateDir ".codex", stem "codex" == name → nothing required.
  // claude-code: stem "claude" != name "claude-code" → executable required.
  const { loadHarnessConfig } = await import("../../cli/lib/harness/targets.mjs");
  const { targets } = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
  assert.ok(targets.length >= 1, "cluster.toml must declare at least one harness target");

  for (const t of targets) {
    const stem = (t.stateDir || "").replace(/^\./, "");
    if (!stem || stem === t.name) continue;
    assert.ok(
      t.executable,
      `${t.name}: stateDir ${JSON.stringify(t.stateDir)} implies the binary is ` +
      `${JSON.stringify(stem)}, not ${JSON.stringify(t.name)} — declare ` +
      `executable, or the $PATH fallback looks for a binary that does not ` +
      `exist (ADR-0060)`,
    );
    assert.equal(
      t.executable, stem,
      `${t.name}: executable ${JSON.stringify(t.executable)} disagrees with the ` +
      `identity its own stateDir implies (${JSON.stringify(stem)})`,
    );
  }
});

test("every declared target's executable resolves on THIS machine", async (t) => {
  // Complements the declaration check above: that one proves the row is
  // self-consistent, this one proves the named binary is actually findable.
  // Only meaningful where a harness is installed, so it stands down explicitly
  // rather than passing on an empty check.
  const { loadHarnessConfig } = await import("../../cli/lib/harness/targets.mjs");
  const { targets } = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));

  const checked = [], missing = [];
  for (const row of targets) {
    if (row.entryPoint) {
      assert.ok(existsSync(row.entryPoint), `${row.name}: entryPoint ${row.entryPoint} does not exist`);
      checked.push(row.name);
      continue;
    }
    const cmd = row.executable || row.name;
    if (spawnSync("which", [cmd], { encoding: "utf8" }).status === 0) checked.push(`${row.name} → ${cmd}`);
    else missing.push(`${row.name} (looked for ${JSON.stringify(cmd)})`);
  }

  if (checked.length === 0) {
    // NOT a silent pass: node:test renders this as a skip with the reason
    // attached, so a log reader can tell "no harness here" from "verified".
    t.skip(`no declared harness installed here (${missing.join(", ")}) — ` +
           `resolution is unverifiable on this machine; the declaration check above still ran`);
    return;
  }
  if (missing.length) {
    process.stderr.write(`harness-targets: not installed here, so unverified: ${missing.join(", ")}\n`);
  }
  assert.ok(checked.length > 0);
});

test("claude-code declares an executable distinct from its selector", async () => {
  // The specific regression, pinned. Deriving the expectation from cluster.toml
  // would make this pass again the moment someone deletes the field — the state
  // that shipped broken — so the expected value is stated here.
  //
  // Read through the PARSER, not a regex over the file: `executable = "claude"`
  // is one of several shapes TOML allows for the same fact (inline table,
  // literal string, different key order), and a pattern that matched only the
  // current spelling would report CLEAN on a rewrite that still declared it.
  // That is the failure lint:structured-parse exists to prevent, and it caught
  // an earlier draft of this test doing exactly that.
  const { loadHarnessConfig } = await import("../../cli/lib/harness/targets.mjs");
  const { targets } = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
  const claude = targets.find((t) => t.name === "claude-code");
  assert.ok(claude, "the claude-code target must stay declared");
  assert.equal(
    claude.executable, "claude",
    "claude-code's binary is `claude`, not `claude-code`; without this the " +
    "$PATH fallback looks for a binary that has never existed (ADR-0060)",
  );
  assert.notEqual(
    claude.executable, claude.name,
    "the point of the field is that these differ — equal means it is doing nothing",
  );
});
