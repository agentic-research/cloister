// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the microVM tier's CAS lives, and whether a rootfs is in it
// (cloister-991e65). The same precedence the host runtime is started with
// (compatibility-client.mjs `hostRuntimeEnv`): an explicit CLOISTER_CAS_ROOT
// wins, otherwise the installed provider record names it. LLO publishes a
// rootfs as the directory `<casRoot>/<blake3 hex>`.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInstallLayout } from "../install-layout.mjs";
import { readProviderRecord } from "./provider-record.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The CAS root the host runtime will load rootfs trees from. */
export function resolveCasRoot(env = process.env) {
  if (env.CLOISTER_CAS_ROOT) return env.CLOISTER_CAS_ROOT;
  const record = readProviderRecord(resolveInstallLayout({ env, checkoutRoot: REPO_ROOT }));
  const casRoot = record?.microvm?.casRoot;
  if (!casRoot) {
    throw new Error(
      "the installed runtime records no microVM CAS root.\nRun: cloister runtime install",
    );
  }
  return casRoot;
}

/** A `rootfsInCas(hex)` checker bound to the resolved CAS root (lazily). */
export function casRootInCas(env = process.env) {
  return (hex) => {
    const casRoot = resolveCasRoot(env);
    const dir = join(casRoot, hex);
    let present = false;
    try {
      present = existsSync(dir) && statSync(dir).isDirectory();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { present, casRoot };
  };
}
