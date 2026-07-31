// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Audit mode + confinement + a keychain-backed credential is a harness that
// launches cleanly and then reports "Not logged in", with nothing connecting
// the two. cloister-72f540.
//
// The measured facts behind the notice: a confined process cannot read a
// Keychain item; granting the keychain FILE does not change that (Keychain is
// mediated by securityd over mach/XPC, not by reading the file); nono exposes
// no mach/XPC grant; and `deny_keychains_macos` is in nono's DEFAULT profile,
// inherited by every agent profile it ships. So it is the platform's
// granularity rather than a missing flag.
//
// These assert BOTH directions. A notice that always fires is as wrong as one
// that never does — it would train the operator to ignore it, on exactly the
// setups where audit mode works fine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launch } from "../../cli/lib/harness/launch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Drive `launch` far enough to emit the notice, then stop before minting. */
async function noticeFor({ credentialFileExists, sandbox = true }) {
  let out = "";
  const deps = {
    errLog: (m) => { out += `${m}\n`; },
    // Only the credential-file probe consults `exists` in a way that matters
    // here; everything else must resolve so the plan is built.
    exists: (p) => (p.endsWith(".credentials.json") ? credentialFileExists : true),
    execFileSync: (file, args) => {
      if (file === "which") return "/usr/bin/true\n";
      // The mint step. Throwing here stops before any credential exists, which
      // is the point: the notice must be emitted BEFORE minting, so an operator
      // who reads it and aborts has not caused a cert to be written.
      throw new Error("STOP-BEFORE-MINT");
    },
  };
  const request = {
    root: ROOT,
    targetName: "claude-code",
    setupOnly: true,
    wantsAudit: true,
    credentialEnv: {},           // no API key ⇒ audit mode
    sandbox: sandbox ? { provider: "nono", workdirs: [ROOT], label: "--repo" } : null,
  };
  await assert.rejects(launch(request, deps), /STOP-BEFORE-MINT/);
  return out;
}

test("audit + confinement + NO credential file ⇒ the operator is told why, and how to fix it", async () => {
  const out = await noticeFor({ credentialFileExists: false });
  assert.match(out, /may be unauthenticated/, "the symptom must be named");
  assert.match(out, /deny_keychains_macos/, "…with the actual reason, not a vague warning");
  assert.match(out, /Not logged in/, "…and the message the operator will actually see");
  assert.match(out, /ANTHROPIC_API_KEY/, "a warning with no remedy is noise");
  assert.match(out, /custody/, "the remedy must name the lane that works");
});

test("the notice is emitted BEFORE the minting step", async () => {
  // Ordering matters: an operator who reads the notice and aborts must not have
  // caused a credential to be written.
  //
  // Asserted as ORDER, not absence. `performSetup` logs "minting…" and THEN
  // calls the minter, so the line is present in the log either way — an
  // absence assertion would fail against correct code, which is what the first
  // draft of this test did.
  const out = await noticeFor({ credentialFileExists: false });
  const notice = out.indexOf("may be unauthenticated");
  const minting = out.indexOf("minting a fresh ephemeral");
  assert.notEqual(notice, -1, "the notice must be emitted");
  assert.notEqual(minting, -1, "the fixture must actually reach the minting step");
  assert.ok(
    notice < minting,
    `the notice must precede minting so aborting on it costs nothing; ` +
    `notice@${notice}, minting@${minting}`,
  );
});

test("a credential FILE under the state dir suppresses it — that setup works", async () => {
  // The false-positive direction. `.claude` is granted rw under confinement, so
  // a file-based credential is readable and audit mode authenticates normally.
  // Warning there would be wrong and would erode the warning that matters.
  const out = await noticeFor({ credentialFileExists: true });
  assert.doesNotMatch(out, /may be unauthenticated/);
});

test("UNCONFINED audit does not warn — the sandbox is what denies the keychain", async () => {
  const out = await noticeFor({ credentialFileExists: false, sandbox: false });
  assert.doesNotMatch(out, /may be unauthenticated/, "no confinement, no keychain denial");
});

test("the state dir the notice names is the one actually granted rw", async () => {
  // The notice tells the operator where it looked. If that path drifted from
  // the granted stateDir, the advice would point at a directory the harness
  // does not use — a plausible, wrong instruction.
  const out = await noticeFor({ credentialFileExists: false });
  const { loadHarnessConfig } = await import("../../cli/lib/harness/targets.mjs");
  const { targets } = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
  const t = targets.find((x) => x.name === "claude-code");
  assert.ok(out.includes(join(process.env.HOME ?? "", t.stateDir)), "must name the granted state dir");
});

// ── the harness's OWN config paths must be granted (cloister-72f540) ───────
//
// `~/.claude` and `~/.claude.json` are TWO paths — a directory and a sibling
// file — and granting the directory does not reach the file. Anthropic's
// sandbox-runtime guidance names both
// (code.claude.com/docs/en/sandbox-environments).
//
// Granting only the directory produced `error: An internal error occurred
// (EPERM)` — an opaque failure that I misdiagnosed as an auth problem. With
// both granted, the harness starts and diagnoses ITSELF far more precisely than
// cloister can infer.

test("the plan grants the config FILE, not just the state directory", async () => {
  const { resolvePlan } = await import("../../cli/lib/harness/launch.mjs");
  const plan = await resolvePlan({
    root: ROOT, targetName: "claude-code", setupOnly: true, wantsAudit: true,
    credentialEnv: {},
    sandbox: { provider: "nono", workdirs: [ROOT], label: "--repo" },
  }, { exists: () => true, execFileSync: () => "/usr/bin/true\n" });

  assert.equal(
    plan.sandbox.configFile, `${plan.sandbox.stateDir}.json`,
    "the config file is `<stateDir>.json`, so renaming the state dir keeps them paired",
  );
  assert.notEqual(
    plan.sandbox.configFile, plan.sandbox.stateDir,
    "they are different paths — that is the entire bug this asserts against",
  );
});

test("buildPolicy actually EMITS grants for the config file and install tree", async () => {
  // The plan carrying the fields proves nothing if the policy drops them —
  // which is the shape of the original defect one layer down.
  const { resolvePlan, buildPolicy } = await import("../../cli/lib/harness/launch.mjs");
  const plan = await resolvePlan({
    root: ROOT, targetName: "claude-code", setupOnly: true, wantsAudit: true,
    credentialEnv: {},
    sandbox: { provider: "nono", workdirs: [ROOT], label: "--repo" },
  }, { exists: () => true, execFileSync: () => "/usr/bin/true\n" });

  const policy = buildPolicy(plan, {
    certDerB64Url: "x", masterPubB64Std: "y",
    peerFp: "z", epoch: 1, ephemeralPrivSeedB64Url: "a", ephemeralPubB64Url: "b",
  });
  const granted = policy.capabilities.filesystem.grants.map((g) => g.path);
  assert.ok(
    granted.includes(plan.sandbox.configFile),
    `config file must be granted; got:\n${granted.join("\n")}`,
  );
  if (plan.sandbox.installDir) {
    assert.ok(granted.includes(plan.sandbox.installDir), "install tree must be granted");
  }
});
