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

/** A `() => platform` that asks the host runtime once, on first use. */
export function lazyGuestPlatform(options = {}) {
  let platform = null;
  return () => {
    platform ??= probeGuestPlatform(options);
    return platform;
  };
}
