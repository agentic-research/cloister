// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The guest platform this host boots (cloister-1c4ef5). One source: the host
// runtime's `guest-platform` verb, which prints LLO's `Platform::host()` — the
// same value `import-oci` asks LLO to select from an image index. Nothing in
// the CLI derives a platform from `process.arch`.

import { runCompatibilityJson } from "./compatibility-client.mjs";
import { isPlatform } from "./platform.mjs";

/**
 * Ask the host runtime which guest platform it boots.
 * @param {{env?: object, runJson?: Function}} [o]
 */
export function probeGuestPlatform({ env = process.env, runJson = runCompatibilityJson } = {}) {
  let platform;
  try {
    platform = runJson(["guest-platform"], { env }).data?.platform;
  } catch (error) {
    throw new Error(
      `could not ask the host runtime which guest platform it boots (${error.message}). An ` +
        "installed runtime from before cloister-1c4ef5 has no `guest-platform` verb.\n" +
        "Run: cloister runtime install",
    );
  }
  if (!isPlatform(platform)) {
    throw new Error(
      `the host runtime reported guest platform ${JSON.stringify(platform)}, not os/architecture[/variant]`,
    );
  }
  return platform;
}

/**
 * Ask the host runtime, which asks LLO's `Platform::admits`, which of
 * `candidates` a host platform `platform` admits, and which overlap it (either
 * admits the other). Nothing here states the rule (cloister-b94b14).
 * @param {string} platform
 * @param {string[]} candidates
 * @param {{env?: object, runJson?: Function}} [o]
 * @returns {{admitted: string[], overlapping: string[]}}
 */
export function queryPlatformAdmits(platform, candidates, { env = process.env, runJson = runCompatibilityJson } = {}) {
  // No candidates: the answer cannot depend on the runtime, so do not spawn it.
  if (candidates.length === 0) return { admitted: [], overlapping: [] };
  const stale =
    "An installed runtime from before cloister-b94b14 has no `platform-admits` verb.\n" +
    "Run: cloister runtime install";
  let data;
  try {
    data = runJson(["platform-admits", "--platform", platform, ...candidates], { env }).data;
  } catch (error) {
    throw new Error(
      `could not ask the host runtime which platforms ${platform} admits (${error.message}). ${stale}`,
    );
  }
  const subset = (list) =>
    Array.isArray(list) && list.every((p) => typeof p === "string" && candidates.includes(p));
  if (!subset(data?.admitted) || !subset(data?.overlapping)) {
    throw new Error(
      `the host runtime's platform-admits reply is not two lists of the candidates it was asked about ` +
        `(${JSON.stringify(data)}). ${stale}`,
    );
  }
  return { admitted: data.admitted, overlapping: data.overlapping };
}

/** A `() => platform` that asks the host runtime once, on first use. */
export function lazyGuestPlatform(options = {}) {
  let platform = null;
  return () => {
    platform ??= probeGuestPlatform(options);
    return platform;
  };
}
