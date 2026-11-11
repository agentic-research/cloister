// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OCI platforms, and how a recorded rootfs is matched to the guest platform
// this host boots (cloister-1c4ef5). Pure: the platform itself comes from
// guest-platform.mjs.
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

/**
 * Whether a rootfs recorded for platform `recorded` is one this host's guest
 * platform `host` runs. Mirrors LLO's `Platform::admits` (artifacts/oci.rs),
 * the rule its importer uses to pick an index entry: os and architecture must
 * be equal; a host platform with no variant admits any variant; `arm64` with
 * no variant is `arm64/v8`, as the image spec defines it.
 */
export function platformAdmits(host, recorded) {
  const h = parsePlatform(host);
  const r = parsePlatform(recorded);
  if (!h || !r) return false;
  if (h.os !== r.os || h.architecture !== r.architecture) return false;
  if (h.variant === null) return true;
  const normalized = (architecture, variant) =>
    architecture === "arm64" && variant === null ? "v8" : variant;
  return normalized(r.architecture, r.variant) === normalized(h.architecture, h.variant);
}

