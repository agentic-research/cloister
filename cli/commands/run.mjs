#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister run` — execute a harness confined to the repos you name, and
// nothing else.
//
//     cloister run --harness claude-code --repo /abs/path/to/repo
//     cloister run --harness claude-code --repo /abs/api --repo /abs/shared
//
// This is a DOOR, deliberately. The orchestration — mint the ephemeral dev
// identity, build the declared default-deny confinement profile, exec the
// harness under nono (Seatbelt on macOS, Landlock on Linux) — lives in
// cli/lib/harness/launch.mjs, and this file calls it IN-PROCESS.
//
// It used to spawn `node scripts/harness-dev.mjs` and hand its already-parsed
// flags over as environment variables. That round-trip is where orchestration
// stops being first-party: every value crossing it becomes an untyped string,
// and `--repo a --repo b` — the shape of the confinement — depended on a JSON
// blob surviving an env var whose name had to match on both sides. A typo in
// that name is a silently unconfined run.
//
// So there is one orchestration and two front doors onto it. `task harness:dev`
// is the other; it reads the environment because an OPERATOR types it.
//
// ── What the confinement actually gives you ────────────────────────────────
//
// Verified on macOS, and worth stating precisely because "sandboxed" is a word
// people use loosely:
//
//   each --repo you name         readable + writable
//   ~/.ssh, ~/.aws, $HOME        EPERM — kernel-denied, not ENOENT, so the
//                                boundary does not leak whether a path exists
//   ANY OTHER REPO on the box    EPERM — this is the "and nothing else" half
//   outbound network             EPERM before any packet leaves
//   127.0.0.1                    reachable — cloister is the ONLY egress, which
//                                is what makes tool delivery go through it
//
// ── Why --repo does not break the attestation, but --repo --repo changes it ─
//
// The confinement manifest that gets BLAKE3-digested into the cert keeps
// symbolic paths (`workspace`, `state`), so its digest is identical no matter
// WHICH repo you pass — measured: symbolic 5098bcde…, /repo-A b93439f6…,
// /repo-B e7514fbe…. The absolute path travels only on the nono plane, which is
// not digested. Attest the shape, bind the path at exec (cloister-d84875).
//
// HOW MANY repos you pass is a different question, and the opposite answer.
// Two writable roots is a materially wider confinement than one, so it is part
// of the SHAPE: the manifest gains a `workspace.1` entry per extra root and the
// digest changes. If it did not, a cert minted against a one-repo shape would
// satisfy the §7 commitment check for a run confined to five — the manifest
// would be attesting a boundary it no longer describes.
//
// The single-repo manifest is byte-identical to before, so its digest is
// unchanged and the measurement above still holds. Asserted, not assumed:
// see scripts/test/confinement-shape.test.mjs.

import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { renderCommandHelp } from "../surface.mjs";
import { fileURLToPath } from "node:url";
import {
  launch, validateWorkdirSet, LaunchUsageError, PreconditionError,
} from "../lib/harness/launch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export class RunUsageError extends Error {}

function printHelp(log = console.log) {
  // Derived from cli-surface.mjs — the same declaration that produces the
  // top-level help and docs/reference/cli.md. This was a hardcoded list, which
  // is how --harness-bin could be declared and parsed while --help omitted it.
  log(renderCommandHelp("run"));
  log("The harness gets: rw on --repo, loopback to cloister, and nothing else.");
  log("~/.ssh, other repos, and outbound network are kernel-denied (EPERM).");
}

/**
 * @param {string[]} argv
 * @returns {{help:boolean, repos:string[], harness:string|null, dryRun:boolean,
 *            passthrough:string[], sandbox:boolean}}
 */
