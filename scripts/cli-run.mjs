#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister run` — execute a harness confined to one repo, and nothing else.
//
//     cloister run --harness claude-code --repo /abs/path/to/repo
//
// This is PACKAGING, deliberately. Every mechanism it needs already exists:
// harness-dev.mjs mints the ephemeral dev identity, builds the declared
// default-deny confinement profile, and execs the harness under nono
// (Seatbelt on macOS, Landlock on Linux). It already reads HARNESS_WORKDIR and
// threads it into the nono policy as the single writable path.
//
// So this file does NOT reimplement any of that. It validates the arguments a
// person would get wrong, sets the two environment variables the existing path
// already understands, and delegates. Two implementations of a mint-and-confine
// sequence is how the two drift, and the security-relevant half is the one that
// would drift silently.
//
// ── What the confinement actually gives you ────────────────────────────────
//
// Verified on macOS, and worth stating precisely because "sandboxed" is a word
// people use loosely:
//
//   the --repo you name          readable + writable
//   ~/.ssh, ~/.aws, $HOME        EPERM — kernel-denied, not ENOENT, so the
//                                boundary does not leak whether a path exists
//   ANY OTHER REPO on the box    EPERM — this is the "and nothing else" half
//   outbound network             EPERM before any packet leaves
//   127.0.0.1                    reachable — cloister is the ONLY egress, which
//                                is what makes tool delivery go through it
//
// ── Why --repo does not break the attestation ─────────────────────────────
//
// The confinement manifest that gets BLAKE3-digested into the cert keeps
// symbolic paths (`workspace`, `state`), so its digest is identical no matter
// which repo you pass — measured: symbolic 5098bcde…, /repo-A b93439f6…,
// /repo-B e7514fbe…. The absolute path travels only on the nono plane, which is
// not digested. Attest the shape, bind the path at exec (cloister-d84875).

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { HARNESS_ENV } from "./cli-surface.mjs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class RunUsageError extends Error {}

function printHelp(log = console.log) {
  log("Usage: cloister run --harness <name> --repo <absolute-path> [options]");
  log("");
  log("Execute a harness confined to one repository, and nothing else.");
  log("");
  log("Required:");
  log("  --repo <abs>       the ONLY directory the harness may read or write");
  log("");
  log("Options:");
  log("  --harness <name>   harness to launch (default: the declared default)");
  log("  --dry-run          print what would be confined; mint nothing, launch nothing");
  log("  --setup-only       mint the identity and write .dev.vars, do not launch");
  log("  --audit            forward harness auth and emit a receipt; no key vaulted");
  log("  --no-sandbox       DANGEROUS: skip kernel confinement (debugging only)");
  log("  --help             this text — mints nothing, writes nothing");
  log("");
  log("The harness gets: rw on --repo, loopback to cloister, and nothing else.");
  log("~/.ssh, other repos, and outbound network are kernel-denied (EPERM).");
}

/**
 * @param {string[]} argv
 * @returns {{help:boolean, repo:string|null, harness:string|null, dryRun:boolean,
 *            passthrough:string[], sandbox:boolean}}
 */
export function parseArgs(argv) {
  const out = {
    help: false, repo: null, harness: null,
    dryRun: false, passthrough: [], sandbox: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--no-sandbox") { out.sandbox = false; continue; }
    if (a === "--setup-only" || a === "--audit") { out.passthrough.push(a); continue; }
    if (a === "--repo" || a === "--harness") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new RunUsageError(`${a} requires a value`);
      }
      if (a === "--repo") out.repo = v; else out.harness = v;
      i++;
      continue;
    }
    throw new RunUsageError(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

/**
 * Validate the repo argument.
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

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const spawnImpl = deps.spawn ?? spawn;

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

  let repo;
  try {
    repo = validateRepo(args.repo);
  } catch (e) {
    if (e instanceof RunUsageError) { errLog(`cloister run: ${e.message}`); return 2; }
    throw e;
  }

  if (args.dryRun) {
    // Everything a person needs to decide "is that the boundary I meant?" —
    // and nothing minted, written, or launched to find out.
    log(`cloister run — DRY RUN, nothing minted or launched`);
    log(`  harness:      ${args.harness ?? "(declared default)"}`);
    log(`  workspace:    ${repo}   rw`);
    log(`  confinement:  ${args.sandbox ? "nono (kernel: Seatbelt/Landlock)" : "NONE — --no-sandbox"}`);
    log(`  egress:       127.0.0.1 only (cloister); outbound network kernel-denied`);
    log(`  denied:       every other path, including ~/.ssh and other repos`);
    log(`  attested:     the confinement SHAPE (symbolic workspace/state), so the`);
    log(`                cert digest is identical whichever --repo you pass`);
    return 0;
  }

  if (!args.sandbox) {
    errLog(
      `cloister run: --no-sandbox disables kernel confinement. The harness will ` +
      `have your full user's filesystem and network access. Debugging only.`,
    );
  }

  // Names come from the shared contract, not literals — see HARNESS_ENV.
  const env = { ...process.env, [HARNESS_ENV.workdir]: repo };
  // SANDBOX=nono is what harness-dev.mjs keys on to apply the declared
  // default-deny profile. Confinement is the POINT of this verb, so it is the
  // default here even though it is opt-in on the underlying task.
  if (args.sandbox) env[HARNESS_ENV.sandbox] = HARNESS_ENV.sandboxProvider;
  const forwarded = [...args.passthrough];
  if (args.harness) forwarded.push("--target", args.harness);

  return await new Promise((res) => {
    const child = spawnImpl(
      process.execPath,
      [resolve(ROOT, "scripts/harness-dev.mjs"), ...forwarded],
      { cwd: ROOT, env, stdio: "inherit" },
    );
    child.on("error", (e) => { errLog(`cloister run: ${e.message}`); res(1); });
    child.on("close", (code) => res(code ?? 0));
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c));
}
