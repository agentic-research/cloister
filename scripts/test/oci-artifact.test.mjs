// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  isSha256Digest,
  ociImageRef,
  resolveBundleImage,
} from "../lib/oci-artifact.mjs";

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
