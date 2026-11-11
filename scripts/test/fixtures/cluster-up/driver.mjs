// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs `clusterUp` in its own process with the fake host runtime, so tests can
// send it REAL signals (and SIGKILL it). Usage: node driver.mjs <cluster-dir>
// Prints "UP EXIT <code>" and exits with that code.

import { join } from "node:path";
import { clusterUp } from "../../../../cli/lib/cluster/up.mjs";

const fake = join(import.meta.dirname, "fake-host-runtime.mjs");
const code = await clusterUp({
  root: process.argv[2],
  env: "local",
  deps: {
    rootfsInCas: () => ({ present: true, casRoot: "/cas" }),
    guestPlatform: () => "linux/arm64",
    hostRuntime: { command: process.execPath, args: [fake], env: process.env },
    pollMs: 10,
  },
});
console.log(`UP EXIT ${code}`);
process.exit(code);
