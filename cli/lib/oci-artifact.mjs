// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical OCI identity helpers shared by acquisition, deployment emitters,
// and host-runtime launch-plan lowering. Keep registry-reference precedence in
// one place; callers own presentation and fail/warn policy.

const SHA256 = /^sha256:[0-9a-fA-F]{64}$/;

export function isSha256Digest(value) {
  return typeof value === "string" && SHA256.test(value);
}

/**
 * Split an image reference the way Docker does (ADR-0083 §2). The first
 * component names a registry only if it contains a "." or a ":", or is
 * "localhost". A bare name such as `cloister:0.1.0` has no registry: Docker
 * would read it as Docker Hub's `library/cloister`, an image anyone could
 * publish, so cloister never looks one up in any registry.
 *
 * @param {string} ref
 * @returns {{ registry: string|null, repository: string, tag: string|null, digest: string|null }}
 */
export function parseImageRef(ref) {
  let rest = typeof ref === "string" ? ref.trim() : "";
  let digest = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = null;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const first = rest.split("/")[0];
  const named = rest.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return {
    registry: named ? first : null,
    repository: named ? rest.slice(first.length + 1) : rest,
    tag,
    digest,
  };
}

/**
 * Where a registry's API answers for a repository. Docker Hub's API is at
 * registry-1.docker.io, not docker.io, and its one-component names live under
 * `library/`. Docker applies both rules, so a reference that names docker.io
 * is asked where Docker would ask.
 *
 * @returns {{ host: string, repository: string }}
 */
export function registryApi(registry, repository) {
  if (registry === "docker.io" || registry === "index.docker.io") {
    return { host: "registry-1.docker.io", repository: repository.includes("/") ? repository : `library/${repository}` };
  }
  return { host: registry, repository };
}

/**
 * The lock's pins for operator images (ADR-0083 §2): Map(declared reference →
 * digest), from its `[[images]]` rows. `cluster resolve` writes them.
 */
export function lockedImages(lock) {
  const images = new Map();
  for (const row of Array.isArray(lock?.images) ? lock.images : []) {
    if (typeof row?.ref === "string" && isSha256Digest(row.digest)) images.set(row.ref, row.digest);
  }
  return images;
}

/**
 * An image as a placement runs it (ADR-0083 §1). One the declaration writes
 * with a digest is used as written. One the lock pins is the declared
 * reference with the lock's digest (`name:tag@sha256:…`), so the tag stays
 * readable while the digest is what runs. Otherwise null: nothing pins it.
 *
 * @param {string} ref the declared reference
 * @param {Map<string, string>} images the lock's pins (`lockedImages`)
 */
export function pinnedImage(ref, images = new Map()) {
  const declared = typeof ref === "string" ? ref.trim() : "";
  if (!declared) return null;
  if (parseImageRef(declared).digest) return declared;
  const digest = images.get(declared);
  return digest ? `${declared}@${digest}` : null;
}

export function ociImageRef(oci) {
  if (!oci || typeof oci !== "object") return null;
  const identifier = typeof oci.identifier === "string" ? oci.identifier.trim() : "";
  if (!identifier) return null;
  if (oci.digest) return `${identifier}@${oci.digest}`;
  if (oci.version) return `${identifier}:${oci.version}`;
  return identifier;
}

export function resolveBundleImage(operatorImage, colocatedInputs, ociByInput, bundleName = "", ociByBundle = new Map(), images = new Map()) {
  const override = typeof operatorImage === "string" ? operatorImage.trim() : "";
  // The operator's image wins, run by the lock's digest when the lock pins it
  // (ADR-0083 §1).
  if (override) return pinnedImage(override, images) ?? override;
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
  return { ociByInput, ociByBundle, images: lockedImages(lock) };
}
