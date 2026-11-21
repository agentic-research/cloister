// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  isSha256Digest,
  ociBundleClaims,
  ociImageRef,
  ociPins,
  resolveBundleImage,
} from "../../lib/oci-artifact.mjs";

test("ociImageRef applies the one digest-version-bare precedence", () => {
  assert.equal(
    ociImageRef({
      identifier: " ghcr.io/art/mache ",
      version: "0.17.0",
      digest: `sha256:${"a".repeat(64)}`,
    }),
    `ghcr.io/art/mache@sha256:${"a".repeat(64)}`,
  );
  assert.equal(
    ociImageRef({ identifier: "ghcr.io/art/mache", version: "0.17.0" }),
    "ghcr.io/art/mache:0.17.0",
  );
  assert.equal(ociImageRef({ identifier: "ghcr.io/art/mache" }), "ghcr.io/art/mache");
  assert.equal(ociImageRef({ identifier: " " }), null);
});

test("isSha256Digest accepts only a complete sha256 content address", () => {
  assert.equal(isSha256Digest(`sha256:${"0".repeat(64)}`), true);
  assert.equal(isSha256Digest("sha256:abc"), false);
  assert.equal(isSha256Digest(`sha512:${"0".repeat(64)}`), false);
});

test("resolveBundleImage preserves operator override then linked-input order", () => {
  const images = new Map([
    ["mache", {
      identifier: "ghcr.io/art/mache",
      digest: `sha256:${"b".repeat(64)}`,
    }],
  ]);

  assert.equal(
    resolveBundleImage("registry.example/mache:operator", ["mache"], images),
    "registry.example/mache:operator",
  );
  assert.equal(
    resolveBundleImage("", ["missing", "mache"], images),
    `ghcr.io/art/mache@sha256:${"b".repeat(64)}`,
  );
  assert.equal(resolveBundleImage("", ["missing"], images), null);
});

test("resolveBundleImage: a per-bundle declaration outranks the input-level pin", () => {
  // The case the input-level map cannot express. notme publishes two images and
  // states which bundle runs which; the input-level `oci` is merely the FIRST
  // artifact, so both bundles would otherwise resolve to `.../notme` — one of
  // them silently WRONG rather than merely missing (cloister-370eac).
  const byInput = new Map([["notme", {
    identifier: "ghcr.io/agentic-research/notme", digest: `sha256:${"a".repeat(64)}`,
  }]]);
  const byBundle = new Map([["notme-proxy", {
    identifier: "ghcr.io/agentic-research/notme-proxy", digest: `sha256:${"c".repeat(64)}`,
  }]]);

  assert.equal(
    resolveBundleImage("", ["notme"], byInput, "notme-proxy", byBundle),
    `ghcr.io/agentic-research/notme-proxy@sha256:${"c".repeat(64)}`,
  );
  // A bundle with no declaration of its own still falls back to the input pin,
  // so the four single-image inputs are unaffected.
  assert.equal(
    resolveBundleImage("", ["notme"], byInput, "notme-identity", byBundle),
    `ghcr.io/agentic-research/notme@sha256:${"a".repeat(64)}`,
  );
  // An operator override still wins over both — it is the only rung above them.
  assert.equal(
    resolveBundleImage("pinned:1.0", ["notme"], byInput, "notme-proxy", byBundle),
    "pinned:1.0",
  );
  // And the pre-existing two-argument callers keep their exact behaviour.
  assert.equal(
    resolveBundleImage("", ["notme"], byInput),
    `ghcr.io/agentic-research/notme@sha256:${"a".repeat(64)}`,
  );
});

// ── the one reading of a lock's image pins ───────────────────────────────

const DIGEST = (c) => `sha256:${c.repeat(64)}`;

test("ociBundleClaims maps each bundle a multi-image producer names to its row", () => {
  const dolt = { bundle: "dolt", identifier: "x/dolt", digest: DIGEST("a") };
  const orders = { bundle: "orders", identifier: "x/orders", digest: DIGEST("b") };
  const claims = ociBundleClaims({ inputs: {
    producer: { oci: { identifier: "x/producer", digest: DIGEST("9") }, ociBundles: [dolt, orders] },
    single: { oci: { identifier: "x/single", digest: DIGEST("c") } },
  } });
  assert.deepEqual([...claims.keys()], ["dolt", "orders"]);
  // The row itself, not a copy: runtime import records rootfs rows onto it.
  assert.equal(claims.get("dolt").row, dolt);
  assert.equal(claims.get("dolt").input, "producer");
});

test("ociBundleClaims skips rows naming no bundle and reads an absent lock as none", () => {
  const claims = ociBundleClaims({ inputs: { p: { ociBundles: [null, { identifier: "x" }, { bundle: "" }, { bundle: 7 }] } } });
  assert.equal(claims.size, 0);
  for (const lock of [undefined, null, {}, { inputs: {} }]) assert.equal(ociBundleClaims(lock).size, 0);
});

test("ociBundleClaims refuses two producers naming one bundle, naming both", () => {
  const lock = { inputs: {
    a: { ociBundles: [{ bundle: "dolt", identifier: "x/dolt" }] },
    b: { ociBundles: [{ bundle: "dolt", identifier: "y/dolt" }] },
  } };
  assert.throws(
    () => ociBundleClaims(lock),
    /bundle "dolt" is pinned by two multi-image producers, \[\[inputs.a.ociBundles\]\] and \[\[inputs.b.ociBundles\]\]; which one runs it would be a guess/,
  );
});

test("ociPins gives compose and the lint the maps resolveBundleImage reads", () => {
  const lock = { inputs: {
    notme: {
      oci: { identifier: "ghcr.io/o/notme", digest: DIGEST("a") },
      ociBundles: [
        { bundle: "notme-identity", identifier: "ghcr.io/o/notme", digest: DIGEST("a") },
        { bundle: "notme-proxy", identifier: "ghcr.io/o/notme-proxy", digest: DIGEST("b") },
        { bundle: "unnamed-image" },
      ],
    },
    mache: { oci: { identifier: "ghcr.io/o/mache", digest: DIGEST("c") } },
    docs: { sha256: "sha256:1" },
  } };
  const { ociByInput, ociByBundle } = ociPins(lock);
  assert.deepEqual([...ociByInput.keys()], ["notme", "mache"]);
  assert.deepEqual([...ociByBundle.keys()], ["notme-identity", "notme-proxy"], "a row with no identifier pins nothing");
  assert.equal(
    resolveBundleImage("", ["notme"], ociByInput, "notme-proxy", ociByBundle),
    `ghcr.io/o/notme-proxy@${DIGEST("b")}`,
  );
});
