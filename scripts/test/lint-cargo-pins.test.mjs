// scripts/test/lint-cargo-pins.test.mjs
//
// Run with:  node --test scripts/test/lint-cargo-pins.test.mjs
//
// Contract tests for scripts/lint-cargo-pins.mjs — enforces that
// security-sensitive crate pins in `rs/crates/sign/Cargo.toml` keep
// the form ADR-0019 §"Implementation pins" requires. Today the lint
// gates exactly one crate (`ed25519-dalek`, tilde-pinned to `~2.1`);
// the contract is "the shape is a structured lint, not a one-off
// grep" so additional pinned crates land as new rules in the same
// list without re-writing the runner.
//
// Tests synthesize a tmpdir + tmp Cargo.toml in the shape the lint
// expects, then spawn the lint script with CARGO_PIN_FILE pointing
// at the fixture.
//
// Per cloister-9bfbf6 / ADR-0019 §15.7.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-cargo-pins.mjs");

function makeFixture(cargoToml) {
  const dir = mkdtempSync(resolve(tmpdir(), "cargo-pin-lint-"));
  const path = resolve(dir, "Cargo.toml");
  writeFileSync(path, cargoToml);
  return { dir, path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function runLint(cargoPinFile) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, CARGO_PIN_FILE: cargoPinFile },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test("tilde pin `~2.1` → exit 0 (the only ADR-conformant form)", () => {
  const fixture = makeFixture(`
[dependencies]
ed25519-dalek = { version = "~2.1", features = ["rand_core"] }
`);
  try {
    const r = runLint(fixture.path);
    assert.equal(r.status, 0, `expected pass; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    fixture.cleanup();
  }
});

test("tilde pin in plain string form `\"~2.1\"` → exit 0", () => {
  // Plain-string form (no inline table) is also accepted.
  const fixture = makeFixture(`
[dependencies]
ed25519-dalek = "~2.1"
`);
  try {
    const r = runLint(fixture.path);
    assert.equal(r.status, 0, `expected pass for plain-string tilde; stderr:\n${r.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test("caret pin `^2.1` → exit 1 (would allow 2.2.x+; violates alg-substitution defense)", () => {
  const fixture = makeFixture(`
[dependencies]
ed25519-dalek = { version = "^2.1", features = ["rand_core"] }
`);
  try {
    const r = runLint(fixture.path);
    assert.equal(r.status, 1, `expected fail for caret; got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stderr, /caret|tilde|ADR-0019/);
  } finally {
    fixture.cleanup();
  }
});

test("bare `2.1` (cargo treats as caret) → exit 1", () => {
  // `version = "2.1"` is equivalent to `^2.1` per cargo's semver
  // shorthand — same risk as explicit caret. Must fail.
  const fixture = makeFixture(`
[dependencies]
ed25519-dalek = { version = "2.1", features = ["rand_core"] }
`);
  try {
    const r = runLint(fixture.path);
    assert.equal(r.status, 1, `bare "2.1" (caret-equivalent) must fail; got ${r.status}`);
    assert.match(r.stderr, /ADR-0019/);
  } finally {
    fixture.cleanup();
  }
});

test("wildcard `2.*` → exit 1", () => {
  const fixture = makeFixture(`
[dependencies]
ed25519-dalek = { version = "2.*", features = ["rand_core"] }
`);
  try {
    const r = runLint(fixture.path);
    assert.equal(r.status, 1, "wildcard must fail");
    assert.match(r.stderr, /ADR-0019/);
  } finally {
    fixture.cleanup();
  }
});

test("crate missing entirely → exit 1 (with clear message)", () => {
  // ed25519-dalek is load-bearing per ADR-0019; deleting it from
  // Cargo.toml is itself the failure mode.
  const fixture = makeFixture(`
[dependencies]
serde = "1"
`);
  try {
    const r = runLint(fixture.path);
    assert.equal(r.status, 1, "missing pinned crate must fail");
    assert.match(r.stderr, /ed25519-dalek|not declared/);
  } finally {
    fixture.cleanup();
  }
});

test("file missing entirely → exit 2 (toolchain error, distinct from violation)", () => {
  const r = runLint(resolve(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".toml"));
  assert.equal(r.status, 2, "missing file must be a toolchain error (exit 2), not a violation");
  assert.match(r.stderr, /not found|cannot read/i);
});

test("regression — the live rs/crates/sign/Cargo.toml passes the lint", () => {
  // No env-var override → defaults to the live repo file. This is the
  // gate that runs in `task lint:cargo-pins`. Today it must pass; the
  // future regression-detection moment is when someone PRs a caret
  // bump + this test fails locally before CI does.
  const r = spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `live Cargo.toml must lint clean; stderr:\n${r.stderr}\nstdout:${r.stdout}`);
});
