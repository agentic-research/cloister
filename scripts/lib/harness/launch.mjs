// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness launch pipeline — the orchestration itself, as a library.
//
//     resolvePlan(request)  → LaunchPlan       every precondition checked
//     performSetup(plan)    → SetupArtifacts   mints, writes .dev.vars
//     launchSession(plan, artifacts) → HarnessSession
//
// ── Why this is a library and not a script ────────────────────────────────
//
// It used to be the top level of `scripts/harness-dev.mjs`: a sequence of
// statements reading process.argv and process.env, calling process.exit, and
// spawning children. `cloister run` therefore could not USE it — only re-launch
// it — so it serialized its already-parsed flags back into environment
// variables, spawned `node scripts/harness-dev.mjs`, and let that process parse
// the environment it had just constructed.
//
// That round-trip is where orchestration stops being first-party. Every value
// crossing it becomes a string with no type and no checker: `--repo a --repo b`
// became `HARNESS_WORKDIRS='["a","b"]'`, and the shape of the confinement — the
// security-relevant part — depended on a JSON blob surviving an env var. A
// typo in the variable NAME on either side is a silently unconfined run.
//
// So the orchestration lives here, both front doors call it in-process, and the
// environment is what an OPERATOR types (`SANDBOX=nono task harness:dev`),
// never a channel cloister talks to itself over.
//
// ── The ordering is carried by types, not by line numbers ─────────────────
//
// Minting is the security-relevant, non-retryable step. Every precondition it
// depends on is checked in resolvePlan, which is the ONLY producer of a
// LaunchPlan; performSetup requires one. So "checked before minting" is not a
// comment about statement order — there is no way to call the minting step
// without holding the proof that the checks ran. Same for launchSession, which
// requires the SetupArtifacts that only performSetup produces.
//
// Per cloister-eb27ae (mint-before-precondition) and cloister-eb33d4
// (--help minted a credential). Both were ordering bugs in a script.

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import {
  loadHarnessConfig,
  resolveTarget,
  serviceFor,
  credentialHeaders,
  UsageError,
} from "../../harness-targets.mjs";
import { LaunchUsageError, PreconditionError } from "./types.mjs";

/** @typedef {import("./types.mjs").LaunchDeps} LaunchDeps */

export { LaunchUsageError, PreconditionError };

const CLOISTER_BASE = "http://127.0.0.1:8787";
const DEFAULT_SHIM_PORT = "8799";

/**
 * The confinement/v1 manifest a harness identity commits to (§7, cloister-c80953).
 *
 * A STABLE profile declaration — never per-run paths — so the digest the minter
 * commits into the cert matches the one the runner recomputes over the SAME
 * manifest inlined in the policy. The nono CapabilityManifest is the kernel-plane
 * enforcement; this is its confinement/v1 shadow (the documented impedance: the
 * localhost vault-proxy egress maps to allowHosts ["127.0.0.1"], no listener →
 * port.bind 0). Both halves are one declaration.
 *
 * WHICH directories are confined is deliberately absent — that is why the digest
 * is identical whichever repo you pass, and why the absolute path can travel on
 * the nono plane only. HOW MANY is present, because two writable roots is a
 * materially wider boundary than one: a cert that did not distinguish them would
 * satisfy the §7 commitment check for a confinement it no longer describes.
 *
 * The one-root case emits exactly `workspace`, byte-identical to the manifest
 * that predates multi-root — so its digest is unchanged. Asserted in
 * scripts/test/confinement-shape.test.mjs, because "unchanged" is the kind of
 * claim that stops being true without anyone noticing.
 *
 * @param {number} rootCount
 * @param {string} service
 */
export function confinementManifest(rootCount, service) {
  if (!Number.isInteger(rootCount) || rootCount < 1) {
    throw new LaunchUsageError(`confinement needs at least one writable root, got ${rootCount}`);
  }
  return {
    version: "cloister/confinement/v1",
    fs: {
      allow: [
        ...Array.from({ length: rootCount }, (_, i) => ({
          path: i === 0 ? "workspace" : `workspace.${i}`,
          mode: "rw",
        })),
        { path: "state", mode: "rw" },
      ],
    },
    network: { allowHosts: ["127.0.0.1"] },
    port: { bind: 0 },
    credentialSource: `vault://${service}`,
  };
}

