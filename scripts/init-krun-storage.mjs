#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Create one grow-on-demand, case-sensitive APFS sparsebundle for krunvm's
// Buildah/rootfs state. This avoids a permanent APFS volume while retaining
// the filesystem semantics required by upstream krunvm on macOS.

import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import chalk from "chalk";

import { isCanonicalAbsolutePath } from "./lib/canonical-path.mjs";
import { requestOperatorConsent } from "./lib/operator-consent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");
const SIZE = /^[1-9][0-9]*(?:m|g)$/i;

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseStorageArgs(argv, repoRoot = REPO_ROOT) {
  const opts = {
    image: resolvePath(repoRoot, ".cloister", "krunvm.sparsebundle"),
    mountpoint: "/Volumes/krunvm",
    size: "3g",
    printOnly: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--image") {
      opts.image = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--mountpoint") {
      opts.mountpoint = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--size") {
      opts.size = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--print") opts.printOnly = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [flag, value] of [["--image", opts.image], ["--mountpoint", opts.mountpoint]]) {
    if (!isCanonicalAbsolutePath(value)) {
      throw new Error(`${flag} must be a canonical absolute path`);
    }
  }
  if (!SIZE.test(opts.size)) throw new Error("--size must be a positive MiB/GiB value such as 3g");
  return opts;
}

export function buildStoragePlan(options) {
  const volumeName = basename(options.mountpoint);
  return {
    command: "hdiutil",
    args: [
      "create",
      "-size", options.size,
      "-type", "SPARSEBUNDLE",
      "-fs", "Case-sensitive APFS",
      "-volname", volumeName,
      "-attach",
      options.image,
    ],
    mountpoint: options.mountpoint,
  };
}

function printHelp(log) {
  log("Usage: cloister runtime storage init [options]");
  log("");
  log("Create one grow-on-demand case-sensitive APFS sparsebundle for krunvm.");
  log("");
  log("  --image <path>       Sparsebundle path (default: .cloister/krunvm.sparsebundle)");
  log("  --mountpoint <path>  Mounted volume path (default: /Volumes/krunvm)");
  log("  --size <size>        Logical maximum, e.g. 3g (default: 3g)");
  log("  --print              Preview only");
  log("  -y, --yes            Approve creation in a non-interactive terminal");
}

function commandFailure(command, result) {
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `${command} failed${detail ? `: ${detail}` : ""}`;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  // Injectable so both the darwin and non-darwin branches are testable on any
  // host. Read straight from process.platform, the refusal path was unreachable
  // on macOS dev machines and the plan path unreachable on Linux CI, so the
  // command's own contract test only ever covered whichever half it ran on.
  const platform = io.platform ?? process.platform;

  let opts;
  try {
    opts = parseStorageArgs(argv);
  } catch (cause) {
    error(`init-krun-storage: ${cause.message}`);
    return 2;
  }
  if (opts.help) {
    printHelp(log);
    return 0;
  }
  if (platform !== "darwin") {
    error("init-krun-storage: sparsebundle storage is a macOS-only krunvm prerequisite");
    return 2;
  }

  const exists = existsSync(opts.image);
  const plan = exists
    ? {
        command: "hdiutil",
        args: ["attach", "-mountpoint", opts.mountpoint, opts.image],
        mountpoint: opts.mountpoint,
      }
    : buildStoragePlan(opts);

  log(chalk.bold("krunvm storage plan:"));
  log(`  image       ${chalk.cyan(opts.image)}`);
  log(`  mountpoint  ${chalk.cyan(opts.mountpoint)}`);
  log(`  maximum     ${opts.size} (${exists ? "existing sparsebundle" : "grows on demand"})`);
  log(`  command     ${plan.command} ${plan.args.join(" ")}`);
  if (opts.printOnly) {
    log("init-krun-storage: --print — host storage unchanged");
    return 0;
  }

  if (!opts.yes) {
    let approved;
    try {
      approved = await requestOperatorConsent({
        input,
        output,
        prompt: `Create and attach this runtime volume? ${chalk.dim("[y/N]")} `,
        nonInteractiveMessage:
          "refusing to change host storage without confirmation; review with --print, then pass --yes",
      });
    } catch (cause) {
      error(`init-krun-storage: ${cause.message}`);
      return 2;
    }
    if (!approved) {
      log("init-krun-storage: cancelled; host storage unchanged");
      return 0;
    }
  }

  mkdirSync(dirname(opts.image), { recursive: true });
  const disk = spawnSync(plan.command, plan.args, { encoding: "utf8", stdio: "inherit" });
  if (disk.status !== 0) {
    error(`init-krun-storage: ${commandFailure(plan.command, disk)}`);
    return 1;
  }
  if (!existsSync(opts.mountpoint)) {
    error(`init-krun-storage: ${opts.mountpoint} was not mounted`);
    return 1;
  }

  // krunvm 0.2.6 prompts for this path on first use and exits 255 after
  // persisting it. Bound both time and output because EOF otherwise loops.
  const configured = spawnSync("krunvm", ["config"], {
    input: `${opts.mountpoint}\n`,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const configuredText = `${configured.stdout ?? ""}\n${configured.stderr ?? ""}`;
  const firstUseSuccess = configuredText.includes("The volume has been configured");
  if (configured.status !== 0 && !firstUseSuccess) {
    error(`init-krun-storage: ${commandFailure("krunvm config", configured)}`);
    return 1;
  }

  log(chalk.green(`init-krun-storage: ready — krunvm state is mounted at ${opts.mountpoint}`));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}
