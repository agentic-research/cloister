// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The `cloister-harness` BINARY — the thing that actually ships.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// nono-isolation.test.mjs drives the `nono` CLI. That is a different artifact
// from this binary, which consumes nono as a LIBRARY at a version pinned in
// tools/harness-sandbox/Cargo.toml. The two can disagree, and did:
//
//     installed nono CLI      0.56.0
//     Cargo.toml pin          0.70
//
// So the nine green tests next door were not evidence about the pinned library
// at all — they would pass identically with the pin set to anything, because
// they never load it. Bumping 0.54 → 0.70 surfaced that: the build broke
// (`Sandbox::apply` → `apply_auto`), the isolation suite stayed green
// throughout, and nothing in the tree would have caught a semantic change.
//
// This closes that: it runs the compiled binary against a real policy and
// asserts the boundary the binary produces.
//
// ── What it deliberately does NOT cover ────────────────────────────────────
//
// The policy here carries no `confinement` block, so the §7 commitment check
// (cert chain → committed digest → BLAKE3 of the canonical manifest, verified
// BEFORE the irreversible apply) is skipped. That path needs a minted dev cert
// and belongs with the harness-dev flow, not here. What this asserts is the
// sandbox-and-exec half — the half the nono version bump can break.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "target", "release", "cloister-harness");

// Built by `task harness:sandbox:build`, which `verify:strict` depends on. A
// missing binary is a NAMED skip rather than a silent pass — "not built" and
// "confinement is broken" must never look alike.
const SKIP = existsSync(BIN)
  ? false
  : "cloister-harness not built — run `task harness:sandbox:build`";

// $HOME, not /tmp: nono default-ALLOWS /tmp so binaries can run, so an
// ungranted /tmp sibling would be readable for reasons unrelated to the grant.
// The same reason the decoy in nono-isolation.test.mjs lives here.
const BASE = join(homedir(), `.cloister-harness-test-${process.pid}`);
const WORK = join(BASE, "work");
const SECRET = join(BASE, "secret");
const SECRET_CONTENT = "MUST-NOT-BE-READABLE-CONFINED";

/** nono's macOS defaults, mirrored from the launcher's buildPolicy. */
const SYS_READ = [
  "/bin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/share",
  "/System/Library", "/Library", "/private/var", "/private/etc", "/private",
  "/opt", "/opt/homebrew",
];
const SYS_RW = ["/dev", "/tmp", "/private/tmp", "/private/var/folders"];

function runConfined(shellScript, { grants = [WORK] } = {}) {
  const policy = {
    capabilities: {
      version: "0.1.0",
      filesystem: {
        grants: [
          ...SYS_READ.map((path) => ({ path, access: "read", type: "directory" })),
          ...SYS_RW.map((path) => ({ path, access: "readwrite", type: "directory" })),
          ...grants.map((path) => ({ path, access: "readwrite", type: "directory" })),
        ],
        deny: [{ path: join(homedir(), ".ssh") }],
      },
      network: { mode: "blocked", ports: { localhost: [8799] } },
    },
    env_strip: [],
    env_set: {},
    harness_bin: "/bin/sh",
    harness_args: ["-c", shellScript],
  };
  const policyPath = join(BASE, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  // cwd inside a granted root: the confined process cannot getcwd() otherwise,
  // which is noise rather than signal for these assertions.
  return spawnSync(BIN, [policyPath], { cwd: WORK, encoding: "utf8", timeout: 60_000 });
}

// Can this host actually confine? macOS has Seatbelt; Linux needs a Landlock
// kernel. A runner without it makes `Sandbox::apply_auto` fail, which would
// surface as every assertion below failing for a reason that is a fact about the
// HOST rather than about cloister.
//
// Probed by running the binary once on a trivial script: if the granted root is
// readable, confinement applied. Anything else stands the suite down with the
// binary's own stderr in the reason — the same shape as nono-isolation's
// HAVE_NONO gate next door.
//
// This is the one place a silent skip would be dangerous, so the reason is
// always carried. "This kernel cannot confine" and "confinement is broken" must
// never render identically.
function probeSupport() {
  try {
    mkdirSync(WORK, { recursive: true });
    writeFileSync(join(WORK, "probe.txt"), "probe-ok");
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS") {
      return `outer sandbox denies $HOME writes (${err.code}) — cannot plant the fixture`;
    }
    throw err;
  }
  const r = runConfined(`cat ${join(WORK, "probe.txt")}`);
  if (`${r.stdout}${r.stderr}`.includes("probe-ok")) return false;
  const why = `${r.stderr || r.stdout || ""}`.trim().split("\n")[0] || `exit ${r.status}`;
  return `cloister-harness could not confine on this host — ${why}`;
}

