// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference path="./bundle-globals.d.ts" />
//
// Was this module started directly, as `node <this file>`, rather than
// imported?
//
// Several modules here are both a library and a script: `node
// cli/lib/cluster/toml-to-cluster.mjs` runs its `main()`, and `import` of it
// does not. Each one used to decide that for itself by comparing its own
// path with `process.argv[1]`. That comparison is true for EVERY module once
// they are bundled into one file, because they then share one path: the
// bundle's. A bundle of `cloister inspect` ran the main of every module it
// contained, in turn.
//
// So they all ask here, and a bundle build turns the answer off by defining
// `globalThis.__CLOISTER_BUNDLE__` as `true` (gen/bundle.mjs). A bundle has exactly one entry
// point, and it calls what it means to call. `cli/test/started-as-script.test.mjs`
// fails on any module that compares `process.argv[1]` itself.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {string | undefined} [argv1] the script node was started with
 * @returns {boolean}
 */
export function startedAsScript(moduleUrl, argv1 = process.argv[1]) {
  if (globalThis.__CLOISTER_BUNDLE__ === true) return false;
  if (!argv1) return false;
  return fileURLToPath(moduleUrl) === resolve(argv1);
}
