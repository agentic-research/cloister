// SPDX-License-Identifier: AGPL-3.0-or-later
//
// nono-isolation-outer-sandbox.test.mjs — the nono isolation gate must stay
// useful when it runs INSIDE another sandbox (cloister-6f7e77).
//
// nono-isolation.test.mjs writes a decoy secret into $HOME at module load,
// because proving "nono denies it" is only meaningful if the file provably
// exists. But agent harnesses (Codex, CI containers) often run us inside an
// OUTER sandbox that denies $HOME writes. That write then throws during
// module evaluation, so node:test reports the whole FILE as one failure and
// all eight isolation assertions are lost — the gate goes dark exactly where
// confinement matters most.
//
// The contract: an unwritable $HOME degrades to a SCOPED skip of the one
// decoy-dependent test, never a suite crash, and never a blanket skip that
// would let a real nono regression through unnoticed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, "nono-isolation.test.mjs");

// Without nono every test in the target suite self-skips, so the
// "other tests still ran" assertion below could not distinguish a correct
// scoped skip from a blanket one. Skip rather than assert vacuously.
const HAVE_NONO = (() => {
  try {
    return spawnSync("nono", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();
const SKIP = HAVE_NONO ? false : "nono CLI not installed (https://nono.sh)";

// A directory we own but cannot write to — the same EACCES an outer sandbox
// produces when it denies $HOME. Owner permission bits are checked before
// group/other, so 0555 denies the owner too (root would bypass; the gate is
// not run as root).
function withUnwritableHome(fn) {
  // Deliberately under the REAL home rather than tmpdir. nono roots its session
  // state at $HOME/.nono, and a $HOME beneath /private/var collides with nono's
  // own system-read grants — "Refusing to grant '/private/var' ... overlaps
  // protected nono state root" — which would break the sandbox itself instead
  // of just the decoy, and the suite would fail for an unrelated reason.
  //
  // Pre-create that state root WRITABLE, then seal the home around it. The only
  // thing denied is then the decoy write, which is precisely the outer-sandbox
  // shape we are reproducing.
  const home = mkdtempSync(join(homedir(), ".cloister-ro-home-"));
  mkdirSync(join(home, ".nono"), { recursive: true });
  chmodSync(home, 0o555);
  try {
    return fn(home);
  } finally {
    chmodSync(home, 0o755);
    rmSync(home, { recursive: true, force: true });
  }
}

// Run the suite as a plain script, NOT via `node --test`: node:test refuses to
// recurse ("run() is being called recursively within a test file") and would
// emit no results at all, silently passing any assertion on its output.
//
// Two env details matter, and both fail SILENTLY rather than loudly:
//   - NODE_TEST_CONTEXT: the runner exports `child-v8`, and a child that
//     inherits it emits V8-serialized binary frames instead of the readable
//     summary parsed below — every count() would return null.
//   - HOME: os.homedir() reads it, which is what lets us simulate the outer
//     sandbox without actually being inside one.
function runSuite({ home } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (home) env.HOME = home;
  return spawnSync(process.execPath, [SUITE], { encoding: "utf8", timeout: 180_000, env });
}

const runSuiteWithHome = (home) => runSuite({ home });

const count = (out, field) => {
  const m = out.match(new RegExp(`^\\s*\\S*\\s*${field} (\\d+)$`, "m"));
  return m ? Number(m[1]) : null;
};

test(
  "nono isolation suite survives an unwritable $HOME instead of crashing at import",
  { skip: SKIP },
  () => {
    const r = withUnwritableHome(runSuiteWithHome);
    const out = `${r.stdout}${r.stderr}`;

    assert.doesNotMatch(
      out,
      /EACCES[\s\S]*ModuleJob\.run|Error: EACCES: permission denied, open/,
      "an unwritable $HOME must not surface as an unhandled module-load throw",
    );
    assert.equal(
      r.status,
      0,
      `suite should exit 0 under an unwritable $HOME; exit ${r.status}\n${out}`,
    );
    assert.equal(count(out, "fail"), 0, `no test should fail; got:\n${out}`);
  },
);

test(
  "an unwritable $HOME skips ONLY the $HOME-dependent tests, leaving the rest of the gate live",
  { skip: SKIP },
  () => {
    const r = withUnwritableHome(runSuiteWithHome);
    const out = `${r.stdout}${r.stderr}`;

    // The decoy test must announce WHY it stood down, so a skip in CI logs is
    // never mistaken for "nono verified this".
    assert.match(
      out,
      /outer sandbox/i,
      `the skip must name the outer sandbox as the cause; got:\n${out}`,
    );
    assert.match(out, /decoy/i, "the skip reason should identify the decoy fixture");

    // The anti-vacuous guard. If a future change makes the whole suite stand
    // down whenever $HOME is awkward, nono could regress silently while this
    // gate stayed green. Six of the NINE tests never touch $HOME — boot,
    // workdir read, workdir write, --open-port, --allow-unix-socket,
    // --block-net — and every one must still execute.
    assert.ok(
      count(out, "pass") >= 6,
      `the $HOME-independent isolation assertions must still run; got ${count(out, "pass")} passes:\n${out}`,
    );
    // Ceiling, not an exact count. THREE tests legitimately stand down:
    //   - the decoy, which cannot be planted in an unwritable $HOME;
    //   - ~/.ssh, since a scratch $HOME has no .ssh — and it lives under /tmp,
    //     which nono default-allows, so it could not be a meaningful denial
    //     target there;
    //   - multi-root (cloister-d8599e), whose three peer directories live in
    //     $HOME for exactly the /tmp reason above.
    //
    // This ceiling was 2 and correctly FAILED when the multi-root test landed —
    // which is the point: the number is a claim about which tests depend on
    // $HOME, so adding one has to be an explicit edit here, not a silent drift
    // upward. Anything above three means we started over-skipping.
    assert.ok(
      count(out, "skipped") <= 3,
      `only the three $HOME-dependent tests may skip; got ${count(out, "skipped")}:\n${out}`,
    );
  },
);

test(
  "a writable $HOME still runs the decoy test — the skip is conditional, not permanent",
  { skip: SKIP },
  () => {
    // Guards the other direction: the fix must not disable the decoy test on
    // ordinary hosts, which would silently retire the assertion it exists for.
    const r = runSuite();
    const out = `${r.stdout}${r.stderr}`;

    assert.equal(r.status, 0, `suite should pass on a normal host:\n${out}`);
    assert.equal(count(out, "skipped"), 0, `nothing should skip on a writable $HOME:\n${out}`);
    assert.match(
      out,
      /\$HOME decoy secret is kernel-denied/,
      "the decoy test must actually run when $HOME is writable",
    );
  },
);
