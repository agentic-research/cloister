// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scripts/pull-inputs.mjs — ADR-0026 Phase 1c (cloister-cf7a3b follow-up)
//
// The "install" half of the resolve → install → run flow. `cluster:resolve`
// fetches each input's `server.json` and pins its self-declared `oci` image
// (ADR-0038 `packages[].oci`) into `cluster.lock.toml`. This script reads
// those pinned rows and pulls the image BYTES into the local container store
// so `task cluster:up` — which emits `pull_policy: never` for reproducible,
// no-surprise-fetch boots — has everything it needs offline.
//
// Analogy: `cluster:resolve` is `npm install` writing the lockfile;
// `inputs:pull` is `npm ci` materializing exactly what the lockfile pins.
// The runtime never pulls, because the fetch already happened here,
// deliberately, against committed digests.
//
// Pull-ref precedence (mirrors emit-compose's resolveBundleImage, ADR-0038):
//
//   identifier@digest   — digest-pinned, content-addressed, reproducible
//   identifier:version  — tag-pinned (WARN: not content-addressed)
//   identifier          — registry default/latest (WARN)
//
// Runtime: $CONTAINER_CMD, else docker, else nerdctl, else podman.
//
// Flags:
//   --print   list the images the lockfile pins; pull nothing (CI / preview).
//   --yes     approve the displayed, digest-pinned pull plan (automation).
//   --allow-unpinned
//             explicitly permit mutable tag/bare refs. Separate from --yes:
//             consent to downloading is not consent to weaker provenance.
//
// Wire:
//   Exit 0 — all images pulled (or --print).
//   Exit 1 — one or more pulls failed (unpublished image / not authed).
//   Exit 2 — toolchain error (lockfile missing, no runtime, unparseable).

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parse as parseToml } from "@iarna/toml";
import chalk from "chalk";
import { ociImageRef } from "./lib/oci-artifact.mjs";
import {
  isAffirmative,
  requestOperatorConsent,
} from "./lib/operator-consent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

const LOCKFILE_PATH = process.env.CLOISTER_LOCKFILE
  ? resolvePath(process.env.CLOISTER_LOCKFILE)
  : resolvePath(REPO_ROOT, "cluster.lock.toml");

/**
 * Compute the pullable image reference for one lockfile `oci` row, using
 * the ADR-0038 precedence. Returns `null` when the row is absent or names
 * no identifier (→ the caller skips + warns).
 *
 * Exported for unit tests.
 */
export function ociPullRef(oci) {
  return ociImageRef(oci);
}

/**
 * Walk a parsed lockfile document's `[inputs.*]` tables and return one
 * row per input: `{ name, ref, pinned }`. `ref` is null when the input
 * carries no oci image; `pinned` is true only for digest-pinned refs
 * (content-addressed, reproducible).
 *
 * Exported for unit tests.
 */
export function collectOciRefs(lockDoc) {
  const inputs = (lockDoc && typeof lockDoc === "object" && lockDoc.inputs) || {};
  return Object.entries(inputs).map(([name, spec]) => {
    const oci = spec && typeof spec === "object" ? spec.oci : null;
    return {
      name,
      ref: ociPullRef(oci),
      pinned: !!(oci && typeof oci === "object" && oci.digest),
    };
  });
}

export function parsePullArgs(argv) {
  const opts = {
    printOnly: false,
    yes: false,
    allowUnpinned: false,
  };
  for (const arg of argv) {
    if (arg === "--print") opts.printOnly = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--allow-unpinned") opts.allowUnpinned = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-")) (opts.inputs ??= []).push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export function selectOciRefs(rows, inputNames = []) {
  if (inputNames.length === 0) return rows;
  const requested = new Set(inputNames);
  const selected = rows.filter((row) => requested.delete(row.name));
  if (requested.size > 0) {
    throw new Error(`unknown input selection: ${[...requested].join(", ")}`);
  }
  return selected;
}

export function validatePullSafety(rows, { allowUnpinned }) {
  const mutable = rows.filter((row) => row.ref && !row.pinned);
  if (mutable.length === 0 || allowUnpinned) return;
  const details = mutable.map((row) => `${row.name} → ${row.ref}`).join(", ");
  throw new Error(
    `refusing ${mutable.length} mutable artifact reference(s): ${details}. ` +
    `Resolve immutable digests first, or pass --allow-unpinned to accept this supply-chain downgrade.`,
  );
}

export { isAffirmative };

function detectRuntime() {
  if (process.env.CONTAINER_CMD) return process.env.CONTAINER_CMD;
  for (const cmd of ["docker", "nerdctl", "podman"]) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return cmd;
  }
  return null;
}

