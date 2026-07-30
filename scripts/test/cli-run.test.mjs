// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister run` — the verb that makes the confined-harness flow one command.
//
// These test the two things a wrapper can get wrong in ways the underlying
// machinery cannot catch for it:
//
//   1. the ARGUMENTS, because --repo IS the security boundary. A relative path
//      silently resolved against cwd confines the harness to the wrong tree and
//      still looks like it worked.
//   2. the DELEGATION, because the whole design of this verb is that it does not
//      reimplement mint-and-confine. If it ever stops setting SANDBOX or
//      HARNESS_WORKDIR, the command still runs — just unconfined, or confined to
//      the wrong place. Neither failure is loud.
//
// The kernel enforcement itself is covered by
// tools/harness-sandbox/test/nono-isolation.test.mjs, which asserts EPERM on
// ~/.ssh and a $HOME decoy. Not duplicated here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, validateRepo, main, RunUsageError } from "../cli-run.mjs";

function scratchDir(t) {
  const d = mkdtempSync(join(tmpdir(), "cli-run-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// ── --repo is the security boundary, so it is validated, not resolved ──────

test("a RELATIVE --repo is rejected rather than resolved against cwd", () => {
  // The load-bearing case. Resolving it would produce a real, plausible, WRONG
  // boundary — the harness confined to whatever directory the command happened
  // to be typed in, with nothing to indicate it.
  assert.throws(() => validateRepo("relative/path"), RunUsageError);
  assert.throws(() => validateRepo("./repo"), /must be absolute/);
});

test("a missing --repo names what it is for, not just that it is missing", () => {
  assert.throws(() => validateRepo(null), /ONLY directory the harness may touch/);
});

test("a nonexistent or non-directory --repo is rejected", (t) => {
  assert.throws(() => validateRepo("/nope/does/not/exist"), /does not exist/);
  const d = scratchDir(t);
  const f = join(d, "a-file");
  writeFileSync(f, "x");
  assert.throws(() => validateRepo(f), /not a directory/);
});

test("an absolute existing directory is accepted and returned resolved", (t) => {
  const d = scratchDir(t);
  assert.equal(validateRepo(d), d);
});

// ── argument parsing ──────────────────────────────────────────────────────

test("parseArgs: a flag missing its value is a usage error, not a silent skip", () => {
  assert.throws(() => parseArgs(["--repo"]), /--repo requires a value/);
  assert.throws(() => parseArgs(["--repo", "--harness"]), /--repo requires a value/);
});

test("parseArgs: an unknown option is rejected rather than ignored", () => {
  // Ignoring it would let a typo'd --sandbox quietly leave confinement on the
  // default — the wrong direction to be silent about.
  assert.throws(() => parseArgs(["--sandbxo"]), /unknown option/);
});

test("parseArgs: --setup-only and --audit pass through untouched", () => {
  const a = parseArgs(["--setup-only", "--audit"]);
  assert.deepEqual(a.passthrough, ["--setup-only", "--audit"]);
});

// ── delegation: the point of the verb ─────────────────────────────────────

test("launching sets HARNESS_WORKDIR and SANDBOX, and delegates to harness-dev", async (t) => {
  const d = scratchDir(t);
  let seen = null;
  const fakeSpawn = (bin, argv, opts) => {
    seen = { bin, argv, env: opts.env };
    return { on: (evt, cb) => { if (evt === "close") queueMicrotask(() => cb(0)); } };
  };

  const code = await main(["--repo", d, "--harness", "claude-code"], {
    spawn: fakeSpawn, log: () => {}, errLog: () => {},
  });

  assert.equal(code, 0);
  assert.ok(seen, "must delegate rather than reimplement mint-and-confine");
  assert.match(seen.argv[0], /harness-dev\.mjs$/, "delegates to the existing flow");
  // The two that matter. Losing either is silent: no SANDBOX runs unconfined,
  // wrong HARNESS_WORKDIR confines to the wrong tree.
  assert.equal(seen.env.HARNESS_WORKDIR, d);
  assert.equal(seen.env.SANDBOX, "nono");
  assert.deepEqual(seen.argv.slice(1), ["--target", "claude-code"]);
});

test("--no-sandbox omits SANDBOX and warns — confinement is the default", async (t) => {
  const d = scratchDir(t);
  let seen = null, warned = "";
  const fakeSpawn = (_bin, _argv, opts) => {
    seen = opts.env;
    return { on: (evt, cb) => { if (evt === "close") queueMicrotask(() => cb(0)); } };
  };
  await main(["--repo", d, "--no-sandbox"], {
    spawn: fakeSpawn, log: () => {}, errLog: (m) => { warned += m; },
  });
  assert.equal(seen.SANDBOX, undefined, "--no-sandbox must not silently still confine");
  assert.match(warned, /DANGEROUS|full user/i, "removing the sandbox must be loud");
});

// ── no-side-effect paths ──────────────────────────────────────────────────

test("--help and --dry-run never spawn anything", async (t) => {
  const d = scratchDir(t);
  let spawned = false;
  const fakeSpawn = () => {
    spawned = true;
    return { on: (evt, cb) => { if (evt === "close") queueMicrotask(() => cb(0)); } };
  };

  assert.equal(await main(["--help"], { spawn: fakeSpawn, log: () => {} }), 0);
  assert.equal(spawned, false, "--help must mint nothing and launch nothing");

  assert.equal(await main(["--repo", d, "--dry-run"], { spawn: fakeSpawn, log: () => {} }), 0);
  assert.equal(spawned, false, "--dry-run must be answerable without launching");
});

test("--dry-run states the boundary, including what is DENIED", async (t) => {
  const d = scratchDir(t);
  let out = "";
  await main(["--repo", d, "--dry-run"], { spawn: () => {}, log: (m) => { out += `${m}\n`; } });
  assert.match(out, new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "must name the workspace");
  assert.match(out, /denied/i, "stating only what is ALLOWED is how people misread a sandbox");
  assert.match(out, /127\.0\.0\.1/, "must say cloister is the only egress");
});

test("--help exits 0 BEFORE --repo validation", async () => {
  // Ordering: asking for help must work even when the rest of the line is
  // wrong, otherwise you cannot learn the syntax from the tool itself.
  assert.equal(await main(["--help", "--repo", "relative"], { log: () => {} }), 0);
});
