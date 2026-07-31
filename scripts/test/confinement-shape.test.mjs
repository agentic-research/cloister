// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The confinement manifest is what the cert commits to. These assert the two
// halves of that commitment that a reader has to take on faith otherwise:
//
//   1. WHICH directories you confine does not change the digest. That is why
//      `cloister run --repo <anything>` works against one attested shape.
//   2. HOW MANY directories you confine DOES change it. Without this, a cert
//      minted against a one-root shape would satisfy the §7 commitment check
//      for a run confined to five — the manifest would be attesting a boundary
//      it no longer describes, and nothing would say so.
//
// Property 2 is the one that only became falsifiable when --repo learned to
// repeat. Property 1 is older and is asserted here because the multi-root change
// is exactly the kind that could break it silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

import { confinementManifest } from "../lib/harness/launch.mjs";
import { loadHarnessConfig } from "../harness-targets.mjs";

// NOT a provider name. The confinement shape is provider-independent — that is
// the property, and hardcoding one harness's service here would both assert
// less and put a provider literal outside scripts/harness-targets.mjs, which
// `lint:harness-target-literals` exists to prevent ("a harness is a lattice
// participant, not a special case"). The declared services are exercised
// separately, below, against whatever cluster.toml actually declares.
const SVC = "svc";

// Not BLAKE3 — the point here is DISTINGUISHABILITY of the manifest bytes, and
// any collision-resistant digest answers that. The real §6 digest is computed by
// the Rust minter over the same canonical bytes; asserting equality against a
// hardcoded BLAKE3 value here would test this file's constant, not the shape.
const digest = (m) => createHash("sha256").update(JSON.stringify(m)).digest("hex");

test("the one-root manifest is byte-identical to the pre-multi-root shape", () => {
  // The literal below is what the manifest was before `workspace.N` existed. If
  // this fails, every previously-minted single-repo cert stopped verifying — a
  // breaking change that would otherwise show up as a §7 mismatch at exec time
  // with nothing pointing at the cause.
  assert.deepEqual(confinementManifest(1, SVC), {
    version: "cloister/confinement/v1",
    fs: { allow: [{ path: "workspace", mode: "rw" }, { path: "state", mode: "rw" }] },
    network: { allowHosts: ["127.0.0.1"] },
    port: { bind: 0 },
    credentialSource: `vault://${SVC}`,
  });
});

test("WHICH repo you confine is absent from the manifest entirely", () => {
  // Non-vacuity for property 1, stated as the absence it actually is: no
  // absolute path appears anywhere in the serialized manifest. Asserting two
  // calls agree would prove nothing, since the function takes no path at all —
  // this asserts the reason that is true.
  // Scoped to fs.allow: `credentialSource` is a vault:// URI and legitimately
  // contains separators, so checking the whole document would fail for a reason
  // that has nothing to do with the property.
  const allow = confinementManifest(3, SVC).fs.allow;
  for (const entry of allow) {
    assert.doesNotMatch(entry.path, /[/\\]/, `${entry.path} — a separator means a real path leaked`);
  }
  assert.deepEqual(allow.map((e) => e.path), ["workspace", "workspace.1", "workspace.2", "state"]);
});

test("HOW MANY roots changes the digest — one root does not attest three", () => {
  const one = digest(confinementManifest(1, SVC));
  const two = digest(confinementManifest(2, SVC));
  const three = digest(confinementManifest(3, SVC));
  assert.notEqual(one, two, "a 1-root cert must not satisfy a 2-root confinement");
  assert.notEqual(two, three);
  assert.notEqual(one, three);
});

test("the root count is the entry count — the shape says how wide it is", () => {
  for (const n of [1, 2, 5]) {
    const rw = confinementManifest(n, SVC).fs.allow;
    // n workspaces + state. If these ever diverge, the manifest claims a
    // different width than the kernel grants it is built alongside.
    assert.equal(rw.length, n + 1, `${n} roots ⇒ ${n} workspace entries + state`);
    assert.equal(rw.filter((e) => e.path.startsWith("workspace")).length, n);
    assert.ok(rw.every((e) => e.mode === "rw"));
  }
});

