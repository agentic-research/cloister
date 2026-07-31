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
//      reimplement mint-and-confine. It calls scripts/lib/harness/launch.mjs
//      IN-PROCESS; if it ever stops passing a sandbox, or passes the wrong
//      workdirs, the command still runs — just unconfined, or confined to the
//      wrong place. Neither failure is loud.
//
//      This used to be checked by inspecting the env of a spawned subprocess.
//      It is now checked on the LaunchRequest itself, which is the change: the
//      confinement shape is an argument with a type, not JSON in an env var.
//
// The kernel enforcement itself is covered by
// tools/harness-sandbox/test/nono-isolation.test.mjs, which asserts EPERM on
// ~/.ssh and a $HOME decoy. Not duplicated here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, validateRepo, validateRepos, main, RunUsageError } from "../../cli/commands/run.mjs";

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

test("--target remains a deprecated spelling of --harness during migration", async (t) => {
  const d = scratchDir(t);
  let request;
  const warnings = [];
  const code = await main(["--repo", d, "--target", "codex"], {
    launch: async (value) => { request = value; return { session: null }; },
    log: () => {},
    errLog: (line) => warnings.push(line),
  });
  assert.equal(code, 0);
  assert.equal(request.targetName, "codex");
  assert.equal(warnings.filter((line) => line.includes("deprecated")).length, 1);
});

// ── delegation: the point of the verb ─────────────────────────────────────

test("launching passes the workdirs and a sandbox on the LaunchRequest", async (t) => {
  const d = scratchDir(t);
  let request = null;
  const code = await main(["--repo", d, "--harness", "claude-code"], {
    launch: async (req) => { request = req; return { session: null }; },
    log: () => {}, errLog: () => {},
  });

  assert.equal(code, 0);
  assert.ok(request, "must delegate rather than reimplement mint-and-confine");
  // The two that matter. Losing either is silent: no sandbox runs unconfined,
  // wrong workdirs confine to the wrong tree.
  assert.deepEqual(request.sandbox.workdirs, [d]);
  assert.equal(request.sandbox.provider, "nono");
  assert.equal(request.targetName, "claude-code");
});

test("every --repo reaches the request, in the order given", async (t) => {
  // Order is load-bearing: the first root becomes the harness's cwd, so sorting
  // or de-duplicating here would silently change what a relative path means
  // inside the harness.
  const a = scratchDir(t), b = scratchDir(t);
  let request = null;
  await main(["--repo", a, "--repo", b], {
    launch: async (req) => { request = req; return { session: null }; },
    log: () => {}, errLog: () => {},
  });
  assert.deepEqual(request.sandbox.workdirs, [a, b]);
});

test("--no-sandbox omits the sandbox and warns — confinement is the default", async (t) => {
  const d = scratchDir(t);
  let request = null, warned = "";
  await main(["--repo", d, "--no-sandbox"], {
    launch: async (req) => { request = req; return { session: null }; },
    log: () => {}, errLog: (m) => { warned += m; },
  });
  // null, not `{enabled:false}` — absence is the only "off", so there is no
  // boolean a mis-read could leave unapplied.
  assert.equal(request.sandbox, null, "--no-sandbox must not silently still confine");
  assert.match(warned, /DANGEROUS|full user/i, "removing the sandbox must be loud");
});

test("the verb does NOT spawn a second node to re-parse its own flags", async (t) => {
  // The regression this file's rewrite exists for. `cloister run` used to
  // serialize its parsed arguments into environment variables and spawn
  // `node scripts/harness-dev.mjs` to parse them back — so the confinement
  // shape depended on a JSON blob surviving an env var whose name had to match
  // on both sides. A typo in that name is a silently unconfined run.
  const d = scratchDir(t);
  let spawned = false;
  await main(["--repo", d], {
    launch: async () => { return { session: null }; },
    spawn: () => { spawned = true; return { on: () => {} }; },
    log: () => {}, errLog: () => {},
  });
  assert.equal(spawned, false, "the orchestration is called in-process, not re-launched");
});

// ── multi-root argument validation ────────────────────────────────────────

test("validateRepos: a duplicate --repo is refused, not silently collapsed", () => {
  // Collapsing would be the tempting fix and is wrong: the attested shape is
  // built from the COUNT, so accepting two grants for one tree means the cert
  // claims a wider boundary than the kernel enforces.
  const d = mkdtempSync(join(tmpdir(), "cli-run-dup-"));
  try {
    assert.throws(() => validateRepos([d, d]), /given twice/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("validateRepos: a nested --repo is refused in either order", () => {
  const outer = mkdtempSync(join(tmpdir(), "cli-run-nest-"));
  const inner = join(outer, "inner");
  try {
    mkdirSync(inner);
    assert.throws(() => validateRepos([outer, inner]), /is inside/);
    assert.throws(() => validateRepos([inner, outer]), /is inside/);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test("validateRepos: a sibling whose path is a string prefix is NOT nested", () => {
  // `/tmp/repo` and `/tmp/repo-two`: a substring check would call the second
  // nested inside the first and refuse a legitimate pair.
  const base = mkdtempSync(join(tmpdir(), "cli-run-sib-"));
  try {
    const a = join(base, "repo"), b = join(base, "repo-two");
    mkdirSync(a); mkdirSync(b);
    assert.deepEqual(validateRepos([a, b]), [a, b]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("validateRepos: no --repo at all still names what the flag is FOR", () => {
  assert.throws(() => validateRepos([]), /ONLY directory the harness may touch/);
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
