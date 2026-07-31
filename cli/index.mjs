#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Product-level Cloister CLI dispatcher. bin/cloister.mjs is the installed
// executable; this module owns command routing and remains importable in tests.

import { main as initMain } from "./commands/init.mjs";
import { main as addMain } from "./commands/add.mjs";
import { main as pullMain } from "./commands/artifacts-pull.mjs";
import { main as planMain } from "./commands/runtime-plan.mjs";
import { main as storageMain } from "./commands/runtime-storage-init.mjs";
import { runHostRuntime } from "./lib/runtime/compatibility-client.mjs";
import { main as runMain } from "./commands/run.mjs";
import { renderHelp } from "./surface.mjs";

function printHelp(log = console.log) {
  // Derived from cli/surface.mjs — the SAME declaration that generates
  // docs/reference/cli.md. This list was hardcoded here, which is how `cloister
  // run` could ship while docs/reference/ had no CLI page at all.
  log(renderHelp());
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;
  const log = (value) => stdout.write(`${value}\n`);
  const error = (value) => stderr.write(`${value}\n`);
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp(log);
    return 0;
  }
  if (command === "run") return runMain(rest);
  if (command === "init") return initMain(["init", ...rest]);
  if (command === "add") return addMain(rest);
  if (command === "artifacts" && rest[0] === "pull") return pullMain(rest.slice(1));
  if (command === "skills") {
    const sub = rest[0];
    if (sub === "list" || sub === "pin" || sub === undefined || sub === "--help" || sub === "-h") {
      const { main: skillsMain } = await import("./commands/skills.mjs");
      return skillsMain(rest);
    }
  }
  if (command === "cluster") {
    // The subcommands are named HERE, not only inside cli-cluster.mjs, so
    // `every declared command is actually dispatched` can see them. A bare
    // `cluster` or `cluster --help` also routes, so asking for help works
    // before you know the verbs.
    const sub = rest[0];
    if (sub === "generate" || sub === "resolve" || sub === "up" || sub === "down" || sub === undefined || sub === "--help" || sub === "-h") {
      const { main: clusterMain } = await import("./commands/cluster.mjs");
      return clusterMain(rest, {
        log,
        errLog: error,
        env: context.env ?? process.env,
      });
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

  error(`cloister: unknown command: ${argv.join(" ")}`);
  error("");
  printHelp(error);
  return 2;
}
