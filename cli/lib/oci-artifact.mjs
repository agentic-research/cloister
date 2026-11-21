// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical OCI identity helpers shared by acquisition, deployment emitters,
// and host-runtime launch-plan lowering. Keep registry-reference precedence in
// one place; callers own presentation and fail/warn policy.

const SHA256 = /^sha256:[0-9a-fA-F]{64}$/;

export function isSha256Digest(value) {
  return typeof value === "string" && SHA256.test(value);
}

export function ociImageRef(oci) {
  if (!oci || typeof oci !== "object") return null;
  const identifier = typeof oci.identifier === "string" ? oci.identifier.trim() : "";
  if (!identifier) return null;
  if (oci.digest) return `${identifier}@${oci.digest}`;
  if (oci.version) return `${identifier}:${oci.version}`;
  return identifier;
}

export function resolveBundleImage(operatorImage, colocatedInputs, ociByInput, bundleName = "", ociByBundle = new Map()) {
  const override = typeof operatorImage === "string" ? operatorImage.trim() : "";
  if (override) return override;
  // A multi-image producer names WHICH bundle runs WHICH image, and that
  // mapping is not derivable from the addresses: notme's `notme-identity`
  // bundle runs image `.../notme`. Basename matching would bind it to nothing
  // — or to the wrong image without saying so. Checked BEFORE the per-input
  // fallback, because for such a producer the input-level `oci` is merely its
  // first artifact (cloister-370eac).
  if (bundleName) {
    const byBundle = ociImageRef(ociByBundle.get(bundleName));
    if (byBundle) return byBundle;
  }
  for (const inputName of colocatedInputs) {
    const ref = ociImageRef(ociByInput.get(inputName));
    if (ref) return ref;
  }
  return null;
}

/**
 * Which multi-image producer pins which bundle, from a parsed lock:
 * Map(bundle → {input, row}) over every `[[inputs.<input>.ociBundles]]` row.
 *
 * A producer that publishes several images names which bundle runs which
 * (resolve-inputs records `_meta["art.cloister/v1"].bundles[]` there), and that
 * mapping is not derivable from the image addresses. This is the one reading
 * of it: compose and the isolation lint read it through `ociPins`, and the
 * runtime through `lockedPin` (runtime/rootfs-lock.mjs). Two producers naming
 * one bundle are refused by name, since which one runs it would be a guess.
 */
export function ociBundleClaims(lock) {
  const claims = new Map();
  for (const [input, row] of Object.entries(lock?.inputs ?? {})) {
    for (const entry of row?.ociBundles ?? []) {
      if (!entry || typeof entry !== "object" || typeof entry.bundle !== "string" || entry.bundle === "") continue;
      const prior = claims.get(entry.bundle);
      if (prior) {
        throw new Error(
          `bundle "${entry.bundle}" is pinned by two multi-image producers, ` +
            `[[inputs.${prior.input}.ociBundles]] and [[inputs.${input}.ociBundles]]; ` +
            `which one runs it would be a guess`,
        );
      }
      claims.set(entry.bundle, { input, row: entry });
    }
  }
  return claims;
}

/**
 * Every image pin in a parsed lock, as the two maps `resolveBundleImage`
 * reads: each input's own `oci`, and each bundle a multi-image producer names.
 */
export function ociPins(lock) {
  const ociByInput = new Map();
  for (const [name, row] of Object.entries(lock?.inputs ?? {})) {
    if (row && typeof row === "object" && row.oci && row.oci.identifier) ociByInput.set(name, row.oci);
  }
  const ociByBundle = new Map();
  for (const [bundle, { row }] of ociBundleClaims(lock)) {
    if (row.identifier) ociByBundle.set(bundle, row);
  }
  return { ociByInput, ociByBundle };
}