/**
 * True when `child` is at or below `parent` — a path relation, not a substring
 * one, so `/tmp/repo` does not "contain" the sibling `/tmp/repo-two`.
 * @param {string} parent @param {string} child
 */
function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Validate a set of writable roots, in the order given.
 *
 * Lives HERE, not at a door, because it is a property of the confinement rather
 * than of one command's argument syntax: the attested shape is built from the
 * COUNT of roots, so any door that can add a root can make the manifest claim a
 * boundary wider than the kernel enforces. Putting the check in `cloister run`
 * only would leave HARNESS_WORKDIRS='["/a","/a/b"]' accepted — the same defect,
 * reachable by the other door, with the CLI's tests still green.
 *
 * `label` supplies the caller's vocabulary so the message names what the person
 * actually typed (`--repo` or the env var), without a second implementation.
 *
 * @param {string[]} dirs Absolute, already resolved.
 * @param {string} label
 */
export function validateWorkdirSet(dirs, label) {
  if (!dirs.length) {
    throw new LaunchUsageError(`${label} is required: name the ONLY directory the harness may touch`);
  }
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      // DUPLICATE: two grants, one tree. The manifest would claim two writable
      // roots where there is one — a shape wider than the confinement.
      if (dirs[i] === dirs[j]) {
        throw new LaunchUsageError(
          `${label} ${dirs[i]} given twice. Two grants for one tree would make ` +
          `the attested shape claim more writable roots than the confinement has.`,
        );
      }
      // NESTED: the same thing in slower motion. The inner grant adds nothing
      // the outer one did not already give, and reads as if it narrowed something.
      const [outer, inner] = isWithin(dirs[i], dirs[j]) ? [dirs[i], dirs[j]]
        : isWithin(dirs[j], dirs[i]) ? [dirs[j], dirs[i]] : [null, null];
      if (outer) {
        throw new LaunchUsageError(
          `${label} ${inner} is inside ${label} ${outer}. The inner grant adds ` +
          `nothing — the outer one already covers it — but the attested shape ` +
          `would claim two independent roots. Drop one.`,
        );
      }
    }
  }
  return dirs;
}

/**
 * Resolve a LaunchRequest into a LaunchPlan, running every precondition.
 *
 * Throws before anything is minted or written. Holding the returned plan is the
 * proof that the preflight passed.
 *
 * @param {import("./types.mjs").LaunchRequest} request
 * @param {LaunchDeps} [deps]
 * @returns {Promise<import("./types.mjs").LaunchPlan>}
 */
export async function resolvePlan(request, deps = {}) {
  const run = deps.execFileSync ?? execFileSync;
  const exists = deps.exists ?? existsSync;
  const { root, setupOnly } = request;

  // --setup-only never reaches `task dev`, so it does not need .env.local.
  if (!setupOnly && !exists(resolve(root, ".env.local"))) {
    throw new PreconditionError(
      `.env.local is missing, and the launch step needs it.\n` +
      `  run: task dev:bootstrap\n` +
      `  (checked BEFORE minting, so nothing has been written and no cert exists yet)`,
      1,
    );
  }

  // Which harness. Declared in harness-targets.mjs; this file holds NO provider
  // literals (lint:harness-target-literals enforces it). Cross-checked against
  // cluster.toml's vaultProxyServices before anything is minted, so a
  // disagreement is a named error here rather than a provider 401 later.
  let target, service;
  try {
    const cfg = await loadHarnessConfig(resolve(root, "cluster.toml"));
    target = resolveTargetByName(cfg.targets, request.targetName);
    service = serviceFor(target, cfg.services);
  } catch (err) {
    if (err instanceof UsageError) throw new LaunchUsageError(err.message);
    throw err;
  }

  const auth = resolveAuth(target, request);

  let sandbox = null;
  if (request.sandbox) {
    sandbox = resolveSandbox(request.sandbox, target, root, { run, exists });
  }

  const shimPort = request.shimPort ?? DEFAULT_SHIM_PORT;
  return {
    root,
    target,
    service,
    auth,
    sandbox,
    shimPort,
    baseUrl: `http://127.0.0.1:${shimPort}/vault/proxy/${target.service}`,
    setupOnly,
    // Built from the plan and NOT yet written. The root count comes from the
    // SAME sandbox object the kernel grants are built from below, so a root
    // cannot be attested without being granted, or granted without being
    // attested — they are two projections of one list, not two lists.
    confinementManifest: confinementManifest(sandbox ? sandbox.workdirs.length : 1, target.service),
  };
}