function printHelp(log) {
  log("Usage: cloister artifacts pull [input ...] [--print] [--yes] [--allow-unpinned]");
  log("");
  log("Materialize the OCI artifacts pinned by cluster.lock.toml.");
  log("");
  log("  --print             Preview the acquisition plan; download nothing");
  log("  -y, --yes           Approve the displayed plan (required without a TTY)");
  log("  --allow-unpinned    Permit mutable tag/bare refs (unsafe downgrade)");
  log("");
  log("Input names scope the plan without weakening unrelated mutable references.");
}

function printPlan(rows, log = console.log) {
  log(chalk.bold("Artifacts requested by cluster.lock.toml:"));
  for (const row of rows) {
    const trust = row.pinned
      ? chalk.green("digest-pinned")
      : chalk.yellow("MUTABLE / UNPINNED");
    log(`  ${chalk.cyan(row.name)} → ${row.ref}  ${trust}`);
  }
}

async function askForConsent(rows, input, output) {
  return requestOperatorConsent({
    input,
    output,
    prompt:
      `Download ${rows.length} artifact${rows.length === 1 ? "" : "s"}? ` +
      `${chalk.dim("[y/N]")} `,
    nonInteractiveMessage:
      "refusing to download without confirmation on a non-interactive terminal; " +
      "review with --print, then pass --yes",
  });
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const warn = io.warn ?? ((line) => console.warn(line));
  const error = io.error ?? ((line) => console.error(line));
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  let opts;
  try {
    opts = parsePullArgs(argv);
  } catch (e) {
    error(`pull-inputs: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    printHelp(log);
    return 0;
  }

  if (!existsSync(LOCKFILE_PATH)) {
    error(
      `pull-inputs: lockfile not found at ${LOCKFILE_PATH} — run \`task cluster:resolve\` first`,
    );
    return 2;
  }

  let doc;
  try {
    doc = parseToml(readFileSync(LOCKFILE_PATH, "utf8"));
  } catch (e) {
    error(`pull-inputs: failed to parse ${LOCKFILE_PATH}: ${e.message}`);
    return 2;
  }

  let rows;
  try {
    rows = selectOciRefs(collectOciRefs(doc), opts.inputs);
  } catch (e) {
    error(`pull-inputs: ${e.message}`);
    return 2;
  }
  const withImage = rows.filter((r) => r.ref);
  const noImage = rows.filter((r) => !r.ref);

  for (const r of noImage) {
    warn(
      `pull-inputs: input "${r.name}" has no oci image in the lockfile — skipping ` +
      `(add packages[].oci to its server.json, ADR-0038)`,
    );
  }

  if (withImage.length === 0) {
    log("pull-inputs: no oci images pinned in the lockfile — nothing to pull");
    return 0;
  }

  printPlan(withImage, log);
  if (opts.printOnly) {
    log("pull-inputs: --print — download skipped");
    return 0;
  }

  try {
    validatePullSafety(withImage, opts);
  } catch (e) {
    error(chalk.red(`pull-inputs: ${e.message}`));
    return 2;
  }

  if (opts.allowUnpinned && withImage.some((row) => !row.pinned)) {
    warn(chalk.yellow.bold(
      "pull-inputs: WARNING — proceeding with mutable artifact references by explicit operator request",
    ));
  }

  if (!opts.yes) {
    let approved;
    try {
      approved = await askForConsent(withImage, input, output);
    } catch (e) {
      error(`pull-inputs: ${e.message}`);
      return 2;
    }
    if (!approved) {
      log("pull-inputs: cancelled; downloaded nothing");
      return 0;
    }
  }

  const cmd = detectRuntime();
  if (!cmd) {
    error(
      "pull-inputs: no container runtime found (need docker, nerdctl, or podman; " +
      "set CONTAINER_CMD to override)",
    );
    return 2;
  }

  const failures = [];
  for (const r of withImage) {
    if (!r.pinned) {
      warn(
        `pull-inputs: ${r.name} → ${r.ref} is tag-pinned (not content-addressed) — ` +
        `ask the maintainer to add a "digest" to packages[].oci for a reproducible pin`,
      );
    }
    log(`pull-inputs: ${cmd} pull ${r.ref}`);
    const res = spawnSync(cmd, ["pull", r.ref], { stdio: "inherit" });
    if (res.status !== 0) failures.push(r);
  }

  if (failures.length > 0) {
    error(
      `\npull-inputs: ${failures.length} image(s) failed to pull: ` +
      `${failures.map((f) => f.ref).join(", ")}`,
    );
    error("  (is the image published to its registry, and are you authenticated?)");
    return 1;
  }

  log(
    `\npull-inputs: pulled ${withImage.length} image(s) — ` +
    `\`task cluster:up\` (pull_policy: never) can now boot offline.`,
  );
  return 0;
}

const invokedAsScript =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`pull-inputs: unexpected error: ${e.message}`);
      process.exit(2);
    },
  );
}
