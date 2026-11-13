// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The guest platform and how a recorded rootfs row is matched to it
// (cloister-1c4ef5). The probe runs a real executable standing in for the
// host runtime's `guest-platform` verb, through the real runCompatibilityJson.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatPlatform, isPlatform } from "../../cli/lib/runtime/platform.mjs";
import { lazyGuestPlatform, probeGuestPlatform, queryPlatformAdmits } from "../../cli/lib/runtime/guest-platform.mjs";

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

test("queryPlatformAdmits with no candidates spawns nothing", () => {
  const runJson = () => { throw new Error("must not be called"); };
  assert.deepEqual(queryPlatformAdmits("linux/arm64", [], { runJson }), { admitted: [], overlapping: [] });
});

test("queryPlatformAdmits asks the platform-admits verb and returns its answer", () => {
  let seen;
  const runJson = (args) => {
    seen = args;
    return { data: { platform: "linux/arm64", admitted: ["linux/arm64"], overlapping: ["linux/arm64", "linux/arm64/v8"] } };
  };
  const got = queryPlatformAdmits("linux/arm64", ["linux/arm64", "linux/arm64/v8"], { runJson });
  assert.deepEqual(seen, ["platform-admits", "--platform", "linux/arm64", "linux/arm64", "linux/arm64/v8"]);
  assert.deepEqual(got, { admitted: ["linux/arm64"], overlapping: ["linux/arm64", "linux/arm64/v8"] });
});

test("queryPlatformAdmits refuses a reply naming a platform that was not a candidate", () => {
  const runJson = () => ({ data: { admitted: ["linux/amd64"], overlapping: [] } });
  assert.throws(() => queryPlatformAdmits("linux/arm64", ["linux/arm64"], { runJson }), /not two lists of the candidates/);
  const notLists = () => ({ data: { admitted: "linux/arm64", overlapping: [] } });
  assert.throws(() => queryPlatformAdmits("linux/arm64", ["linux/arm64"], { runJson: notLists }), /run cloister runtime install|Run: cloister runtime install/);
});

test("a host runtime without the platform-admits verb gets the reinstall remedy", () => {
  const runJson = () => { throw new Error('exited with status 1: unknown command "platform-admits"'); };
  assert.throws(
    () => queryPlatformAdmits("linux/arm64", ["linux/arm64"], { runJson }),
    /could not ask the host runtime which platforms linux\/arm64 admits \(.*unknown command "platform-admits"\)\. .*platform-admits. verb\.\nRun: cloister runtime install/,
  );
});

// The rail that keeps the mirror from coming back: admission is LLO's rule,
// answered by the host runtime; no JS under cli/ may define or call a copy.
test("the shipped cli/ tree has no JS copy of platform admission", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".mjs") || name.endsWith(".js")) {
        const text = readFileSync(path, "utf8");
        if (text.includes("platformAdmits(") || text.includes("platformsOverlap(")) offenders.push(path);
      }
    }
  };
  walk(new URL("../../cli", import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});
