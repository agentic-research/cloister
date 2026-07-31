#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolve } from "node:path";

import { bootstrapLocalDev as defaultBootstrapLocalDev } from "../lib/dev/bootstrap.mjs";
import { startLocalRouter as defaultStartLocalRouter } from "../lib/dev/router.mjs";
import { renderCommandHelp } from "../surface.mjs";

export class DevUsageError extends Error {}

function parse(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { help: true, subcommand: null, root: process.cwd() };
  }
  if (subcommand !== "bootstrap" && subcommand !== "serve") {
    throw new DevUsageError(`unknown dev command ${JSON.stringify(subcommand)}`);
  }
  let root = process.cwd();
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--dir") {
      const value = rest[++i];
      if (!value || value.startsWith("--")) throw new DevUsageError("--dir requires a value");
      root = value;
      continue;
    }
    throw new DevUsageError(`unknown option ${JSON.stringify(arg)}`);
  }
  return { help, subcommand, root: resolve(root) };
}

export function waitForChild(child) {
  return new Promise((resolveExit, reject) => {
    const signals = ["SIGINT", "SIGTERM"];
    const forward = (signal) => {
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* child already exited */ }
    };
    for (const signal of signals) process.once(signal, forward);
    const cleanup = () => {
      for (const signal of signals) process.removeListener(signal, forward);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    if (!(error instanceof DevUsageError)) throw error;
    errLog(`cloister dev: ${error.message}`);
    return 2;
  }

  if (args.help) {
    if (args.subcommand) log(renderCommandHelp(`dev ${args.subcommand}`));
    else log(`${renderCommandHelp("dev bootstrap")}\n\n${renderCommandHelp("dev serve")}`);
    return 0;
  }

  try {
    if (args.subcommand === "bootstrap") {
      await (deps.bootstrapLocalDev ?? defaultBootstrapLocalDev)({
        root: args.root,
        env: deps.env ?? process.env,
        log,
      });
      return 0;
    }
    const child = (deps.startLocalRouter ?? defaultStartLocalRouter)({
      root: args.root,
      env: deps.env ?? process.env,
    });
    return await (deps.waitForChild ?? waitForChild)(child);
  } catch (error) {
    errLog(`cloister dev: ${error.message}`);
    return 1;
  }
}
