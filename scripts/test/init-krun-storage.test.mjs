// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStoragePlan,
  main,
  parseStorageArgs,
} from "../init-krun-storage.mjs";

// Sparsebundles are an APFS/hdiutil concept, so this command is macOS-only.
// The host platform is injected rather than read from process.platform so BOTH
// branches are exercised on every host: the macOS path stayed untested on Linux
// CI, and the refusal path stayed untested on macOS dev machines — which is how
// a Linux-only failure reached CI green-on-macOS. cloister-6d7af4.
async function runMain(argv, platform) {
  const out = [];
  const errs = [];
  const code = await main(argv, {
    platform,
    log: (m) => out.push(String(m)),
    error: (m) => errs.push(String(m)),
  });
  return { code, stdout: out.join("\n"), stderr: errs.join("\n") };
}

test("storage init refuses on a non-darwin host instead of planning hdiutil", async () => {
  const r = await runMain(["--print"], "linux");
  assert.equal(r.code, 2, `expected refusal exit 2, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /macOS-only/);
  assert.doesNotMatch(r.stdout, /hdiutil/, "must not emit an hdiutil plan it cannot run");
});

test("storage init still previews the plan on darwin", async () => {
  const r = await runMain(["--print"], "darwin");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /krunvm storage plan/);
  assert.match(r.stdout, /host storage unchanged/);
});

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