/**
 * resolveTarget takes argv; this takes the already-parsed name. One vocabulary.
 * @param {any[]} targets @param {string|null} name
 */
function resolveTargetByName(targets, name) {
  return resolveTarget(targets, name ? ["--target", name] : []);
}

/**
 * AUDIT: no key to vault — forward the harness's OWN auth + receipt (ADR-0040
 * amendment). CUSTODY: vault the key + inject it.
 *
 * A target declares which modes it supports. Audit only makes sense where the
 * provider sells a subscription that vaulting a key would silently bypass, so
 * asking for it on a custody-only target is a named refusal — never a silent
 * downgrade that would move billing without saying so.
 *
 * The result is a tagged union, so "custody without a key" is not representable
 * past this function.
 *
 * @param {any} target
 * @param {import("./types.mjs").LaunchRequest} request
 * @returns {import("./types.mjs").AuthPlan}
 */
function resolveAuth(target, request) {
  const supportsAudit = target.authModes.includes("audit");
  if (request.wantsAudit && !supportsAudit) {
    throw new LaunchUsageError(
      `target ${JSON.stringify(target.name)} does not support --audit ` +
      `(declared modes: ${target.authModes.join(", ")}).`,
    );
  }
  const apiKey = request.credentialEnv?.[target.apiKeyEnv] || null;
  if (supportsAudit && (request.wantsAudit || !apiKey)) return { mode: "audit" };
  if (!apiKey) {
    const hint = supportsAudit
      ? `, or pass --audit to keep a subscription`
      : ` (this target is custody-only)`;
    throw new LaunchUsageError(
      `custody mode needs ${target.apiKeyEnv} (vaulted, never in the harness env)${hint}.`,
    );
  }
  return { mode: "custody", apiKey };
}

/**
 * Resolve confinement, building the binary if absent and resolving the harness
 * executable to an absolute path.
 *
 * @param {import("./types.mjs").SandboxRequest} requested
 * @param {any} target
 * @param {string} root
 * @param {{run: Function, exists: (p: string) => boolean}} io
 * @returns {import("./types.mjs").SandboxPlan}
 */
function resolveSandbox(requested, target, root, { run, exists }) {
  // The CONFINEMENT SHAPE is checked first, before the confine binary is built
  // and before the executable is resolved. Both of those are slower and neither
  // is the security boundary — and when the executable check ran first, a
  // nested-root request was reported as "could not resolve claude-code on
  // $PATH", which names the wrong problem and hides the real one behind a
  // 45-second cargo build.
  const workdirs = validateWorkdirSet(
    (requested.workdirs?.length ? requested.workdirs : [process.cwd()]).map((p) => resolve(p)),
    requested.label ?? "workdir",
  );

  const confineBin = resolve(root, "tools/harness-sandbox/target/release/cloister-harness");
  if (!exists(confineBin)) {
    try {
      run("cargo",
        ["build", "--release", "--manifest-path", resolve(root, "tools/harness-sandbox/Cargo.toml")],
        { stdio: "inherit" });
    } catch {
      throw new PreconditionError(
        "failed to build tools/harness-sandbox (needs the nono crate + rustc 1.95).", 2,
      );
    }
  }

  // The executable is a DECLARED absolute path — the same concept as a bundle's
  // `entryPoint`, and for the same reason: confined exec resolves by path with
  // no $PATH inside the sandbox. Falling back to a $PATH lookup is a convenience
  // for the unconfined case only, and its failure is a named error pointing at
  // the declaration — the silent version is where `claude: command not found`
  // came from.
  // Four rungs, each narrower than the last (ADR-0060):
  //   harnessBin  explicit per-invocation override
  //   entryPoint  absolute path, pinned deployment — WHERE
  //   executable  the binary's name when it differs from the selector — WHAT
  //   name        the default, correct wherever selector and binary coincide
  //
  // The third rung exists because `name` was doing both jobs: the product is
  // `claude-code`, the binary is `claude`, so the fallback looked for a binary
  // that has never existed and the verb failed on a stock install.
  const cmd = requested.harnessBin || target.entryPoint || target.executable || target.name;
  let harnessBin = cmd;
  if (!cmd.includes("/")) {
    try {
      harnessBin = run("which", [cmd], { encoding: "utf8" }).trim();
    } catch {
      throw new PreconditionError(
        `could not resolve ${JSON.stringify(cmd)} on $PATH. Declare an absolute ` +
        `\`entryPoint\` on the ${JSON.stringify(target.name)} [[gateway.harnessTargets]] ` +
        `row in cluster.toml (required under confinement).`, 2,
      );
    }
  }

  const home = homedir();
  return {
    provider: "nono",
    confineBin,
    workdirs,
    stateDir: requested.stateDir ?? join(home, target.stateDir),
    harnessBin,
    harnessArgs: requested.harnessArgs ?? [],
  };
}

