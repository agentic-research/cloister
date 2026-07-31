#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function run(argv = process.argv.slice(2), io = process) {
  try {
    const { main } = await import("../cli/index.mjs");
    return await main(argv, {
      stdout: io.stdout,
      stderr: io.stderr,
      env: io.env,
    });
  } catch (error) {
    io.stderr.write(`cloister: ${error.message}\n`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))
);

if (invokedDirectly) {
  process.exitCode = await run();
}