const SETUP_SKIP = (() => {
  if (SKIP) return SKIP;
  const unsupported = probeSupport();
  if (unsupported) return unsupported;
  try {
    mkdirSync(WORK, { recursive: true });
    mkdirSync(SECRET, { recursive: true });
    writeFileSync(join(WORK, "inside.txt"), "hello-from-workdir");
    writeFileSync(join(SECRET, "secret.txt"), SECRET_CONTENT);
    return false;
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS") {
      return `outer sandbox denies $HOME writes (${err.code}) — cannot plant the fixture`;
    }
    throw err;
  }
})();

test("cloister-harness: a granted root is readable + writable", { skip: SETUP_SKIP }, () => {
  const r = runConfined(
    `cat ${WORK}/inside.txt; echo x > ${WORK}/written.txt && echo WROTE`,
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /hello-from-workdir/, `granted root must be readable:\n${out}`);
  assert.match(out, /WROTE/, `granted root must be WRITABLE, not merely readable:\n${out}`);
});

test("cloister-harness: an ungranted SIBLING is kernel-denied", { skip: SETUP_SKIP }, () => {
  // The load-bearing case. work/ and secret/ are peers under one parent, so a
  // grant that leaked to the parent would still pass a ~/.ssh-only check.
  const r = runConfined(`cat ${SECRET}/secret.txt 2>&1`);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /Operation not permitted|Permission denied/, `expected EPERM:\n${out}`);
  assert.doesNotMatch(out, new RegExp(SECRET_CONTENT), "the secret's contents must never appear");
});

test("cloister-harness: ~/.ssh is kernel-denied", { skip: SETUP_SKIP }, () => {
  const r = runConfined(`ls ${join(homedir(), ".ssh")} 2>&1`);
  assert.match(`${r.stdout}${r.stderr}`, /Operation not permitted|Permission denied/);
});

test("cloister-harness: MULTI-ROOT — every granted root is live", { skip: SETUP_SKIP }, () => {
  // `cloister run --repo A --repo B` emits one grant per root, and the attested
  // manifest counts them. This asserts the binary honours more than the first.
  const second = join(BASE, "second");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "b.txt"), "second-root");
  const r = runConfined(
    `cat ${WORK}/inside.txt; cat ${second}/b.txt; cat ${SECRET}/secret.txt 2>&1`,
    { grants: [WORK, second] },
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /hello-from-workdir/, "first root");
  assert.match(out, /second-root/, "second root — a grant list truncated to one would fail here");
  assert.match(out, /Operation not permitted|Permission denied/, "…and the sibling still denied");
});

test("cloister-harness: a malformed policy is refused, not applied", { skip: SETUP_SKIP }, () => {
  const bad = join(BASE, "bad.json");
  writeFileSync(bad, "{ not json");
  const r = spawnSync(BIN, [bad], { cwd: WORK, encoding: "utf8", timeout: 60_000 });
  assert.notEqual(r.status, 0, "a policy it cannot parse must be a hard failure");
  assert.doesNotMatch(`${r.stdout}`, /hello-from-workdir/, "nothing may have been exec'd");
});

test.after(() => {
  if (!SETUP_SKIP) rmSync(BASE, { recursive: true, force: true });
});
