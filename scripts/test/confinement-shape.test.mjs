// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The confinement manifest is what the cert commits to. These assert the two
// halves of that commitment that a reader has to take on faith otherwise:
//
//   1. WHICH directories you confine does not change the digest. That is why
//      `cloister run --repo <anything>` works against one attested shape.
//   2. HOW MANY directories you confine DOES change it. Without this, a cert
//      minted against a one-root shape would satisfy the §8 commitment check
//      for a run confined to five — the manifest would be attesting a boundary
//      it no longer describes, and nothing would say so.
//
// And since cloister-d2ba07, the third thing a reader would otherwise take on
// faith: the document cloister emits actually CONFORMS to confinement/v1. It did
// not — `credentialSource: "vault://<service>"` used a scheme §5 does not close
// over, so a conforming runner refused it at parse. Asserting the digest matches
// LLO's canonical vector never noticed, because that vector is LLO's document,
// not one this builder produced.
//
// Property 2 is the one that only became falsifiable when --repo learned to
// repeat. Property 1 is older and is asserted here because the multi-root change
// is exactly the kind that could break it silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

import {
  confinementManifest, resolveCompanionWorkers, assertPortsFree, killProcessGroup,
} from "../../cli/lib/harness/launch.mjs";
import { loadHarnessConfig } from "../../cli/lib/harness/targets.mjs";

// NOT a provider name. The confinement shape is provider-independent — that is
// the property, and hardcoding one harness's service here would both assert
// less and put a provider literal outside scripts/harness-targets.mjs, which
// `lint:harness-target-literals` exists to prevent ("a harness is a lattice
// participant, not a special case"). The declared services are exercised
// separately, below, against whatever cluster.toml actually declares.
const SVC = "svc";

// Not BLAKE3 — the point here is DISTINGUISHABILITY of the manifest bytes, and
// any collision-resistant digest answers that. The real §7 digest is computed by
// the Rust minter over the same canonical bytes; asserting equality against a
// hardcoded BLAKE3 value here would test this file's constant, not the shape.
const digest = (m) => createHash("sha256").update(JSON.stringify(m)).digest("hex");

test("the one-root manifest is exactly the three dimensions the harness declares", () => {
  // A pinned literal, so a change to the emitted shape has to be deliberate: the
  // digest is committed into every minted cert, and a silent change shows up as
  // an §8 mismatch at exec time with nothing pointing at the cause.
  //
  // `credentialSource` is ABSENT, which is the §5-conforming way to say what is
  // true — the harness authenticates against no keystore, because the vault
  // proxy injects the credential as a header and the process never holds it. It
  // previously read `vault://<service>`; see the header note.
  assert.deepEqual(confinementManifest(1), {
    version: "cloister/confinement/v1",
    fs: {
      allow: [
        { path: "/run/cloister/workspace/", mode: "rw" },
        { path: "/run/cloister/state/", mode: "rw" },
      ],
    },
    network: { allowHosts: ["127.0.0.1"] },
    port: { bind: 0 },
  });
});

test("the emitted document conforms to §5 — no invented credential scheme", () => {
  // The rail that would have caught cloister-d2ba07 at the builder. Inv 11 now
  // checks the operator-declared facet in cluster.capnp; this checks the one
  // cloister generates, which no operator declares and Inv 11 therefore never
  // sees. Both are needed — the bug lived in the half Inv 11 does not read.
  //
  // Written as "absent, or a §5 scheme" rather than "absent", so re-introducing
  // the field for a real keystore binding stays possible and stays checked.
  const SCHEMES = [
    "keychain://", "secret-tool://", "keyring://", "file://", "op://", "apple-password://",
  ];
  for (const n of [1, 3]) {
    const source = confinementManifest(n).credentialSource;
    if (source === undefined) continue;
    const scheme = SCHEMES.find((s) => source.startsWith(s));
    assert.ok(
      scheme && source.length > scheme.length,
      `credentialSource ${JSON.stringify(source)} is not a §5 scheme with a non-empty ` +
        `remainder — a conforming runner refuses the document at parse`,
    );
  }
});

