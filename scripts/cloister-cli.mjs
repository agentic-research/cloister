#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Package-level Cloister CLI dispatcher. Individual commands retain their
// focused modules; this file is the stable executable declared in package.json.

import { main as initMain } from "./cli-init.mjs";
import { main as addMain } from "./cli-add.mjs";
import { main as pullMain } from "./pull-inputs.mjs";

function printHelp(log = console.log) {
  log("Usage: cloister <command> [options]");
  log("");
  log("Commands:");
  log("  cloister init ...             Scaffold a cluster recipe");
  log("  cloister add ...              Add and resolve a tool input");
  log("  cloister artifacts pull ...   Acquire lockfile-pinned OCI artifacts");
  log("");
  log("Run `cloister <command> --help` for command-specific options.");
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "init") return initMain(["init", ...rest]);
  if (command === "add") return addMain(rest);
  if (command === "artifacts" && rest[0] === "pull") return pullMain(rest.slice(1));

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
