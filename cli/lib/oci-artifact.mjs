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
