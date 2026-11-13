// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OCI platform strings: shape checks only (cloister-1c4ef5). Whether one
// platform admits another is NOT decided here or anywhere in JS: the host
// runtime's `platform-admits` verb answers it with LLO's `Platform::admits`
// (cloister-b94b14; see guest-platform.mjs `queryPlatformAdmits`).
//
// Platforms are OCI's `os/architecture[/variant]` strings, kept exactly as LLO
// reports them (`linux/arm64`, `linux/arm/v7`, `linux/arm64/v8`).

/** `os/architecture[/variant]` from LLO's serialized Platform object. */
export function formatPlatform(platform) {
  if (
    !platform ||
    typeof platform.os !== "string" || platform.os === "" ||
    typeof platform.architecture !== "string" || platform.architecture === ""
  ) {
    return null;
  }
  const variant = typeof platform.variant === "string" && platform.variant !== "" ? `/${platform.variant}` : "";
  return `${platform.os}/${platform.architecture}${variant}`;
}

function parsePlatform(text) {
  const parts = typeof text === "string" ? text.split("/") : [];
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === "")) return null;
  return { os: parts[0], architecture: parts[1], variant: parts[2] ?? null };
}

/** True for a well-formed `os/architecture[/variant]`. */
export function isPlatform(text) {
  return parsePlatform(text) !== null;
}
