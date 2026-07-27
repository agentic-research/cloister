// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStoragePlan,
  parseStorageArgs,
} from "../init-krun-storage.mjs";

test("parseStorageArgs defaults to a bounded project-local sparsebundle", () => {
  assert.deepEqual(
    parseStorageArgs([], "/repo"),
    {
      image: "/repo/.cloister/krunvm.sparsebundle",
      mountpoint: "/Volumes/krunvm",
      size: "3g",
      printOnly: false,
      yes: false,
    },
  );
});

test("parseStorageArgs accepts explicit canonical paths and consent", () => {
  assert.deepEqual(
    parseStorageArgs([
      "--image", "/data/cloister/krun.sparsebundle",
      "--mountpoint", "/Volumes/cloister-krun",
      "--size", "2g",
      "--yes",
    ], "/repo"),
    {
      image: "/data/cloister/krun.sparsebundle",
      mountpoint: "/Volumes/cloister-krun",
      size: "2g",
      printOnly: false,
      yes: true,
    },
  );
  assert.throws(
    () => parseStorageArgs(["--image", "/data/../secret"], "/repo"),
    /canonical/,
  );
});

test("buildStoragePlan delegates image and mount semantics to hdiutil", () => {
  assert.deepEqual(
    buildStoragePlan({
      image: "/repo/.cloister/krunvm.sparsebundle",
      mountpoint: "/Volumes/krunvm",
      size: "3g",
    }),
    {
      command: "hdiutil",
      args: [
        "create",
        "-size", "3g",
        "-type", "SPARSEBUNDLE",
        "-fs", "Case-sensitive APFS",
        "-volname", "krunvm",
        "-attach",
        "/repo/.cloister/krunvm.sparsebundle",
      ],
      mountpoint: "/Volumes/krunvm",
    },
  );
});