test("WHICH repo you confine is absent from the manifest entirely", () => {
  // Non-vacuity for property 1, stated as the absence it actually is: no
  // absolute path appears anywhere in the serialized manifest. Asserting two
  // calls agree would prove nothing, since the function takes no path at all —
  // this asserts the reason that is true.
  //
  // RESTATED for cloister-bd6399. The old form asserted no path separator
  // appeared in an fs.allow entry, which worked only while the roots were bare
  // names (`workspace`). §2 requires absolute paths, so separators are now
  // expected and "contains a slash" no longer distinguishes a symbolic root
  // from a leaked host path.
  //
  // The property was never really "no separators" — it is "no CALLER INPUT
  // reaches the document", and that is what is asserted directly now: the
  // emitted paths are exactly the symbolic constants, and they are the same
  // whatever the caller passed. A leaked workdir would have to appear here to
  // do any harm, and it cannot, because these strings are built from a fixed
  // prefix and an index.
  const allow = confinementManifest(3).fs.allow;
  assert.deepEqual(allow.map((e) => e.path), [
    "/run/cloister/workspace/",
    "/run/cloister/workspace.1/",
    "/run/cloister/workspace.2/",
    "/run/cloister/state/",
  ]);
  // Non-vacuity: the constants above are only meaningful if a real host path
  // would be visibly different. `process.cwd()` stands in for the workdir a
  // caller actually passes — no entry may contain it, or any part of $HOME.
  const serialized = JSON.stringify(confinementManifest(3));
  assert.doesNotMatch(serialized, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("HOW MANY roots changes the digest — one root does not attest three", () => {
  const one = digest(confinementManifest(1));
  const two = digest(confinementManifest(2));
  const three = digest(confinementManifest(3));
  assert.notEqual(one, two, "a 1-root cert must not satisfy a 2-root confinement");
  assert.notEqual(two, three);
  assert.notEqual(one, three);
});

test("the root count is the entry count — the shape says how wide it is", () => {
  for (const n of [1, 2, 5]) {
    const rw = confinementManifest(n).fs.allow;
    // n workspaces + state. If these ever diverge, the manifest claims a
    // different width than the kernel grants it is built alongside.
    assert.equal(rw.length, n + 1, `${n} roots ⇒ ${n} workspace entries + state`);
    assert.equal(rw.filter((e) => e.path.startsWith("/run/cloister/workspace")).length, n);
    assert.ok(rw.every((e) => e.mode === "rw"));
  }
});

test("zero roots is refused, not silently rendered as an empty allow-list", () => {
  // An empty fs.allow is a VALID-looking confinement/v1 document that grants
  // nothing — the harness would launch and fail on its first read, which reads
  // as a broken harness rather than a malformed request.
  assert.throws(() => confinementManifest(0), /at least one writable root/);
  assert.throws(() => confinementManifest(-1), /at least one writable root/);
});

test("no declared target's service name appears in the manifest at all", async () => {
  // "Every target is confined identically" is now true BY CONSTRUCTION —
  // `confinementManifest` takes no service, so it cannot vary by one. Asserting
  // two calls agree would test nothing, which is exactly the vacuity this file
  // avoids elsewhere. So assert the stronger fact that makes it true: no service
  // name reaches the document.
  //
  // Derived from cluster.toml rather than a list here, so adding a third harness
  // is covered without editing this file. `lint:harness-target-literals` is why
  // no provider name is written down in this test.
  const { targets } = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
  assert.ok(targets.length >= 1, "cluster.toml must declare at least one harness target");

  const document = JSON.stringify(confinementManifest(2));
  for (const t of targets) {
    assert.doesNotMatch(
      document,
      new RegExp(t.service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${t.name}: service "${t.service}" reached the confinement document — the boundary ` +
        `is provider-independent, and a per-provider digest would attest a difference ` +
        `the sandbox does not enforce`,
    );
  }
  // Non-vacuity: the guard above only means something if a service name COULD
  // have appeared. SVC stands in for one that is not declared, proving the
  // matcher fires on a name the document does contain.
  assert.match(JSON.stringify({ credentialSource: `vault://${SVC}` }), new RegExp(SVC));
});

// ── the set rules belong to the CONFINEMENT, not to one door's flag syntax ──

test("every door's roots go through ONE validator — no per-door copy", async () => {
  // The gap this closes: the duplicate/nested refusal was written in
  // cli/commands/run.mjs, so `cloister run --repo /a --repo /a/b` was refused while
  // HARNESS_WORKDIRS='["/a","/a/b"]' sailed through — same defect, other door,
  // and every CLI test still green. A rule about the attested shape cannot live
  // at one entry point.
  //
  // lint-allow-rawparse: "is this logic written twice" is a textual property.
  const { readFileSync } = await import("node:fs");
  const cliRun = readFileSync(resolve(ROOT, "cli/commands/run.mjs"), "utf8");
  const bin = readFileSync(resolve(ROOT, "scripts/harness-dev.mjs"), "utf8");
  for (const [name, src] of [["cli/commands/run.mjs", cliRun], ["harness-dev.mjs", bin]]) {
    assert.doesNotMatch(
      src, /given twice|is inside/,
      `${name} restates a set rule that validateWorkdirSet owns`,
    );
  }
  assert.match(cliRun, /validateWorkdirSet/, "cloister run must delegate to the shared validator");
});

test("the shape is validated BEFORE the toolchain — the error names the real problem", async () => {
  // Ordering, asserted because it is invisible: resolveSandbox used to resolve
  // the harness executable first, so a nested-root request was reported as
  // "could not resolve claude-code on $PATH" — the wrong problem, behind a
  // 45-second cargo build. A confinement error must not be shadowed by a
  // toolchain one.
  const { resolvePlan } = await import("../../cli/lib/harness/launch.mjs");
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
  const { resolvePlan, buildPolicy } = await import("../../cli/lib/harness/launch.mjs");
  const plan = await resolvePlan({
    root: ROOT, targetName: "claude-code", setupOnly: true, wantsAudit: true,
    credentialEnv: {}, sandbox: { provider: "nono", workdirs: [ROOT], label: "--repo" },
  }, {
    exists: () => true,
    execFileSync: () => "/usr/bin/true\n",
    resolveNativeHelper: () => "/usr/bin/true",
  });
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
  const { buildPolicy } = await import("../../cli/lib/harness/launch.mjs");
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

// ── Companion Workers ──────────────────────────────────────────────────────
//
// A real run printed `env.NOTME (notme-bot) Worker local [not connected]`,
// which reads as a broken binding and really means nothing local runs that
// Worker. These assert the SET is DERIVED from wrangler.toml rather than
// hand-listed — a second list is what drifts the first time a binding is
// added — and that the shipped tree's real bindings are covered.

test("companion Workers are derived from wrangler.toml's [[services]]", () => {
  const workers = resolveCompanionWorkers(
    ['[[services]]', 'binding = "A_BINDING"', 'service = "a-worker"', '',
     '[[services]]', 'binding = "B_BINDING"', 'service = "b-worker"'].join("\n"),
    {},
  );
  assert.deepEqual(workers.map((w) => w.service), ["a-worker", "b-worker"]);
  // Absent env → dir null, which the launcher renders as a NAMED warning.
  // Silence is the bug being fixed: [not connected] with no stated cause.
  assert.deepEqual(workers.map((w) => w.dir), [null, null]);
  assert.deepEqual(workers.map((w) => w.envVar),
    ["CLOISTER_WORKER_DIR_A_WORKER", "CLOISTER_WORKER_DIR_B_WORKER"]);
});

test("companion Workers: the env knob supplies the path, and ~ expands", () => {
  const [w] = resolveCompanionWorkers(
    '[[services]]\nbinding = "NOTME"\nservice = "notme-bot"\n',
    { CLOISTER_WORKER_DIR_NOTME_BOT: "~/somewhere/worker", HOME: "/Users/x" },
  );
  assert.equal(w.dir, "/Users/x/somewhere/worker");
});

test("no companion Worker can take cloister's port or the shim's", () => {
  // The bug this exists for: `wrangler dev` defaults to 8787 for EVERY worker,
  // and neither cloister's wrangler.toml nor notme's declares a port. An
  // unported companion binds 8787 first and cloister's own `task dev` then dies
  // on `Address already in use` — the feature meant to connect a binding would
  // have broken every run instead. Caught before shipping, railed after.
  const many = Array.from({ length: 12 }, (_, i) =>
    `[[services]]\nbinding = "B${i}"\nservice = "w-${i}"`).join("\n\n");
  const ports = resolveCompanionWorkers(many, {}).map((w) => w.port);
  assert.ok(!ports.includes(8787), `companion took cloister's port: ${ports.join(", ")}`);
  assert.ok(!ports.includes(8799), `companion took the shim's port: ${ports.join(", ")}`);
  assert.equal(new Set(ports).size, ports.length, "…and no two companions collide with each other");
});

test("the SHIPPED wrangler.toml's service bindings are all covered", () => {
  // Against the real tree, so the rail cannot pass on fixtures alone. NOTME is
  // the binding the reported run showed disconnected.
  const real = resolveCompanionWorkers(
    readFileSync(resolve(ROOT, "wrangler.toml"), "utf8"), {},
  );
  assert.ok(real.length > 0, "wrangler.toml declares at least one [[services]] binding");
  assert.ok(real.some((w) => w.binding === "NOTME" && w.service === "notme-bot"),
    `NOTME must be among the derived companions; got: ${real.map((w) => w.binding).join(", ")}`);
});

// ── Run affinity ───────────────────────────────────────────────────────────
//
// Five runs leaked five cloisters (8787-8791), because `task dev` spawns
// wrangler which spawns workerd — grandchildren that survive killing the
// leader. The leak made the HEALTH CHECK LIE: wrangler falls forward to the
// next free port, so a later run bound 8788 while waitForHealth polled 8787 and
// got a healthy 200 from the stale server.

test("assertPortsFree: a free set passes", () => {
  assertPortsFree([8787, 8799], { probe: () => false });
});

test("assertPortsFree: a busy port is FAIL-CLOSED, and says how to clear it", () => {
  // Fail-closed is the whole point: wrangler does not fail on a busy port, it
  // moves to the next one. A warning here would leave the lying health check.
  let err;
  try { assertPortsFree([8787, 8799], { probe: (p) => p === 8787 }); }
  catch (e) { err = e; }
  assert.ok(err, "a busy port must throw, not warn");
  assert.match(err.message, /8787/);
  assert.match(err.message, /lsof/, "names how to find the holder");
  assert.match(err.message, /pkill/, "…and how to clear it");
  // The reason must survive, or the next reader re-derives it from scratch.
  assert.match(err.message, /wrangler does NOT fail on a busy port/);
});

test("killProcessGroup signals the GROUP, not just the leader", () => {
  const signalled = [];
  const realKill = process.kill;
  // @ts-ignore — swapped for the assertion, restored below
  process.kill = (pid, sig) => { signalled.push([pid, sig]); };
  try {
    killProcessGroup({ pid: 4242, kill: () => signalled.push(["direct", null]) });
  } finally {
    process.kill = realKill;
  }
  // NEGATIVE pid = the process group. A positive pid here is the leak.
  assert.deepEqual(signalled, [[-4242, "SIGTERM"]]);
});

test("killProcessGroup falls back to the leader when no group exists", () => {
  let direct = 0;
  killProcessGroup({ pid: undefined, kill: () => { direct++; } });
  assert.equal(direct, 1, "a platform without process groups must still stop the leader");
});

test("several bindings on ONE service launch ONE process", () => {
  // Real shape, not hypothetical: cloister binds notme-bot three times — NOTME
  // for the /identity/* fetch proxy, NOTME_JWT and NOTME_RECEIPTS for two
  // distinct RPC entrypoints, each its own binding for least privilege
  // (notme's ReceiptSigner comment is explicit that sharing one binding would
  // redirect /identity/* to a class with no fetch handler).
  //
  // Mapping bindings 1:1 to processes started notme-bot THREE times on three
  // ports. That is not merely wasteful: wrangler pairs service bindings
  // through its dev registry by worker NAME, so three live registrations of
  // one name is the single thing that mechanism cannot survive.
  const workers = resolveCompanionWorkers(
    ['[[services]]', 'binding = "NOTME"', 'service = "notme-bot"', '',
     '[[services]]', 'binding = "NOTME_JWT"', 'service = "notme-bot"',
     'entrypoint = "JwtSigner"', '',
     '[[services]]', 'binding = "NOTME_RECEIPTS"', 'service = "notme-bot"',
     'entrypoint = "ReceiptSigner"', '',
     '[[services]]', 'binding = "OTHER"', 'service = "other-worker"'].join("\n"),
    {},
  );
  assert.deepEqual(workers.map((w) => w.service), ["notme-bot", "other-worker"]);
  // Ports stay distinct across the DEDUPED set — indexing after the dedupe, not
  // before, or the second service would inherit a gap and the assertion above
  // would pass while the ports told a different story.
  assert.equal(new Set(workers.map((w) => w.port)).size, workers.length);
});

test("the real wrangler.toml resolves one process per distinct service", () => {
  // Runs against the SHIPPED tree, so adding a fourth notme binding cannot
  // reintroduce the fan-out without failing here. A fixture-only version of
  // this test would have passed throughout the bug it exists to prevent.
  const workers = resolveCompanionWorkers(
    readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8"), {});
  assert.equal(new Set(workers.map((w) => w.service)).size, workers.length,
    "one entry per distinct service");
});

// ── the emitted document, checked against LLO's SCHEMA (cloister-bd6399) ──
//
// Two refusals have now been found by running cloister's document through a
// conforming runner rather than by any check here: `credentialSource:
// "vault://…"` (§5, cloister-d2ba07) and bare `workspace` paths (§2, this bead).
// The second was hiding behind the first — fixing §5 let the parse get far
// enough to reach §2.
//
// That is what per-dimension checks buy: one refusal at a time, in the order a
// parser happens to hit them. So this drives the constraints FROM
// `confinement.schema.json` instead of restating them. `AbsolutePath.pattern`
// is read, not copied — if LLO tightens it, this tightens with it, and a
// dimension cloister has not thought about is still covered.
//
// Local-only, matching `lint:spec-citation`'s existence half: a CI runner has
// cloister and no sibling checkout. The portable checks above (pinned literal,
// §5 schemes) stay unconditional.

const SCHEMA_PATH = resolve(
  process.env.CLOISTER_LLO_ROOT ?? resolve(ROOT, "../ley-line-open"),
  "rs/ll-core/schema-spec/confinement/v1/confinement.schema.json",
);
const schemaMissing = !existsSync(SCHEMA_PATH);

test("the emitted document satisfies the constraints LLO's schema declares", { skip: schemaMissing }, () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const manifest = confinementManifest(3);

  // version — read the `const`, do not spell it here.
  assert.equal(manifest.version, schema.properties.version.const);

  // fs.allow paths — apply the schema's own AbsolutePath regex. This is the
  // check that would have caught bare `workspace`, and it catches `..` and
  // relative prefixes cloister has never emitted but could.
  const absolute = new RegExp(schema.$defs.AbsolutePath.pattern);
  const modes = schema.$defs.FsEntry.oneOf
    .find((b) => b.type === "object")?.properties.mode.enum;
  for (const entry of manifest.fs.allow) {
    const path = typeof entry === "string" ? entry : entry.path;
    assert.match(path, absolute, `fs.allow ${JSON.stringify(path)} violates §2 AbsolutePath`);
    if (typeof entry !== "string") {
      assert.ok(modes.includes(entry.mode), `mode ${JSON.stringify(entry.mode)} is not in the schema enum`);
    }
  }

  // No key cloister emits may be outside the schema's declared properties —
  // the additionalProperties:false half, which is how an invented dimension
  // (rather than an invented value) would show up.
  for (const key of Object.keys(manifest)) {
    assert.ok(key in schema.properties, `emitted key ${JSON.stringify(key)} is not in confinement/v1`);
  }
});

test("the schema-driven check is not vacuous — it rejects what it should", { skip: schemaMissing }, () => {
  // The check is only worth having if the old document would have failed it.
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const absolute = new RegExp(schema.$defs.AbsolutePath.pattern);
  assert.doesNotMatch("workspace", absolute, "the pre-bd6399 path must be refused by §2");
  assert.doesNotMatch("/run/../etc", absolute, "a traversing path must be refused");
  assert.match("/run/cloister/workspace/", absolute, "the shipped symbolic root must pass");
});
