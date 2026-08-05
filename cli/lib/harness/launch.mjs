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
import {
  writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync, realpathSync,
  lstatSync, mkdirSync, accessSync, constants,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { parse as parseToml } from "smol-toml";

import { startLocalRouter } from "../dev/router.mjs";
import { resolveInstallLayout } from "../install-layout.mjs";
import {
  readProviderRecord,
  resolveProviderArtifact,
  RuntimeProviderError,
} from "../runtime/provider-record.mjs";

import {
  loadHarnessConfig,
  resolveTarget,
  serviceFor,
  credentialHeaders,
  UsageError,
} from "./targets.mjs";
import { LaunchUsageError, PreconditionError } from "./types.mjs";
import { systemGrants } from "./system-grants.mjs";

/** @typedef {import("./types.mjs").LaunchDeps} LaunchDeps */

export { LaunchUsageError, PreconditionError };

const CLOISTER_BASE = "http://127.0.0.1:8787";
const DEFAULT_SHIM_PORT = "8799";
// Companion Workers start here, above cloister's 8787 and the shim's 8799.
// wrangler dev defaults to 8787 for EVERY worker, so an unported companion
// takes cloister's port and the run dies on `Address already in use`.
const COMPANION_PORT_BASE = 8810;

/**
 * The confinement/v1 manifest a harness identity commits to (§8, cloister-c80953).
 *
 * A STABLE profile declaration — never per-run paths — so the digest the minter
 * commits into the cert matches the one the runner recomputes over the SAME
 * manifest inlined in the policy. The nono CapabilityManifest is the kernel-plane
 * enforcement; this is its confinement/v1 shadow (the documented impedance: the
 * localhost vault-proxy egress maps to allowHosts ["127.0.0.1"], no listener →
 * port.bind 0). Both halves are one declaration.
 *
 * NO `credentialSource`, and its absence is the accurate statement (cloister-d2ba07).
 * §5 is "the URL of the vault backend the bundle authenticates against", over a
 * closed set of `nono::keystore` schemes — and a harness authenticates against no
 * keystore. Custody mode vaults the key and the shim injects it as a header
 * (`credentialHeaders` below); the harness never holds it. That is the whole point
 * of ADR-0010/0013, so declaring a credentialSource would claim a binding the
 * process does not have. §5: "A bundle needing no credentials omits the field."
 *
 * This used to emit `vault://<service>`, which is not one of the six schemes §5
 * closes over — so every document cloister issued was refused at parse by a
 * conforming runner, verified against LLO b9b800c. The digest conformance test
 * could not see it: it agrees with LLO on LLO's canonical vector and never reads
 * a manifest this builder produced. Inv 11 now checks §5 for the operator-declared
 * facet; this docstring is the check for the one field that is absent.
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
 * Takes no `service`, and that is the point: the boundary is identical for every
 * harness target, so "all targets are confined identically" is now true by
 * construction rather than asserted by a test. The old signature took one only
 * to interpolate it into the credentialSource above, which made per-target
 * digests differ for a reason nothing read — the shim routes to a vault slice by
 * URL path and the vault authorizes by `allowedSubs`, neither of which consults
 * the confinement digest. Dropping it removes a distinction, not an enforcement.
 *
 * @param {number} rootCount
 */
export function confinementManifest(rootCount) {
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
 * Canonical digest of a skill directory: a sorted walk of relative paths, each
 * path's bytes folded in after the path itself.
 *
 * Sorted so the digest does not depend on readdir order, and the PATH is folded
 * in alongside the bytes so renaming a file changes the digest — hashing
 * contents alone would let `evil.sh` be renamed to `setup.sh` invisibly.
 *
 * @param {string} dir
 * @param {{readdirSync?: Function, readFileSync?: Function, statSync?: Function}} [io]
 */
export function digestSkillDir(dir, io = {}) {
  const rd = io.readdirSync ?? readdirSync;
  const rf = io.readFileSync ?? readFileSync;
  const st = io.statSync ?? statSync;
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ rel) => {
    for (const entry of rd(join(dir, rel))) {
      const r = rel ? `${rel}/${entry}` : entry;
      if (st(join(dir, r)).isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk("");
  const h = createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel);
    h.update("\0");
    h.update(rf(join(dir, rel)));
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * Resolve the relocated skills store and the per-run scratch directory.
 *
 * Both implement "relocate, don't narrow" (see buildPolicy). Neither MOVES an
 * operator's files: the skills store is adopted only when `<stateDir>/skills`
 * is ALREADY a symlink, and reported-but-not-changed otherwise.
 *
 * That restraint is deliberate. Silently relocating someone's skills directory
 * — during a command whose job is to launch a harness — is the kind of helpful
 * action that is indistinguishable from data loss when it goes wrong, and the
 * operator has no reason to expect it. `cloister skills relocate` is where that
 * belongs, as an act someone chooses.
 *
 * @param {string} stateDir
 * @param {string} root
 * @param {LaunchDeps & {realpathSync?: Function, lstatSync?: Function}} [deps]
 * @returns {{skillStore: string|null, scratchDir: string, adopted: boolean}}
 */
export function resolveRelocations(stateDir, root, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const lstat = deps.lstatSync ?? lstatSync;
  const real = deps.realpathSync ?? realpathSync;

  const skillsPath = join(stateDir, "skills");
  let skillStore = null;
  let adopted = false;
  if (exists(skillsPath)) {
    try {
      if (lstat(skillsPath).isSymbolicLink()) {
        // Already relocated — grant the TARGET read, and the subtree is
        // immutable because the symlink resolves to that grant.
        skillStore = real(skillsPath);
        adopted = true;
      }
    } catch { /* lint-allow-silent: an unreadable skills path is reported by verifySkills, not here */ }
  }

  // Per-run scratch. Under the repo root so it is visible, gitignored, and
  // removed by teardown alongside the other runtime-only files.
  const scratchDir = join(root, ".harness-scratch");
  return { skillStore, scratchDir, adopted };
}

/**
 * Verify every DECLARED skill before anything is minted (ADR-0061).
 *
 * Confinement already bounds how much damage a skill can do — proven three
 * levels deep, across a language boundary. This answers the different question
 * of WHICH skills ran, which is the one an operator has to answer to a
 * colleague.
 *
 * Three outcomes, all of them loud:
 *
 *   pinned + matching    verified, named in the receipt
 *   pinned + mismatched  the run REFUSES — content changed under a pin
 *   declared, no digest  admitted UNPINNED, and says so every run with the
 *                        digest to paste, so pinning is one copy away
 *
 * An undeclared directory is reported, not honoured silently: the operator
 * should know their harness can see content the manifest never admitted.
 *
 * NOT continuous. The skills directory stays writable because nono's grants are
 * a union rather than an intersection — a narrower read grant does not
 * constrain a broader rw parent (measured; ADR-0061). A skill substituted
 * mid-run is caught on the NEXT run, not blocked in this one, and the receipt
 * says "verified at load" rather than implying more.
 *
 * @param {any} plan
 * @param {(m: string) => void} log
 * @param {LaunchDeps & {readdirSync?: Function, readFileSync?: Function, statSync?: Function}} [deps]
 * @returns {{name: string, digest: string, pinned: boolean}[]}
 */
export function verifySkills(plan, log, deps = {}) {
  const declared = plan.skills ?? [];
  const exists = deps.exists ?? existsSync;
  const rd = deps.readdirSync ?? readdirSync;
  const skillsDir = join(plan.sandbox?.stateDir ?? "", "skills");

  if (declared.length === 0 && !exists(skillsDir)) return [];
  void exists;

  // Listing is best-effort; DECLARED skills are not. If the directory cannot be
  // read — absent, or an injected `exists` that disagrees with the real fs —
  // `present` is empty and every declared skill then fails its own
  // "declared but absent" check below, loudly and by name. So an unreadable
  // directory degrades to a precise refusal rather than a stack trace, without
  // weakening anything: nothing is treated as verified that was not read.
  let present = [];
  try {
    present = rd(skillsDir).filter((/** @type {string} */ n) => {
      try { return (deps.statSync ?? statSync)(join(skillsDir, n)).isDirectory(); } catch { return false; }
    });
  } catch { /* lint-allow-silent: absent or unreadable ⇒ nothing present; declared skills still refuse below */ }

  const verified = [];
  for (const decl of declared) {
    if (!present.includes(decl.name)) {
      throw new PreconditionError(
        `skill ${JSON.stringify(decl.name)} is declared in cluster.toml but absent from ` +
        `${skillsDir}. A declared skill that is not there means the run would not be the ` +
        `one the manifest describes (ADR-0061).`, 1,
      );
    }
    const actual = digestSkillDir(join(skillsDir, decl.name), deps);
    if (!decl.digest) {
      log(`cloister — skill ${decl.name}: UNPINNED. Pin it with  digest = "${actual}"`);
      verified.push({ name: decl.name, digest: actual, pinned: false });
      continue;
    }
    if (actual !== decl.digest) {
      throw new PreconditionError(
        `skill ${JSON.stringify(decl.name)} does not match its pin.\n` +
        `  declared: ${decl.digest}\n` +
        `  actual:   ${actual}\n` +
        `Its contents changed under a pin. Re-pin deliberately if that was you ` +
        `(ADR-0061); refusing the run rather than loading unreviewed content.`, 1,
      );
    }
    verified.push({ name: decl.name, digest: actual, pinned: true });
  }

  const undeclared = present.filter((/** @type {string} */ n) => !declared.some((/** @type {{name:string}} */ d) => d.name === n));
  // ── the receipt ─────────────────────────────────────────────────────────
  //
  // The FULL picture goes to a file; stdout gets one line. A real machine has
  // dozens of skills, and a wall of names on every run is how a true warning
  // becomes scrollback — the operator stops reading it, which costs more than
  // not printing it. The count is the signal, the receipt is the detail.
  //
  // This is also what ADR-0043 promised and had not delivered: a LOAD-EVENT
  // RECEIPT, so which skills were present is answerable after the fact rather
  // than only at the moment it scrolled past.
  const receipt = {
    version: "cloister/skill-load/v1",
    skillsDir,
    // "at load" is stated in the artifact itself, because the artifact will
    // outlive the conversation where the distinction was explained.
    verifiedAt: "load",
    note: "Verification is at load, not continuous: the skills directory stays " +
          "writable (nono grants are a union, not an intersection), so a skill " +
          "substituted mid-run is caught on the NEXT run. See ADR-0061.",
    verified,
    undeclared,
  };
  const receiptPath = join(plan.root ?? ".", ".harness-skills.json");
  try {
    (deps.writeFileSync ?? writeFileSync)(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch { /* lint-allow-silent: the summary line below is the report; a receipt we could not write must not fail a run that is otherwise fine */ }

  const pinned = verified.filter((v) => v.pinned).length;
  const parts = [];
  if (verified.length) parts.push(`${verified.length} declared (${pinned} pinned)`);
  if (undeclared.length) parts.push(`${undeclared.length} UNDECLARED`);
  if (parts.length) log(`cloister — skills: ${parts.join(", ")} · ${receiptPath}`);
  return verified;
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
  const readHarnessConfig = deps.loadHarnessConfig ?? loadHarnessConfig;
  const { root, setupOnly } = request;

  // --setup-only never starts the local router, so it does not need .env.local.
  if (!setupOnly && !exists(resolve(root, ".env.local"))) {
    throw new PreconditionError(
      `.env.local is missing, and the launch step needs it.\n` +
      `  run: cloister dev bootstrap\n` +
      `  (checked BEFORE minting, so nothing has been written and no cert exists yet)`,
      1,
    );
  }

  // Which harness. Declared in harness-targets.mjs; this file holds NO provider
  // literals (lint:harness-target-literals enforces it). Cross-checked against
  // cluster.toml's vaultProxyServices before anything is minted, so a
  // disagreement is a named error here rather than a provider 401 later.
  let target, service, skills = [];
  try {
    const cfg = await readHarnessConfig(resolve(root, "cluster.toml"));
    target = resolveTargetByName(cfg.targets, request.targetName);
    service = serviceFor(target, cfg.services);
    skills = cfg.skills ?? [];
  } catch (err) {
    if (err instanceof UsageError) throw new LaunchUsageError(err.message);
    throw err;
  }

  const auth = resolveAuth(target, request);

  let sandbox = null;
  if (request.sandbox) {
    sandbox = resolveSandbox(request.sandbox, target, root, {
      run,
      exists,
      env: deps.env ?? process.env,
      resolveNativeHelper: deps.resolveNativeHelper ?? resolveNativeHelper,
    });
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
    // Declared skills, carried so verifySkills can run against the resolved
    // plan — BEFORE performSetup mints anything (ADR-0061).
    skills,
    // Built from the plan and NOT yet written. The root count comes from the
    // SAME sandbox object the kernel grants are built from below, so a root
    // cannot be attested without being granted, or granted without being
    // attested — they are two projections of one list, not two lists.
    confinementManifest: confinementManifest(sandbox ? sandbox.workdirs.length : 1),
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
 * Resolve the digest-verified installed confinement helper and the harness
 * executable to an absolute path.
 *
 * @param {import("./types.mjs").SandboxRequest} requested
 * @param {any} target
 * @param {string} root
 * @param {{run: Function, exists: (p: string) => boolean,
 *          env: Record<string,string|undefined>, resolveNativeHelper: Function}} io
 * @returns {import("./types.mjs").SandboxPlan}
 */
function resolveSandbox(requested, target, root, { run, exists, env, resolveNativeHelper }) {
  // The CONFINEMENT SHAPE is checked first, before the installed helper is read
  // and before the executable is resolved. Both of those are slower and neither
  // is the security boundary — and when the executable check ran first, a
  // nested-root request was reported as "could not resolve claude-code on
  // $PATH", which names the wrong problem and hides the real one behind a
  // a runtime-provider lookup.
  const workdirs = validateWorkdirSet(
    (requested.workdirs?.length ? requested.workdirs : [process.cwd()]).map((p) => resolve(p)),
    requested.label ?? "workdir",
  );

  const confineBin = resolveNativeHelper({ root, env });

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
  const stateDir = requested.stateDir ?? join(home, target.stateDir);
  // "Relocate, don't narrow" — see buildPolicy. Adopts an existing symlink;
  // never moves an operator's files.
  const { skillStore, scratchDir } = resolveRelocations(stateDir, root, { exists });
  try { mkdirSync(scratchDir, { recursive: true }); }
  catch { /* lint-allow-silent: an unwritable root fails louder at the first write */ }

  // Derived, not declared: the install tree is wherever the resolved executable
  // actually lives, which a manifest field would only restate and then rot.
  // `~/.local/bin/claude` is a shim, so follow it to the real binary and grant
  // its versioned root.
  let installDir = null;
  try {
    const real = realpathSync(harnessBin);
    const versions = real.indexOf("/versions/");
    installDir = versions > 0 ? real.slice(0, versions) : dirname(real);
  } catch { /* lint-allow-silent: an unresolvable path is already a PreconditionError above */ }

  return {
    provider: "nono",
    confineBin,
    workdirs,
    installDir,
    skillStore,
    scratchDir,
    // `<stateDir>.json` — the sibling config file. Same derivation the harness
    // itself uses, so a target that renames its state dir keeps them paired.
    configFile: `${requested.stateDir ?? join(home, target.stateDir)}.json`,
    stateDir,
    harnessBin,
    harnessArgs: requested.harnessArgs ?? [],
  };
}

/** @param {string} file @param {Function} [access] */
function executable(file, access = accessSync) {
  try {
    access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve only the installed provider or an explicit operator override. */
/**
 * @param {{root?:string, env?:Record<string,string|undefined>, access?:Function}} [options]
 */
export function resolveNativeHelper({ root, env = process.env, access = accessSync } = {}) {
  const override = env.CLOISTER_HARNESS_BIN;
  if (override) {
    if (!executable(override, access)) {
      throw new PreconditionError(
        `CLOISTER_HARNESS_BIN is not executable: ${override}\n` +
        "No fallback was used because an explicit override must fail closed.",
        2,
      );
    }
    return override;
  }

  try {
    const layout = resolveInstallLayout({ env, checkoutRoot: root ?? process.cwd() });
    const record = readProviderRecord(layout);
    const helper = resolveProviderArtifact(record, "nativeHelper");
    if (!executable(helper, access)) {
      throw new RuntimeProviderError(`installed native helper is not executable: ${helper}`);
    }
    return helper;
  } catch (error) {
    if (!(error instanceof RuntimeProviderError)) throw error;
    throw new PreconditionError(
      "The execution runtime is not installed or failed its digest check.\n" +
      "Run: cloister runtime install",
      2,
    );
  }
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
  log("cloister — minting a fresh ephemeral dev master + cert…");
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
  log(`cloister — wrote .dev.vars (peerFp ${identity.peerFp}, service ${service}, ` +
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
  const {
    readDirectories: sysRead,
    readWriteDirectories: sysRw,
    readFiles: sysReadFiles,
  } = systemGrants({ home });
  // /tmp is a symlink to /private/tmp on macOS; grant both so a harness that
  // writes to the literal /tmp path (claude's runtime dir) isn't denied.
  // ── relocate, don't narrow ────────────────────────────────────────────
  //
  // Two shared writable paths were reachable by anything the harness runs, and
  // NEITHER is fixable by narrowing a grant: nono's grants are a UNION, so a
  // read-only grant does not constrain a writable parent, and `deny` is a full
  // deny rather than a write-deny. Measured, both times.
  //
  // What DOES work is changing where the bytes live:
  //
  //   SKILLS   ~/.claude/skills is inside a state dir that must stay writable
  //            (sessions, history, settings — 23 top-level files, and the set
  //            grows). Symlinking it to a store granted READ makes the subtree
  //            immutable while the state dir stays writable, because the
  //            symlink resolves to the target's grant. So a skill can no longer
  //            write a peer skill mid-run — the gap ADR-0061 explicitly did not
  //            close.
  //
  //   SCRATCH  /tmp was granted readwrite, so two confined runs shared it: a
  //            channel between runs that neither declared. A per-run directory
  //            with TMPDIR redirected gives each run private scratch, and /tmp
  //            stops being granted at all.
  //
  // Note the second only works through THIS path. The `nono` CLI seeds /tmp in
  // its own defaults, so the same policy under `nono run` still leaks — the
  // library does not seed them, which is why buildPolicy lists them by hand and
  // can decline to.
  //
  // `sysRw` no longer carries /tmp. /private/var/folders stays: macOS puts the
  // per-user temp there and confstr-based mktemp reaches it regardless of
  // TMPDIR, so denying it breaks tools rather than isolating them.
  // The harness's own per-uid runtime directory under /tmp.
  //
  // Claude Code creates `/tmp/claude-<uid>` regardless of TMPDIR — it is a
  // fixed path, not a temp-file lookup — so dropping the blanket /tmp grant
  // produced, on a real run:
  //
  //     EPERM: operation not permitted, mkdir '/tmp/claude-501'
  //
  // `claude doctor` does NOT hit this, which is why the change looked safe when
  // I verified with it. Only a full launch surfaced it.
  //
  // Granted as the SPECIFIC path rather than restoring /tmp: this is one
  // directory scoped to the current uid, so the cross-run channel that the
  // blanket grant opened — any confined run reading and writing any other
  // run's /tmp files — stays closed.
  const runtimeDir = `/tmp/claude-${typeof process.getuid === "function" ? process.getuid() : "0"}`;
  return {
    capabilities: {
      version: "0.1.0",
      filesystem: {
        grants: [
          ...sysRead.map((/** @type {string} */ path) => ({ path, access: "read", type: "directory" })),
          ...sysReadFiles.map((/** @type {string} */ path) => ({ path, access: "read", type: "file" })),
          ...sysRw.map((/** @type {string} */ path) => ({ path, access: "readwrite", type: "directory" })),
          { path: runtimeDir, access: "readwrite", type: "directory" },
          // One kernel grant per declared root — the enforcement half of the
          // `workspace` / `workspace.N` entries in the confinement manifest.
          // Same list, so the two cannot disagree.
          ...sandbox.workdirs.map((/** @type {string} */ path) => ({ path, access: "readwrite", type: "directory" })),
          { path: sandbox.stateDir, access: "readwrite", type: "directory" },
          // The relocated skills store, granted READ. The state dir above stays
          // writable; this subtree does not, because `<stateDir>/skills` is a
          // symlink resolving here.
          ...(sandbox.skillStore
            ? [{ path: sandbox.skillStore, access: "read", type: "directory" }]
            : []),
          // Per-run scratch, replacing the shared /tmp grant.
          ...(sandbox.scratchDir
            ? [{ path: sandbox.scratchDir, access: "readwrite", type: "directory" }]
            : []),
          // The harness's config FILE, a sibling of its state dir rather than
          // inside it — `~/.claude` and `~/.claude.json` are two paths, and
          // granting the directory does not reach the file.
          //
          // Anthropic's own sandbox-runtime guidance says to allow BOTH
          // (code.claude.com/docs/en/sandbox-environments). Cloister granted
          // only the directory, and the result was `error: An internal error
          // occurred (EPERM)` — which masked a far better message: with the
          // file granted, `claude doctor` reports "claude.ai subscription auth
          // not active" and diagnoses the keychain itself.
          ...(sandbox.configFile
            ? [{ path: sandbox.configFile, access: "readwrite", type: "file" }]
            : []),
          // The harness's own install tree. `~/.local/bin/claude` is a shim
          // into `~/.local/share/claude/versions/<v>/`, so granting the
          // executable's path alone is not enough to run it.
          ...(sandbox.installDir
            ? [{ path: sandbox.installDir, access: "read", type: "directory" }]
            : []),
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
    env_set: {
      [target.baseUrlEnv]: plan.baseUrl,
      // Redirect scratch into the per-run directory. All three spellings,
      // because which one a tool honours is not something to guess: POSIX tools
      // read TMPDIR, some Node/Python paths read TMP or TEMP.
      ...(sandbox.scratchDir
        ? { TMPDIR: sandbox.scratchDir, TMP: sandbox.scratchDir, TEMP: sandbox.scratchDir }
        : {}),
    },
    harness_bin: sandbox.harnessBin,
    harness_args: sandbox.harnessArgs,
  };
}

/**
 * The local Workers a run needs alongside cloister, derived from the
 * `[[services]]` bindings wrangler.toml already declares.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A service binding only connects to another `wrangler dev` process running
 * locally. Nothing started one, so a real run printed:
 *
 *     env.NOTME (notme-bot)   Worker   local [not connected]
 *
 * which reads as a broken binding and really means "the Worker it names is not
 * running". `notme-bot` exists and starts clean — it was simply never launched.
 *
 * ── Why the SET is derived and only the PATH is an env knob ────────────────
 *
 * Which Workers a run needs is already stated once, in wrangler.toml's
 * `[[services]]` entries, and `lint:binding-parity` governs that list. A second
 * hand-maintained list here would be manumation — it would drift the first time
 * someone added a binding.
 *
 * WHERE each Worker's checkout lives is machine-specific and must NOT be
 * committed: ADR-0026 bans the `[inputs.*] from =` dev-escape precisely because
 * a committed local path silently wins over the declared `ref`, and
 * `lint:dev-escape` enforces it. So the path comes from the environment, per
 * service, and its absence is a NAMED warning rather than a silent
 * `[not connected]`.
 *
 *     CLOISTER_WORKER_DIR_NOTME_BOT=~/remotes/art/notme/worker
 *
 * ── Why each companion gets an explicit port ───────────────────────────────
 *
 * `wrangler dev` defaults to 8787 and NEITHER cloister's wrangler.toml nor
 * notme's declares a port. Started with no `--port`, the companion binds 8787
 * first and then cloister's own `task dev` dies on `Address already in use` —
 * so the feature meant to connect a binding would instead break every run.
 *
 * Ports are assigned off COMPANION_PORT_BASE by index, which is safe because
 * wrangler pairs service bindings through its dev registry by worker NAME, not
 * by port. Nothing reads these; they only have to not collide.
 *
 * @param {string} wranglerToml  contents of wrangler.toml
 * @param {Record<string,string|undefined>} env
 * @returns {{binding:string, service:string, dir:string|null, envVar:string, port:number}[]}
 */
export function resolveCompanionWorkers(wranglerToml, env = process.env) {
  // Parsed, not pattern-matched: `lint:structured-parse` — and a regex over
  // TOML would mis-read a `service` key belonging to any other table.
  const parsed = parseToml(wranglerToml);
  const raw = Array.isArray(parsed.services) ? parsed.services : [];
  /** @type {{service: string, binding: string}[]} */
  const services = [];
  for (const sv of raw) {
    // Narrowed by inspection rather than asserted: wrangler.toml is operator
    // input, and a `[[services]]` entry missing either key is a config error to
    // skip, not a crash inside a launch that has already minted an identity.
    if (!sv || typeof sv !== "object" || Array.isArray(sv)) continue;
    const row = /** @type {Record<string, unknown>} */ (sv);
    if (typeof row.service === "string" && typeof row.binding === "string") {
      services.push({ service: row.service, binding: row.binding });
    }
  }
  // ONE PROCESS PER SERVICE, not per binding. Several bindings may name the
  // same Worker — cloister binds notme-bot three times (NOTME for the
  // /identity/* fetch proxy, NOTME_JWT and NOTME_RECEIPTS for two distinct RPC
  // entrypoints, each its own binding for least privilege). Mapping bindings
  // 1:1 to processes launched notme-bot THREE times on three ports.
  //
  // Not merely wasteful: the comment above this function says wrangler pairs
  // service bindings through its dev registry by worker NAME, not by port. So
  // three live registrations of one name is the one thing that reasoning
  // cannot survive. Deduping here rather than at the call site keeps the
  // invariant with the derivation — this function's contract is "the Workers a
  // run needs", and a Worker needed twice is still one Worker.
  //
  // First binding wins for the reported `binding` field; it is only used in
  // log lines naming which binding prompted the launch.
  const byService = [];
  const seen = new Set();
  for (const sv of services) {
    if (seen.has(sv.service)) continue;
    seen.add(sv.service);
    byService.push(sv);
  }

  return byService.map((sv, i) => {
    const envVar = `CLOISTER_WORKER_DIR_${sv.service.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const dir = env[envVar];
    return {
      binding: sv.binding,
      service: sv.service,
      envVar,
      port: COMPANION_PORT_BASE + i,
      dir: dir ? dir.replace(/^~(?=$|\/)/, env.HOME ?? homedir()) : null,
    };
  });
}

// Operational lines are prefixed `cloister —`, not `harness:dev —`.
//
// The old prefix was a SCRIPT NAME, and it outlived the script: harness-dev.mjs
// stopped being the orchestration when this library took over, and `cloister
// run` imports launch() in-process rather than spawning it. But every line it
// printed still said `harness:dev`, so a first-party run LOOKED like a shell-out
// to the old file — which is exactly the drift this refactor removed. Reported
// as "harness-dev.mjs being used... feels bad", about output, not behaviour.
//
// Both doors (`cloister run`, `task harness:dev`) call this same code, so the
// prefix names the product rather than whichever door you came through.

/**
 * Kill a child AND everything it spawned — the run's whole process group.
 *
 * ── Why a plain .kill() is not enough ──────────────────────────────────────
 *
 * cloister is started through wrangler, which spawns `workerd`. That is a
 * GRANDCHILD: killing only wrangler can leave it
 * running, holding their ports, after the run has exited.
 *
 * Observed directly — five leaked cloisters after five runs:
 *
 *     8787: BUSY -> …/workerd     8790: BUSY -> …/workerd
 *     8788: BUSY -> …/workerd     8791: BUSY -> …/workerd
 *     8789: BUSY -> …/workerd
 *
 * The leak is worse than untidy. wrangler falls forward to the next free port,
 * so run N+1's cloister binds 8788 while `waitForHealth` polls 8787 — and gets
 * a healthy 200 from the STALE server. The run then looks fine while the shim
 * talks to an old build. A leak that makes the health check lie is the failure
 * mode "silence is evidence" is meant to prevent.
 *
 * So each child is spawned `detached: true`, which puts it in its OWN process
 * group, and teardown signals the negated pid — the group, not the leader.
 *
 * @param {{pid?: number|undefined, kill: (signal?: string) => void} | null | undefined} child
 */
export function killProcessGroup(child) {
  if (!child) return;
  try {
    // Negative pid = "the whole process group", which is the point.
    if (typeof child.pid === "number") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // ESRCH just means it already exited — the desired state either way. Fall
    // back to the direct kill so a platform without process groups still stops
    // the leader rather than silently stopping nothing.
    try { child.kill("SIGTERM"); } catch { /* lint-allow-silent: already gone */ }
  }
}

/**
 * Refuse to launch when a port the run OWNS is already taken.
 *
 * ── Why this is fail-closed and not a warning ──────────────────────────────
 *
 * `wrangler dev` does not fail on a busy port — it falls forward to the next
 * free one. So a leaked cloister on 8787 means run N+1 binds 8788 while
 * `waitForHealth` polls 8787 and gets a healthy 200 from the STALE server. The
 * run reports success, and the shim spends the session talking to an old build.
 * Every signal says fine. Observed exactly this, five leaks deep.
 *
 * `killProcessGroup` stops this run from leaking. This stops a run from
 * STARTING on top of anything else holding the port — another session, a
 * `cloister dev serve` in a terminal, or an unrelated server. The two are complements:
 * neither alone makes the health check trustworthy.
 *
 * Named, with the fix in the message, because "port busy" is only actionable if
 * you know which process to look for.
 *
 * @param {number[]} ports
 * @param {{probe?: (port: number) => boolean}} [deps]
 */
export function assertPortsFree(ports, deps = {}) {
  const probe = deps.probe ?? ((/** @type {number} */ port) => {
    try {
      execFileSync("lsof", ["-ti", `:${port}`], { stdio: ["ignore", "pipe", "ignore"] });
      return true;  // lsof exits 0 only when something holds the port
    } catch {
      return false; // non-zero = nothing listening. Also the case when lsof is
                    // absent, which degrades to today's behaviour rather than
                    // blocking a launch over a missing diagnostic tool.
    }
  });
  const busy = ports.filter((p) => probe(p));
  if (busy.length === 0) return;
  throw new PreconditionError(
    `port${busy.length > 1 ? "s" : ""} already in use: ${busy.join(", ")}\n` +
    `  A run owns these, and wrangler does NOT fail on a busy port — it moves to\n` +
    `  the next one, so the health check would pass against whatever is already\n` +
    `  there and the session would talk to the wrong server.\n` +
    `  Find it:  lsof -ti :${busy[0]}\n` +
    `  Clear it: pkill -f workerd; pkill -f "wrangler dev"`,
  );
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
  const killGroup = deps.killProcessGroup ?? killProcessGroup;
  const { identity } = artifacts;
  const ephemeral = [...artifacts.ephemeralPaths];

  const companions = (deps.resolveCompanionWorkers ?? resolveCompanionWorkers)(
    readFileSync(resolve(plan.root, "wrangler.toml"), "utf8"),
  );
  const companionsPorts = companions.filter((c) => c.dir).map((c) => c.port);

  // Before anything binds or is minted: the ports this run owns must be free.
  (deps.assertPortsFree ?? assertPortsFree)([
    8787, Number(plan.shimPort), ...companionsPorts,
  ]);

  // Companion Workers FIRST: wrangler pairs service bindings through its dev
  // registry at startup, so one started after cloister still reports
  // [not connected] for that whole session.
  /** @type {{kill: () => void, pid?: number}[]} */
  const companionProcs = [];
  for (const c of companions) {
    if (!c.dir) {
      log(
        `cloister — env.${c.binding} (${c.service}) will report [not connected]: ` +
        `nothing local is running it.\n` +
        `  Set ${c.envVar}=<path to its worker dir> to have this run start it.\n` +
        `  Not fatal — it costs the routes that binding serves, nothing else.`,
      );
      continue;
    }
    log(`cloister — starting companion Worker ${c.service} (env.${c.binding}) on :${c.port} from ${c.dir}`);
    companionProcs.push(spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(c.port)], {
      cwd: c.dir, stdio: "inherit", detached: true,
    }));
    // WAIT for it to bind before moving on. Starting it is not enough: wrangler
    // pairs service bindings through its dev registry at cloister's startup, so
    // a companion still booting when cloister starts is a companion cloister
    // never sees — the binding reports [not connected] for the whole session
    // even though the process is right there. Observed exactly that.
    try {
      await waitPort(`http://127.0.0.1:${c.port}/`, 60_000);
    } catch {
      // Non-fatal by design: a companion that will not come up costs the routes
      // its binding serves, and nothing else. Killing the run over it would
      // make an optional dependency mandatory.
      log(`cloister — ${c.service} did not come up on :${c.port}; env.${c.binding} will be [not connected].`);
    }
  }

  const cloister = (deps.startLocalRouter ?? startLocalRouter)({
    root: plan.root,
    env: deps.env ?? process.env,
    spawn,
  });
  await waitHealth(`${CLOISTER_BASE}/health`, 60_000);

  const shim = spawn(process.execPath, ["--import", "tsx", "src/harness-shim/index.ts"], {
    cwd: plan.root,
    stdio: "inherit",
    detached: true,
    env: {
      ...(deps.env ?? process.env),
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

    log(`\n${bar}\ncloister — SANDBOX=nono: launching ${plan.sandbox.harnessBin} kernel-confined (cloister-harness).`);
    log(`  policy: ${policyPath} (declared nono manifest, default-deny)`);
    log(`  rw: ${[...plan.sandbox.workdirs, plan.sandbox.stateDir].join(", ")}`);
    log(`  network: blocked, localhost :${plan.shimPort} only → ${plan.baseUrl}\n${bar}\n`);
    // Wait for the shim to bind before launching the confined harness —
    // otherwise the harness's first request races startup (connect-refused).
    await waitPort(plan.baseUrl, 15_000);
    // macOS only: acknowledge that bind/inbound is unenforced, per
    // cloister-2d420c. cloister-harness REFUSES a manifest declaring a
    // localhost port unless this is set, because Seatbelt filters outbound per
    // port and grants bind/inbound unqualified — so the declared port is not
    // the boundary it reads as.
    //
    // Set HERE, at the one place that knows the run is the ADR-0042 turnkey
    // harness and has already decided the localhost shim IS the seam. It is
    // never in committed config (lint:no-dev-mode refuses that), so a
    // deployment cannot inherit the exemption — it is re-declared per run by
    // the thing that chose the shape.
    //
    // Harmless on Linux, where Landlock filters bind(2) per port and the
    // binary's check is cfg'd out entirely.
    confined = spawn(plan.sandbox.confineBin, [policyPath], {
      env: { ...(deps.env ?? process.env), CLOISTER_ACCEPT_UNENFORCED_BIND: "1" },
      // The FIRST declared root is the primary: it is what a relative path
      // inside the harness resolves against.
      cwd: plan.sandbox.workdirs[0], stdio: "inherit",
    });
  } else {
    const t = plan.target;
    log(`\n${bar}\ncloister — ready. In your harness shell:\n`);
    log(`  export ${t.baseUrlEnv}="${plan.baseUrl}"`);
    if (plan.auth.mode === "audit") {
      log(`  # DO NOT set ${t.stripEnv.join(" / ")} — either leaves your`);
      log(`  # Max subscription. Base-URL only keeps the subscription; cloister receipts`);
      log(`  # each call (audit, not custody — there's no key to vault).`);
    } else {
      log(`  # no ${t.apiKeyEnv} on the harness — the key is vaulted in cloister.`);
    }
    log(`  ${t.entryPoint || t.name}`);
    log(`  # (or: cloister run --harness ${t.name} --repo "$PWD" to launch it kernel-confined)`);
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
    // Groups, not leaders — see killProcessGroup. The confined harness is left
    // as a direct kill: cloister-harness is the group leader of the sandboxed
    // tree and killing it takes its children with it.
    confined?.kill();
    killGroup(shim);
    killGroup(cloister);
    // Companions die with the session too. A wrangler dev left running holds
    // its port, so the NEXT run's companion fails to bind — which presents as
    // [not connected] again, i.e. exactly the symptom this path removes.
    for (const p of companionProcs) killGroup(p);
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
    `cloister — NOTE: audit mode under confinement may be unauthenticated.\n` +
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
  log(`cloister — target ${plan.target.name} · ` +
      (plan.auth.mode === "audit"
        ? "AUDIT mode (forward harness auth + receipt; no key vaulted)"
        : "CUSTODY mode (API key vaulted + injected)"));
  warnIfAuditIsUnauthenticated(plan, log, deps);
  // ADR-0061: verify declared skills BEFORE minting. Same ordering as every
  // other precondition — an operator who aborts on a failed pin has not caused
  // a credential to be written.
  if (plan.sandbox) verifySkills(plan, log, deps);

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
    log("cloister — --setup-only: skipping launch. .dev.vars is ready.");
    return { plan, artifacts, session: null };
  }
  const session = await launchSession(plan, artifacts, deps);
  return { plan, artifacts, session };
}