/**
 * Mint the dev identity and write .dev.vars + the confinement manifest.
 *
 * Requires a LaunchPlan, which only resolvePlan produces — so this cannot run
 * before the preconditions were checked.
 *
 * @param {import("./types.mjs").LaunchPlan} plan
 * @param {LaunchDeps} [deps]
 * @returns {import("./types.mjs").SetupArtifacts}
 */
export function performSetup(plan, deps = {}) {
  const run = deps.execFileSync ?? execFileSync;
  const write = deps.writeFileSync ?? writeFileSync;
  const log = deps.errLog ?? ((/** @type {string} */ m) => process.stderr.write(`${m}\n`));

  const confinementManifestPath = resolve(plan.root, ".harness-confinement.json");
  write(confinementManifestPath, JSON.stringify(plan.confinementManifest, null, 2));

  // CLOISTER_CONFINEMENT_MANIFEST points the minter at the manifest so the cert
  // commits its §6/BLAKE3 digest (Interlace extension OID .1.7) — the anchor the
  // runner's §7 check verifies against.
  log("harness:dev — minting a fresh ephemeral dev master + cert…");
  const identity = JSON.parse(
    run("cargo", ["run", "-q", "-p", "cloister-cas", "--example", "mint-dev-cert"], {
      cwd: resolve(plan.root, "rs"),
      encoding: "utf8",
      env: { ...process.env, CLOISTER_CONFINEMENT_MANIFEST: confinementManifestPath },
    }),
  );

  // .dev.vars — wrangler dev binds these into the Worker env. Common seams (dev
  // CA master + gate + authz overlay) apply to both modes; the credential path
  // differs.
  const common = [
    `CLOISTER_MODE = "dev"`,
    `DEV_CA_MASTER = ${JSON.stringify(identity.masterPubB64Std)}`,
    `DEV_CA_EPOCH = ${JSON.stringify(String(identity.epoch))}`,
    // Plain value (the comma-list form applyDevAllowedSubs accepts), NOT a JSON
    // array — .dev.vars dotenv parsing mangles escaped quotes inside `"[\"…\"]"`,
    // which silently breaks the allowedSubs overlay → manifest_deny. Found live.
    `DEV_ALLOWED_SUBS = ${JSON.stringify(identity.peerFp)}`,
  ];
  const service = plan.target.service;
  const modeVars = plan.auth.mode === "audit"
    // Audit: force the service to passthrough — no seed, no vaulted key.
    ? [`DEV_PASSTHROUGH_SERVICES = ${JSON.stringify(service)}`]
    // Custody: seed the vaulted key for injection.
    : [`DEV_VAULT_SEED = ${JSON.stringify(JSON.stringify({
        peerFp: identity.peerFp,
        service,
        upstream: plan.service.upstreamBaseUrl,
        headers: credentialHeaders(plan.service, plan.auth.apiKey),
        allowedSubs: [identity.peerFp],
      }))}`];
  const devVarsPath = resolve(plan.root, ".dev.vars");
  write(devVarsPath, `${[...common, ...modeVars].join("\n")}\n`);
  log(`harness:dev — wrote .dev.vars (peerFp ${identity.peerFp}, service ${service}, ` +
      `${plan.auth.mode === "audit" ? "passthrough" : "vaulted"}).`);

  // ephemeralPaths is DATA, and teardown removes exactly this list. The
  // alternative — a hand-mirrored `rm` list at the bottom of the file — is how a
  // fourth written file gets left behind: nothing fails, the tree just keeps a
  // dev credential nobody meant to persist. The policy file is appended by
  // launchSession, which is the step that writes it.
  return {
    identity,
    devVarsPath,
    confinementManifestPath,
    ephemeralPaths: [devVarsPath, confinementManifestPath],
  };
}

