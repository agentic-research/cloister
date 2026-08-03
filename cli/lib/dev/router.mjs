// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertConfigSourcesSafe as defaultAssertConfigSourcesSafe,
  loadLocalEnv as defaultLoadLocalEnv,
} from "./config-sources.mjs";

export class LocalDevError extends Error {}

/** Start the local Worker router directly; Taskfile is only an optional alias. */
/**
 * @param {{root?:string, env?:Record<string,string|undefined>, spawn?:Function,
 *          existsSync?:(path:string)=>boolean, assertConfigSourcesSafe?:Function,
 *          loadLocalEnv?:Function}} [options]
 */
export function startLocalRouter({
  root,
  env = process.env,
  spawn = nodeSpawn,
  existsSync = nodeExistsSync,
  assertConfigSourcesSafe = defaultAssertConfigSourcesSafe,
  loadLocalEnv = defaultLoadLocalEnv,
} = {}) {
  if (!root) throw new LocalDevError("a Cloister checkout directory is required");
  const checkout = resolve(root);
  if (!existsSync(resolve(checkout, ".env.local"))) {
    throw new LocalDevError(
      ".env.local is missing.\nRun: cloister dev bootstrap",
    );
  }
  assertConfigSourcesSafe(checkout);
  const localEnv = loadLocalEnv(checkout, env);
  return spawn("pnpm", ["exec", "wrangler", "dev"], {
    cwd: checkout,
    stdio: "inherit",
    detached: true,
    env: localEnv,
  });
}