test("zero roots is refused, not silently rendered as an empty allow-list", () => {
  // An empty fs.allow is a VALID-looking confinement/v1 document that grants
  // nothing — the harness would launch and fail on its first read, which reads
  // as a broken harness rather than a malformed request.
  assert.throws(() => confinementManifest(0, SVC), /at least one writable root/);
  assert.throws(() => confinementManifest(-1, SVC), /at least one writable root/);
});

test("the shape is identical for EVERY declared target — no harness is a special case", async () => {
  // Derived from cluster.toml rather than a list here, so adding a third harness
  // is covered without editing this file. The service name reaches exactly one
  // field (credentialSource); if it ever reached the fs/network/port shape, one
  // provider would be confined differently from another with nothing saying so.
  const { targets } = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
  assert.ok(targets.length >= 1, "cluster.toml must declare at least one harness target");

  const shapeOf = (m) => ({ fs: m.fs, network: m.network, port: m.port, version: m.version });
  const reference = shapeOf(confinementManifest(2, SVC));
  for (const t of targets) {
    const m = confinementManifest(2, t.service);
    assert.deepEqual(shapeOf(m), reference, `${t.name} is confined differently`);
    assert.equal(m.credentialSource, `vault://${t.service}`, `${t.name} vaults its own service`);
  }
});

// ── the set rules belong to the CONFINEMENT, not to one door's flag syntax ──

test("every door's roots go through ONE validator — no per-door copy", async () => {
  // The gap this closes: the duplicate/nested refusal was written in
  // cli-run.mjs, so `cloister run --repo /a --repo /a/b` was refused while
  // HARNESS_WORKDIRS='["/a","/a/b"]' sailed through — same defect, other door,
  // and every CLI test still green. A rule about the attested shape cannot live
  // at one entry point.
  //
  // lint-allow-rawparse: "is this logic written twice" is a textual property.
  const { readFileSync } = await import("node:fs");
  const cliRun = readFileSync(resolve(ROOT, "scripts/cli-run.mjs"), "utf8");
  const bin = readFileSync(resolve(ROOT, "scripts/harness-dev.mjs"), "utf8");
  for (const [name, src] of [["cli-run.mjs", cliRun], ["harness-dev.mjs", bin]]) {
    assert.doesNotMatch(
      src, /given twice|is inside/,
      `${name} restates a set rule that validateWorkdirSet owns`,
    );
  }
  assert.match(cliRun, /validateWorkdirSet/, "cli-run must delegate to the shared validator");
});

test("the shape is validated BEFORE the toolchain — the error names the real problem", async () => {
  // Ordering, asserted because it is invisible: resolveSandbox used to resolve
  // the harness executable first, so a nested-root request was reported as
  // "could not resolve claude-code on $PATH" — the wrong problem, behind a
  // 45-second cargo build. A confinement error must not be shadowed by a
  // toolchain one.
  const { resolvePlan } = await import("../lib/harness/launch.mjs");
  await assert.rejects(
    resolvePlan({
      root: ROOT, targetName: null, setupOnly: true, wantsAudit: false, credentialEnv: {},
      sandbox: { provider: "nono", workdirs: ["/tmp/x", "/tmp/x/inner"], label: "--repo" },
    }, {
      // Both would fail loudly if reached. Reaching either means the shape was
      // not checked first.
      exists: () => false,
      execFileSync: () => { throw new Error("toolchain reached before the shape was checked"); },
    }),
    /is inside/,
  );
});

// ── relocate, don't narrow ────────────────────────────────────────────────
//
// Two shared writable paths were reachable by anything the harness runs, and
// NEITHER was fixable by narrowing a grant — nono's grants are a UNION, and
// `deny` is a full deny rather than a write-deny. Measured both times.
//
// What works is changing where the bytes live. These assert the resulting
// policy, since the mechanism is only correct if the emitted grants say so.