/**
 * The nono policy, built from the plan. Pure — writing it is the caller's job.
 * @param {import("./types.mjs").LaunchPlan} plan
 * @param {import("./types.mjs").DevIdentity} identity
 */
export function buildPolicy(plan, identity) {
  const { target } = plan;
  const sandbox = plan.sandbox;
  if (!sandbox) throw new LaunchUsageError("buildPolicy needs a resolved sandbox");
  const home = homedir();
  // nono's macOS system defaults — replicated from `nono run -v` (the
  // system_read_macos / system_write_macos / user_tools / homebrew groups the
  // CLI seeds but the library apply() does not). Read-only unless noted; lets
  // binaries + dylibs + the harness itself load.
  const sysRead = [
    "/bin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/lib", "/usr/local/lib",
    "/usr/share", "/System/Library", "/Library", "/Library/Frameworks",
    "/private/var/db", "/private/etc", "/private/var", "/private",
    "/System/Volumes", "/System/Cryptexes", "/opt", "/opt/homebrew",
    join(home, ".local/bin"), join(home, ".local/share"),
  ];
  // /tmp is a symlink to /private/tmp on macOS; grant both so a harness that
  // writes to the literal /tmp path (claude's runtime dir) isn't denied.
  const sysRw = ["/dev", "/tmp", "/private/tmp", "/private/var/folders"];
  return {
    capabilities: {
      version: "0.1.0",
      filesystem: {
        grants: [
          ...sysRead.map((/** @type {string} */ path) => ({ path, access: "read", type: "directory" })),
          ...sysRw.map((/** @type {string} */ path) => ({ path, access: "readwrite", type: "directory" })),
          // One kernel grant per declared root — the enforcement half of the
          // `workspace` / `workspace.N` entries in the confinement manifest.
          // Same list, so the two cannot disagree.
          ...sandbox.workdirs.map((/** @type {string} */ path) => ({ path, access: "readwrite", type: "directory" })),
          { path: sandbox.stateDir, access: "readwrite", type: "directory" },
        ],
        // Belt-and-suspenders: the allow-list already excludes these, but deny
        // takes precedence on Seatbelt, so name the credential dirs.
        deny: [
          { path: join(home, ".ssh") },
          { path: join(home, ".aws") },
          { path: join(home, ".config/gcloud") },
        ],
      },
      // DEFAULT-DENY network: blocked, with the single vault-proxy localhost
      // port as the only egress. cloister-harness refuses any non-blocked mode.
      network: { mode: "blocked", ports: { localhost: [Number(plan.shimPort)] } },
    },
    // §7 confinement commitment (cloister-c80953): the runner verifies, BEFORE
    // Sandbox::apply, that this manifest matches the digest committed in dev's
    // identity cert — fail-closed on drift. Same manifest the minter digested.
    confinement: {
      manifest: plan.confinementManifest,
      cert_der_b64url: identity.certDerB64Url,
      master_pub_b64std: identity.masterPubB64Std,
    },
    // Credentials never enter the confined env — cloister injects at the proxy.
    env_strip: target.stripEnv,
    env_set: { [target.baseUrlEnv]: plan.baseUrl },
    harness_bin: sandbox.harnessBin,
    harness_args: sandbox.harnessArgs,
  };
}

/**
 * Launch cloister + the shim, then either exec the confined harness or print the
 * export line. Requires the SetupArtifacts that only performSetup produces.
 *
 * @param {import("./types.mjs").LaunchPlan} plan
 * @param {import("./types.mjs").SetupArtifacts} artifacts
 * @param {LaunchDeps} [deps]
 * @returns {Promise<import("./types.mjs").HarnessSession>}
 */
