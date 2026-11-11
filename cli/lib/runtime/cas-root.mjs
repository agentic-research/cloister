// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The microVM tier's CAS, as the CLI sees it (cloister-991e65, cloister-727354).
//
// The provider record written by `cloister runtime install` is the ONE place
// the CAS root is decided. Every CLI reader (runtime plan, cluster up, runtime
// import, storage status) goes through here, which:
//
//   1. refuses a CLOISTER_CAS_ROOT that disagrees with the record — it is not
//      a supported knob for the CLI path; a stale value used to pass plan and
//      then fail at run with a remedy that could not work;
//   2. re-attaches the CAS volume through the host runtime's `cas-attach`
//      (LLO attach_existing: never creates). A volume a reboot or logout
//      detached would otherwise read as "rootfs not in the CAS", and the
//      remedy offered — re-import — re-downloads the image for nothing;
//   3. says, in one line, when the install predates the volume (a plain,
//      case-insensitive directory): static images still work there, so it
//      warns rather than refuses.
//
// LLO publishes a rootfs as the directory `<casRoot>/<blake3 hex>`.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveInstallLayout } from "../install-layout.mjs";
import { readProviderRecord } from "./provider-record.mjs";
import { runCompatibilityJson } from "./compatibility-client.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The CAS is not usable as recorded, and the message says what to run. */
export class CasUnavailableError extends Error {}

/** CLOISTER_CAS_ROOT must agree with the record, or not be set. */
export function assertNoCasRootOverride(env, recordedCasRoot) {
  if (env.CLOISTER_CAS_ROOT && env.CLOISTER_CAS_ROOT !== recordedCasRoot) {
    throw new CasUnavailableError(
      `CLOISTER_CAS_ROOT=${env.CLOISTER_CAS_ROOT} differs from the installed runtime's CAS root ` +
        `${recordedCasRoot}. The provider record decides the CAS root for the CLI: unset ` +
        "CLOISTER_CAS_ROOT, or re-run `cloister runtime install`.",
    );
  }
}

/**
 * Make the recorded CAS usable, then return it with a presence checker.
 *
 * @param {object} [o]
 * @param {Record<string,string|undefined>} [o.env]
 * @param {() => any} [o.readRecord] returns the provider record (tests)
 * @param {(args: string[], deps: object) => {data: any}} [o.runJson] host-runtime JSON call (tests)
 * @param {(line: string) => void} [o.warn]
 * @returns {{casRoot: string, rootfsInCas: (hex: string) => {present: boolean, casRoot: string}}}
 */
export function prepareCas({
  env = process.env,
  readRecord,
  runJson = runCompatibilityJson,
  warn = (line) => console.error(line),
} = {}) {
  const record = readRecord
    ? readRecord()
    : readProviderRecord(resolveInstallLayout({ env, checkoutRoot: REPO_ROOT }));
  const microvm = record?.microvm;
  if (!microvm?.casRoot) {
    throw new CasUnavailableError(
      "the installed runtime records no microVM CAS root.\nRun: cloister runtime install",
    );
  }
  assertNoCasRootOverride(env, microvm.casRoot);
  if (!microvm.casStateDir) {
    warn(
      `cloister: this install predates the case-sensitive CAS volume: ${microvm.casRoot} is a plain ` +
        "directory, where images with case-colliding names (Debian's perl) cannot import. " +
        "Run: cloister runtime install",
    );
  } else {
    const reply = runJson(["cas-attach", "--state-dir", microvm.casStateDir], { env }).data;
    if (!reply?.provisioned) {
      throw new CasUnavailableError(
        `the provider record names a CAS volume under ${microvm.casStateDir}, but none is ` +
          "provisioned there (it was removed?).\nRun: cloister runtime install",
      );
    }
    if (reply.volume?.casRoot !== microvm.casRoot) {
      throw new CasUnavailableError(
        `the CAS volume under ${microvm.casStateDir} has root ${reply.volume?.casRoot}, but the ` +
          `provider record says ${microvm.casRoot}.\nRun: cloister runtime install`,
      );
    }
  }
  const casRoot = microvm.casRoot;
  return {
    casRoot,
    rootfsInCas: (hex) => {
      const dir = join(casRoot, hex);
      let present = false;
      try {
        present = existsSync(dir) && statSync(dir).isDirectory();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { present, casRoot };
    },
  };
}

/**
 * A `rootfsInCas(hex)` that prepares the CAS on first use, so a command that
 * never touches a microvm bundle (a process plan) neither needs the runtime
 * installed nor attaches anything.
 */
export function lazyRootfsInCas(options = {}) {
  let prepared = null;
  return (hex) => {
    prepared ??= prepareCas(options);
    return prepared.rootfsInCas(hex);
  };
}