test("scratch is per-run, and the shared /tmp grant is GONE", async () => {
  const { resolvePlan, buildPolicy } = await import("../lib/harness/launch.mjs");
  const plan = await resolvePlan({
    root: ROOT, targetName: "claude-code", setupOnly: true, wantsAudit: true,
    credentialEnv: {}, sandbox: { provider: "nono", workdirs: [ROOT], label: "--repo" },
  }, { exists: () => true, execFileSync: () => "/usr/bin/true\n" });
  const policy = buildPolicy(plan, {
    certDerB64Url: "x", masterPubB64Std: "y", peerFp: "z",
    epoch: 1, ephemeralPrivSeedB64Url: "a", ephemeralPubB64Url: "b",
  });
  const paths = policy.capabilities.filesystem.grants.map((g) => g.path);

  // The regression this exists for: /tmp was readwrite, so two confined runs
  // shared a path neither declared — a channel between runs.
  assert.ok(!paths.includes("/tmp"), `/tmp must not be granted; got: ${paths.join(", ")}`);
  assert.ok(!paths.includes("/private/tmp"), "/private/tmp must not be granted either");

  // …but the harness's OWN per-uid runtime dir must be, or a real launch dies
  // with `EPERM: mkdir '/tmp/claude-501'`. Claude Code uses a FIXED path there,
  // not a TMPDIR lookup, so redirecting scratch does not cover it. `claude
  // doctor` does not hit this — only a full launch does, which is how it
  // reached a user rather than a test.
  const runtime = paths.find((p) => /^\/tmp\/claude-\d+$/.test(p));
  assert.ok(runtime, `the per-uid runtime dir must be granted; got: ${paths.join(", ")}`);
  // Scoped to one directory — granting /tmp wholesale is what opened the
  // cross-run channel this test exists to keep closed.
  assert.ok(runtime.startsWith("/tmp/claude-"), "scoped to the harness's own runtime dir");

  // …and the replacement must actually exist, or tools lose scratch entirely.
  assert.ok(paths.includes(plan.sandbox.scratchDir), "per-run scratch must be granted");
  assert.equal(policy.env_set.TMPDIR, plan.sandbox.scratchDir);
  assert.equal(policy.env_set.TMP, plan.sandbox.scratchDir, "TMP too — tools disagree on which they read");
  assert.equal(policy.env_set.TEMP, plan.sandbox.scratchDir);
});

test("a relocated skills store is granted READ, never readwrite", async () => {
  const { buildPolicy } = await import("../lib/harness/launch.mjs");
  const plan = {
    root: ROOT, shimPort: "8799", baseUrl: "http://127.0.0.1:8799/x",
    auth: { mode: "audit" },
    target: { stripEnv: [], baseUrlEnv: "X", name: "t", service: "s" },
    confinementManifest: {},
    sandbox: {
      provider: "nono", confineBin: "/bin/true", workdirs: [ROOT],
      stateDir: "/tmp/state", configFile: "/tmp/state.json", installDir: null,
      skillStore: "/tmp/skillstore", scratchDir: "/tmp/scratch",
      harnessBin: "/bin/true", harnessArgs: [],
    },
  };
  const grants = buildPolicy(plan, {
    certDerB64Url: "x", masterPubB64Std: "y", peerFp: "z",
    epoch: 1, ephemeralPrivSeedB64Url: "a", ephemeralPubB64Url: "b",
  }).capabilities.filesystem.grants;

  const store = grants.find((g) => g.path === "/tmp/skillstore");
  assert.ok(store, "the relocated store must be granted");
  assert.equal(store.access, "read", "READ — a writable skills tree is the vector this closes");
  // The state dir stays writable; that is the whole point of relocating rather
  // than narrowing. Sessions, history and settings still need it.
  assert.equal(grants.find((g) => g.path === "/tmp/state")?.access, "readwrite");
});
