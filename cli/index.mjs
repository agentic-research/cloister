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
import { lloProvision, runLloEnvelope } from "./lib/runtime/llo-client.mjs";
import { main as runMain } from "./commands/run.mjs";
import { renderCommandHelp, renderHelp } from "./surface.mjs";
import { GlobalOptionsError, parseGlobalOptions } from "./lib/global-options.mjs";
import { createOutputContext } from "./lib/output.mjs";

function printHelp(log = console.log) {
  // Derived from cli/surface.mjs — the SAME declaration that generates
  // docs/reference/cli.md. This list was hardcoded here, which is how `cloister
  // run` could ship while docs/reference/ had no CLI page at all.
  log(renderHelp());
}

export async function main(argv = process.argv.slice(2), context = {}) {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;
  const env = context.env ?? process.env;
  let global;
  try {
    global = parseGlobalOptions(argv, env);
  } catch (cause) {
    if (!(cause instanceof GlobalOptionsError)) throw cause;
    stderr.write(`cloister: ${cause.message}\n`);
    return 2;
  }
  const output = createOutputContext({
    stdout,
    stderr,
    env,
    colorMode: global.colorMode,
    json: global.argv[0] === "runtime" && (
      global.argv[1] === "plan" || global.argv.includes("--json")
    ),
  });
  const { log, warn, error } = output;
  const [command, ...rest] = global.argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp(log);
    return 0;
  }
  if (command === "install" || command === "uninstall") {
    const { main: installMain } = await import("./commands/install.mjs");
    return installMain([command, ...rest], {
      log,
      errLog: error,
      env,
    });
  }
  if (command === "run") return runMain(rest, { log, errLog: error, env });
  if (command === "dev") {
    const sub = rest[0];
    if (sub === "bootstrap" || sub === "serve" || sub === "test" || sub === undefined || sub === "--help" || sub === "-h") {
      const { main: devMain } = await import("./commands/dev.mjs");
      return devMain(rest, {
        log,
        errLog: error,
        env,
      });
    }
  }
  if (command === "init") return initMain(["init", ...rest], { log, errLog: error });
  if (command === "add") return addMain(rest, { log, errLog: error });
  if (command === "artifacts" && rest[0] === "pull") {
    return pullMain(rest.slice(1), {
      log,
      warn,
      error,
      style: output.style,
      input: context.stdin ?? process.stdin,
      output: stdout,
    });
  }
  if (command === "skills") {
    const sub = rest[0];
    if (sub === "list" || sub === "pin" || sub === undefined || sub === "--help" || sub === "-h") {
      const { main: skillsMain } = await import("./commands/skills.mjs");
      return skillsMain(rest, { output, env });
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
        env,
      });
    }
  }
  if (command === "runtime" && rest[0] === "plan") {
    return planMain(rest.slice(1), { log, error });
  }
  if (
    command === "runtime" && (
      rest[0] === "install" ||
      rest[0] === "doctor" ||
      ["inspect", "collect", "cancel", "cleanup"].includes(rest[0]) ||
      (rest[0] === "storage" && rest[1] === "status")
    )
  ) {
    const { main: runtimeMain } = await import("./commands/runtime.mjs");
    return runtimeMain(rest, {
      log,
      errLog: error,
      env,
    });
  }
  if (command === "runtime" && (rest.includes("--help") || rest.includes("-h"))) {
    const helpName = rest[0] === "storage"
      ? `runtime storage ${rest[1] ?? "status"}`
      : `runtime ${rest[0] ?? "doctor"}`;
    const declared = [
      "runtime run",
      "runtime doctor",
      "runtime storage status",
      "runtime storage gc",
      "runtime inspect",
      "runtime collect",
      "runtime cancel",
      "runtime cleanup",
    ];
    if (declared.includes(helpName)) {
      log(renderCommandHelp(helpName));
      return 0;
    }
  }
  if (command === "runtime" && rest[0] === "run") {
    if (env.CLOISTER_LLO_CONTROL_SOCKET) {
      try {
        const response = await runLloEnvelope(
          env.CLOISTER_LLO_CONTROL_SOCKET,
          rest[1],
        );
        log(JSON.stringify(response));
        return 0;
      } catch (cause) {
        error(`cloister runtime run: ${cause.message}`);
        return 1;
      }
    }
    return runHostRuntime(["run", ...rest.slice(1)], {
      errLog: error,
      env,
    });
  }
  if (command === "runtime" && rest[0] === "storage" && rest[1] === "init") {
    if (env.CLOISTER_LLO_CONTROL_SOCKET) {
      const args = rest.slice(2);
      const backendFlag = args.indexOf("--backend");
      const backendClass = backendFlag >= 0 ? args[backendFlag + 1] : "microVm";
      const keyFlag = args.indexOf("--idempotency-key");
      const idempotencyKey = keyFlag >= 0 ? args[keyFlag + 1] : undefined;
      if (args.includes("--help") || args.includes("-h")) {
        log("Usage: cloister runtime storage init --idempotency-key <key> [--backend native|microVm]");
        return 0;
      }
      if (!idempotencyKey || keyFlag + 1 >= args.length || idempotencyKey.startsWith("--")) {
        error("cloister runtime storage init: --idempotency-key is required for the LLO provider");
        return 2;
      }
      if (backendFlag >= 0 && (!backendClass || backendClass.startsWith("--"))) {
        error("cloister runtime storage init: --backend requires native or microVm");
        return 2;
      }
      const known = new Set(["--backend", backendClass, "--idempotency-key", idempotencyKey]);
      const unknown = args.find((arg) => !known.has(arg));
      if (unknown) {
        error(`cloister runtime storage init: unknown argument ${unknown}`);
        return 2;
      }
      try {
        const provision = context.lloProvision ?? lloProvision;
        const response = await provision(
          env.CLOISTER_LLO_CONTROL_SOCKET,
          backendClass,
          idempotencyKey,
          context,
        );
        log(JSON.stringify(response));
        return 0;
      } catch (cause) {
        error(`cloister runtime storage init: ${cause.message}`);
        return 1;
      }
    }
    return storageMain(rest.slice(2), {
      log,
      error,
      style: output.style,
      input: context.stdin ?? process.stdin,
      output: stdout,
    });
  }
  if (command === "runtime" && rest[0] === "storage" && rest[1] === "gc") {
    return runHostRuntime(["gc", ...rest.slice(2)], {
      errLog: error,
      env,
    });
  }

  error(`cloister: unknown command: ${global.argv.join(" ")}`);
  error("");
  printHelp(error);
  return 2;
}
