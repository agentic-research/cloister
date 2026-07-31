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
import { renderHelp } from "./cli-surface.mjs";

function printHelp(log = console.log) {
  // Derived from scripts/cli-surface.mjs — the SAME declaration that generates
  // docs/reference/cli.md. This list was hardcoded here, which is how `cloister
  // run` could ship while docs/reference/ had no CLI page at all.
  log(renderHelp());
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
  if (command === "skills") {
    const sub = rest[0];
    if (sub === "list" || sub === "pin" || sub === undefined || sub === "--help" || sub === "-h") {
      const { main: skillsMain } = await import("./cli-skills.mjs");
      return skillsMain(rest);
    }
  }
  if (command === "cluster") {
    // The subcommands are named HERE, not only inside cli-cluster.mjs, so
    // `every declared command is actually dispatched` can see them. A bare
    // `cluster` or `cluster --help` also routes, so asking for help works
    // before you know the verbs.
    const sub = rest[0];
    if (sub === "up" || sub === "down" || sub === undefined || sub === "--help" || sub === "-h") {
      const { main: clusterMain } = await import("./cli-cluster.mjs");
      return clusterMain(rest);
    }
  }
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