export function parseArgs(argv) {
  const out = {
    help: false, repos: [], harness: null, harnessBin: null,
    dryRun: false, passthrough: [], sandbox: true, harnessArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Everything after `--` belongs to the harness, not to us. Taken verbatim
    // so a prompt containing --flags reaches the harness unmangled.
    if (a === "--") { out.harnessArgs = argv.slice(i + 1); break; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--no-sandbox") { out.sandbox = false; continue; }
    if (a === "--setup-only" || a === "--audit") { out.passthrough.push(a); continue; }
    if (a === "--repo" || a === "--harness" || a === "--harness-bin") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new RunUsageError(`${a} requires a value`);
      }
      // Repeatable, and ACCUMULATES rather than overwrites. Last-one-wins on a
      // confinement flag is the wrong default: a user who passes two repos and
      // silently gets one confined to the second has a harness that cannot see
      // the tree they were working in, with nothing said about it.
      if (a === "--repo") out.repos.push(v);
      else if (a === "--harness-bin") out.harnessBin = v;
      else out.harness = v;
      i++;
      continue;
    }
    throw new RunUsageError(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

/**
 * Validate one --repo value.
 *
 * Absolute is REQUIRED rather than resolved-from-cwd. A relative path would be
 * resolved against wherever the command was typed, and the resulting confinement
 * boundary is the one thing a user must not have to infer — getting it wrong
 * silently means confining the harness to the wrong tree, which looks like it
 * worked.
 */
export function validateRepo(repo) {
  if (!repo) {
    throw new RunUsageError(
      "--repo is required: name the ONLY directory the harness may touch",
    );
  }
  if (!isAbsolute(repo)) {
    throw new RunUsageError(
      `--repo must be absolute, got ${JSON.stringify(repo)}. The confinement ` +
      `boundary is not something to resolve against the current directory.`,
    );
  }
  if (!existsSync(repo)) {
    throw new RunUsageError(`--repo does not exist: ${repo}`);
  }
  if (!statSync(repo).isDirectory()) {
    throw new RunUsageError(`--repo is not a directory: ${repo}`);
  }
  return resolve(repo);
}

/**
 * Validate the whole --repo set, in the order given.
 *
 * The FIRST repo is the primary workspace: it becomes the harness's cwd, so it
 * is the one a bare relative path inside the harness resolves against. Order is
 * therefore meaningful and is preserved, not sorted.
 *
 * Per-value checks (absolute, exists, is a directory) are `--repo`'s own syntax
 * and live above. The SET rules — no duplicates, no nesting — are a property of
 * the confinement, so they live in the pipeline and every door gets them; this
 * only supplies the flag's vocabulary and re-raises in the CLI's error type.
 */
export function validateRepos(repos) {
  if (!repos || repos.length === 0) validateRepo(null); // throws, named
  try {
    return validateWorkdirSet(repos.map(validateRepo), "--repo");
  } catch (e) {
    if (e instanceof LaunchUsageError) throw new RunUsageError(e.message);
    throw e;
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof RunUsageError) { errLog(`cloister run: ${e.message}`); printHelp(errLog); return 2; }
    throw e;
  }

  // --help before ANY validation or side effect. cloister-eb33d4: asking what a
  // command does must never be the path that mints a credential.
  if (args.help) { printHelp(log); return 0; }

  let repos;
  try {
    repos = validateRepos(args.repos);
  } catch (e) {
    if (e instanceof RunUsageError) { errLog(`cloister run: ${e.message}`); return 2; }
    throw e;
  }

  if (args.dryRun) {
    // Everything a person needs to decide "is that the boundary I meant?" —
    // and nothing minted, written, or launched to find out.
    log(`cloister run — DRY RUN, nothing minted or launched`);
    log(`  harness:      ${args.harness ?? "(declared default)"}`);
    repos.forEach((r, i) => {
      // Naming the primary explicitly: it is the cwd, so it is what a relative
      // path inside the harness resolves against. Ordering is not cosmetic.
      log(`  workspace:    ${r}   rw${i === 0 && repos.length > 1 ? "   (primary — harness cwd)" : ""}`);
    });
    log(`  confinement:  ${args.sandbox ? "nono (kernel: Seatbelt/Landlock)" : "NONE — --no-sandbox"}`);
    log(`  egress:       127.0.0.1 only (cloister); outbound network kernel-denied`);
    log(`  denied:       every other path, including ~/.ssh and other repos`);
    log(`  attested:     the confinement SHAPE — symbolic paths, so the digest is`);
    log(`                identical whichever repos you pass, and DIFFERENT for how`);
    log(`                many (${repos.length} writable root${repos.length === 1 ? "" : "s"} + state)`);
    return 0;
  }

  if (!args.sandbox) {
    errLog(
      `cloister run: --no-sandbox disables kernel confinement. The harness will ` +
      `have your full user's filesystem and network access. Debugging only.`,
    );
  }

  // Absolute for the same reason --repo is: there is no $PATH inside the
  // sandbox, so a bare name cannot resolve there and would fail at exec time
  // rather than here.
  if (args.harnessBin && !isAbsolute(args.harnessBin)) {
    errLog(
      `cloister run: --harness-bin must be absolute, got ${JSON.stringify(args.harnessBin)}. ` +
      `There is no $PATH inside the sandbox for a bare name to resolve against.`,
    );
    return 2;
  }

  // The LaunchRequest is built from the flags this file already parsed. No
  // env round-trip: `repos` arrives as a string[] with a type, not as JSON in a
  // variable whose name has to match on both sides of a spawn.
  //
  // Confinement is the POINT of this verb, so sandbox is present unless the
  // operator asked for it not to be — the opposite default to the underlying
  // task, where it is opt-in. Absence is the only "off": there is no
  // `{enabled: false}` for a mis-read boolean to leave unapplied.
  const request = {
    root: ROOT,
    targetName: args.harness,
    setupOnly: args.passthrough.includes("--setup-only"),
    wantsAudit: args.passthrough.includes("--audit"),
    // WHICH env var holds the key is the target's declaration, so resolving it
    // here would mean restating that mapping in a second place.
    credentialEnv: process.env,
    sandbox: args.sandbox
      ? {
          provider: "nono",
          workdirs: repos,
          harnessBin: args.harnessBin,
          harnessArgs: args.harnessArgs,
        }
      : null,
  };

  // deps.launch is the seam the tests drive; the default is the real pipeline.
  const launchImpl = deps.launch ?? launch;
  try {
    const { session } = await launchImpl(request, { errLog, ...deps.launchDeps });
    if (!session) return 0;
    const end = await session.done;
    return end.code ?? 0;
  } catch (e) {
    if (e instanceof LaunchUsageError) { errLog(`cloister run: ${e.message}`); return 2; }
    if (e instanceof PreconditionError) { errLog(`cloister run: ${e.message}`); return e.exitCode; }
    errLog(`cloister run: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c));
}