export async function launchSession(plan, artifacts, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const write = deps.writeFileSync ?? writeFileSync;
  const rm = deps.rmSync ?? rmSync;
  const log = deps.errLog ?? ((/** @type {string} */ m) => process.stderr.write(`${m}\n`));
  const waitHealth = deps.waitForHealth ?? waitForHealth;
  const waitPort = deps.waitForPort ?? waitForPort;
  const { identity } = artifacts;
  const ephemeral = [...artifacts.ephemeralPaths];

  const cloister = spawn("task", ["dev"], { cwd: plan.root, stdio: "inherit" });
  await waitHealth(`${CLOISTER_BASE}/health`, 60_000);

  const shim = spawn(process.execPath, ["--import", "tsx", "tools/harness-shim/index.ts"], {
    cwd: plan.root,
    stdio: "inherit",
    env: {
      ...process.env,
      HARNESS_SHIM_PORT: plan.shimPort,
      CLOISTER_BASE_URL: CLOISTER_BASE,
      HARNESS_SHIM_CERT_B64: identity.certDerB64Url,
      HARNESS_SHIM_PRIV_SEED_B64: identity.ephemeralPrivSeedB64Url,
      HARNESS_SHIM_PUBKEY_B64: identity.ephemeralPubB64Url,
      // Audit preserves the harness's own Authorization (OAuth) through to
      // cloister's passthrough proxy; custody strips it (cloister injects).
      ...(plan.auth.mode === "audit" ? { HARNESS_SHIM_PRESERVE_AUTH: "1" } : {}),
    },
  });

  const bar = "─".repeat(64);
  let confined = null;
  if (plan.sandbox) {
    const policyPath = resolve(plan.root, ".harness-policy.json");
    write(policyPath, JSON.stringify(buildPolicy(plan, identity), null, 2));
    // Appended where it is WRITTEN, so cleanup cannot fall behind what exists.
    ephemeral.push(policyPath);

    log(`\n${bar}\nharness:dev — SANDBOX=nono: launching ${plan.sandbox.harnessBin} kernel-confined (cloister-harness).`);
    log(`  policy: ${policyPath} (declared nono manifest, default-deny)`);
    log(`  rw: ${[...plan.sandbox.workdirs, plan.sandbox.stateDir].join(", ")}`);
    log(`  network: blocked, localhost :${plan.shimPort} only → ${plan.baseUrl}\n${bar}\n`);
    // Wait for the shim to bind before launching the confined harness —
    // otherwise the harness's first request races startup (connect-refused).
    await waitPort(plan.baseUrl, 15_000);
    confined = spawn(plan.sandbox.confineBin, [policyPath], {
      // The FIRST declared root is the primary: it is what a relative path
      // inside the harness resolves against.
      cwd: plan.sandbox.workdirs[0], stdio: "inherit",
    });
  } else {
    const t = plan.target;
    log(`\n${bar}\nharness:dev — ready. In your harness shell:\n`);
    log(`  export ${t.baseUrlEnv}="${plan.baseUrl}"`);
    if (plan.auth.mode === "audit") {
      log(`  # DO NOT set ${t.stripEnv.join(" / ")} — either leaves your`);
      log(`  # Max subscription. Base-URL only keeps the subscription; cloister receipts`);
      log(`  # each call (audit, not custody — there's no key to vault).`);
    } else {
      log(`  # no ${t.apiKeyEnv} on the harness — the key is vaulted in cloister.`);
    }
    log(`  ${t.entryPoint || t.name}`);
    log(`  # (or: SANDBOX=nono task harness:dev to launch it kernel-confined)`);
    log(`${bar}\n`);
  }

  // shutdown() is idempotent because a signal handler and a natural child exit
  // both reach it, and the second caller must not double-kill or double-resolve.
  let ended = false;
  /** @type {(end: import("./types.mjs").SessionEnd) => void} */
  let settle = () => {};
  /** @type {Promise<import("./types.mjs").SessionEnd>} */
  const done = new Promise((res) => { settle = res; });

  /** @type {(end?: import("./types.mjs").SessionEnd) => Promise<void>} */
  const shutdown = async (end = { code: 0, signal: null }) => {
    if (ended) return;
    ended = true;
    confined?.kill();
    shim?.kill();
    cloister?.kill();
    // Removes exactly what was written — ephemeral is accumulated at each write
    // site, not restated here. A hand-mirrored list is how a fourth written file
    // gets left behind: nothing fails, the tree just keeps a dev credential.
    for (const path of ephemeral) {
      try { rm(path, { force: true }); } catch { /* lint-allow-silent: best-effort cleanup on exit */ }
    }
    settle(end);
  };

  for (const child of [cloister, shim, confined]) {
    child?.on("exit", () => { void shutdown({ code: 0, signal: null }); });
  }

  return { done, shutdown, confined, ephemeralPaths: ephemeral };
}

/**
 * @param {string} url @param {number} timeoutMs
 */
async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* lint-allow-silent: cloister not up yet — the timeout is the report */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`cloister did not become healthy at ${url} within ${timeoutMs}ms`);
}

/**
 * The shim is up once a request connects — any HTTP response (even 404) means it
 * is bound; only a connect error (fetch throws) means not-yet-listening.
 * @param {string} url @param {number} timeoutMs
 */
