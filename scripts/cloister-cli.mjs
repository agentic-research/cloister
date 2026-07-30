#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Package-level Cloister CLI dispatcher. Individual commands retain their
// focused modules; this file is the stable executable declared in package.json.

import { main as initMain } from "./cli-init.mjs";
import { main as addMain } from "./cli-add.mjs";
import { main as pullMain } from "./pull-inputs.mjs";
import { main as planMain } from "./emit-host-launch-plan.mjs";
import { main as storageMain } from "./init-krun-storage.mjs";
import { runHostRuntime } from "./host-runtime-cli.mjs";
import { main as runMain } from "./cli-run.mjs";

function printHelp(log = console.log) {
  log("Usage: cloister <command> [options]");
  log("");
  log("Commands:");
  log("  cloister run ...              Run a harness confined to one repo");
  log("  cloister init ...             Scaffold a cluster recipe");
  log("  cloister add ...              Add and resolve a tool input");
  log("  cloister artifacts pull ...   Acquire lockfile-pinned OCI artifacts");
  log("  cloister runtime plan ...     Emit a fail-closed host launch plan");
  log("  cloister runtime run ...      Run a plan through the krunvm backend");
  log("  cloister runtime doctor       Check runtime prerequisites and storage");
  log("  cloister runtime storage init Create/attach bounded krunvm storage");
  log("  cloister runtime storage status Show bounded storage state");
  log("  cloister runtime storage gc   Preview or execute safe reclamation");
  log("");
  log("Run `cloister <command> --help` for command-specific options.");
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "run") return runMain(rest);
  if (command === "init") return initMain(["init", ...rest]);
  if (command === "add") return addMain(rest);
  if (command === "artifacts" && rest[0] === "pull") return pullMain(rest.slice(1));
  if (command === "runtime" && rest[0] === "plan") return planMain(rest.slice(1));
  if (command === "runtime" && rest[0] === "run") {
    return runHostRuntime(["run", ...rest.slice(1)]);
  }
  if (command === "runtime" && rest[0] === "doctor") {
    return runHostRuntime(["doctor", ...rest.slice(1)]);
  }
  if (command === "runtime" && rest[0] === "storage" && rest[1] === "init") {
    return storageMain(rest.slice(2));
  }
  if (command === "runtime" && rest[0] === "storage" && rest[1] === "status") {
    return runHostRuntime(["status", ...rest.slice(2)]);
  }
  if (command === "runtime" && rest[0] === "storage" && rest[1] === "gc") {
    return runHostRuntime(["gc", ...rest.slice(2)]);
  }

  console.error(`cloister: unknown command: ${argv.join(" ")}`);
  console.error("");
  printHelp(console.error);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`cloister: unexpected error: ${e.message}`);
    process.exit(2);
  },
);
