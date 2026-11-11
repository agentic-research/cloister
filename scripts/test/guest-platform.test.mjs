// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The guest platform and how a recorded rootfs row is matched to it
// (cloister-1c4ef5). The probe runs a real executable standing in for the
// host runtime's `guest-platform` verb, through the real runCompatibilityJson.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatPlatform, isPlatform, platformAdmits, platformsOverlap } from "../../cli/lib/runtime/platform.mjs";
import { lazyGuestPlatform, probeGuestPlatform } from "../../cli/lib/runtime/guest-platform.mjs";

test("formatPlatform renders LLO's Platform object exactly, variant included", () => {
  assert.equal(formatPlatform({ os: "linux", architecture: "arm64" }), "linux/arm64");
  assert.equal(formatPlatform({ os: "linux", architecture: "arm64", variant: "v8" }), "linux/arm64/v8");
  for (const bad of [undefined, null, {}, { os: "linux" }, { os: "", architecture: "amd64" }]) {
    assert.equal(formatPlatform(bad), null, JSON.stringify(bad));
  }
});

test("isPlatform accepts os/architecture[/variant] only", () => {
  for (const ok of ["linux/amd64", "linux/arm/v7", "linux/arm64/v8"]) assert.equal(isPlatform(ok), true, ok);
  for (const bad of ["arm64", "linux/", "/arm64", "linux/arm64/v8/x", "", null]) assert.equal(isPlatform(bad), false, String(bad));
});

test("platformAdmits mirrors LLO's Platform::admits", () => {
  const cases = [
    ["linux/arm64", "linux/arm64", true],
    ["linux/arm64", "linux/arm64/v8", true], // no host variant admits any
    ["linux/arm64", "linux/amd64", false],
    ["linux/arm64", "darwin/arm64", false],
    ["linux/arm64/v8", "linux/arm64", true], // arm64 without a variant is v8
    ["linux/arm64/v8", "linux/arm64/v9", false],
    ["linux/arm/v7", "linux/arm/v6", false],
    ["linux/arm/v7", "linux/arm", false],
    ["nonsense", "linux/arm64", false],
  ];
  for (const [host, recorded, expected] of cases) {
    assert.equal(platformAdmits(host, recorded), expected, `${host} admits ${recorded}`);
  }
});

function fakeHostRuntime(t, stdout) {
  const dir = mkdtempSync(join(tmpdir(), "guest-platform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argv = join(dir, "argv");
  const bin = join(dir, "host-runtime");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argv}'\ncat <<'JSON'\n${stdout}\nJSON\n`);
  chmodSync(bin, 0o755);
  return { env: { CLOISTER_HOST_RUNTIME_BIN: bin }, argv };
}

test("probeGuestPlatform asks the host runtime, and lazyGuestPlatform asks once", (t) => {
  const f = fakeHostRuntime(t, JSON.stringify({ platform: "linux/arm64" }));
  assert.equal(probeGuestPlatform({ env: f.env }), "linux/arm64");
  const lazy = lazyGuestPlatform({ env: f.env });
  lazy();
  lazy();
  assert.deepEqual(readFileSync(f.argv, "utf8").trim().split("\n"), ["guest-platform", "guest-platform"]);
});

test("a malformed guest platform from the host runtime is refused", (t) => {
  const f = fakeHostRuntime(t, JSON.stringify({ platform: "arm64" }));
  assert.throws(() => probeGuestPlatform({ env: f.env }), /reported guest platform "arm64", not os\/architecture\[\/variant\]/);
});

test("a host runtime without the guest-platform verb gets the reinstall remedy", () => {
  const runJson = () => { throw new Error('compatibility runtime exited with status 1: unknown command "guest-platform"'); };
  assert.throws(
    () => probeGuestPlatform({ runJson }),
    /could not ask the host runtime which guest platform it boots \(.*unknown command "guest-platform"\)\. An installed runtime from before cloister-1c4ef5 has no `guest-platform` verb\.\nRun: cloister runtime install/,
  );
});

test("platformsOverlap is admits in either direction", () => {
  assert.equal(platformsOverlap("linux/arm64", "linux/arm64/v8"), true);
  assert.equal(platformsOverlap("linux/arm64/v8", "linux/arm64"), true);
  assert.equal(platformsOverlap("linux/arm/v7", "linux/arm"), true);
  assert.equal(platformsOverlap("linux/arm64/v8", "linux/arm64/v9"), false);
  assert.equal(platformsOverlap("linux/arm/v6", "linux/arm/v7"), false);
  assert.equal(platformsOverlap("linux/amd64", "linux/arm64"), false);
});