async function waitForPort(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch { /* lint-allow-silent: shim not bound yet — the timeout is the report */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`harness shim did not bind at ${url} within ${timeoutMs}ms`);
}

/**
 * Audit mode + confinement + a Keychain-backed credential = a harness that
 * launches fine and then reports "Not logged in", with nothing saying why.
 *
 * Measured, not assumed (cloister-72f540): a confined process cannot read a
 * Keychain item, and granting the keychain FILE does not change that, because
 * Keychain is mediated by securityd over mach/XPC rather than by reading the
 * file. nono has no mach/XPC grant to reach for, and `deny_keychains_macos` is
 * in its DEFAULT profile — every agent profile it ships inherits it. So this is
 * the platform's granularity, not a missing flag.
 *
 * That matches the licensing side independently: an Anthropic seat token is
 * harness-bound by policy as much as by mechanism, so cloister relaying it is
 * the disallowed shape even where it would work.
 *
 * WARN rather than refuse. On a setup whose credential lives in a FILE under
 * the harness's state dir, audit mode works fine — that directory is granted
 * rw. Failing closed would break a working configuration to prevent a confusing
 * message, which is the wrong trade. The operator gets the explanation and the
 * alternative, and keeps the decision.
 *
 * @param {import("./types.mjs").LaunchPlan} plan
 * @param {(message: string) => void} log
 * @param {LaunchDeps} [deps]
 */
function warnIfAuditIsUnauthenticated(plan, log, deps = {}) {
  if (plan.auth.mode !== "audit" || !plan.sandbox) return;
  const exists = deps.exists ?? existsSync;
  // Existence only — never read. Whether a credential FILE is present is what
  // decides if this warning applies; its contents are none of cloister's
  // business, and in audit mode the whole point is that cloister never holds
  // the credential.
  if (exists(join(plan.sandbox.stateDir, ".credentials.json"))) return;

  log(
    `harness:dev — NOTE: audit mode under confinement may be unauthenticated.\n` +
    `  No credential file in ${plan.sandbox.stateDir}, so ${plan.target.name} likely\n` +
    `  authenticates from the system keychain — which the sandbox denies by design\n` +
    `  (nono's default profile carries deny_keychains_macos; there is no per-item\n` +
    `  grant). The harness may report "Not logged in".\n` +
    `  To run authenticated: set ${plan.target.apiKeyEnv} and use the custody lane —\n` +
    `  the key is vaulted and injected at the proxy, never entering the harness env.`,
  );
}

/**
 * The whole pipeline, for a caller that wants the default wiring.
 *
 * Both front doors call THIS. `cloister run` does it in-process; `task
 * harness:dev` does it through the bin. One orchestration, two doors.
 *
 * @param {import("./types.mjs").LaunchRequest} request
 * @param {LaunchDeps} [deps]
 */
export async function launch(request, deps = {}) {
  const plan = await resolvePlan(request, deps);
  const log = deps.errLog ?? ((/** @type {string} */ m) => process.stderr.write(`${m}\n`));
  log(`harness:dev — target ${plan.target.name} · ` +
      (plan.auth.mode === "audit"
        ? "AUDIT mode (forward harness auth + receipt; no key vaulted)"
        : "CUSTODY mode (API key vaulted + injected)"));
  warnIfAuditIsUnauthenticated(plan, log, deps);

  const artifacts = performSetup(plan, deps);
  if (plan.setupOnly) {
    // The confinement manifest is an INPUT to minting — the minter digests it
    // into the cert — so once the cert exists it has done its job. Without this
    // the setup-only path left `.harness-confinement.json` in the tree, which
    // the launch path removes on shutdown and this path never reached. Found by
    // running it: an untracked file appeared in `git status`.
    //
    // .dev.vars is deliberately NOT removed: producing it is what --setup-only
    // is FOR.
    const rm = deps.rmSync ?? rmSync;
    for (const path of artifacts.ephemeralPaths.filter((p) => p !== artifacts.devVarsPath)) {
      try { rm(path, { force: true }); } catch { /* lint-allow-silent: best-effort cleanup */ }
    }
    log("harness:dev — --setup-only: skipping launch. .dev.vars is ready.");
    return { plan, artifacts, session: null };
  }
  const session = await launchSession(plan, artifacts, deps);
  return { plan, artifacts, session };
}
