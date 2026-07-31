import test from "node:test";
import assert from "node:assert/strict";

import { systemGrants } from "../../cli/lib/harness/system-grants.mjs";

test("Linux grants contain Linux loader paths and no macOS-only paths", () => {
  const grants = systemGrants({
    platform: "linux",
    home: "/home/tester",
    pathExists: () => true,
  });

  assert.ok(grants.readDirectories.includes("/lib"));
  assert.ok(grants.readDirectories.includes("/etc"));
  assert.ok(!grants.readDirectories.includes("/System/Library"));
  assert.ok(!grants.readWriteDirectories.includes("/private/var/folders"));
});

test("macOS grants retain the measured loader and developer-tool paths", () => {
  const grants = systemGrants({
    platform: "darwin",
    home: "/Users/tester",
    pathExists: () => true,
  });

  assert.ok(grants.readDirectories.includes("/System/Library"));
  assert.ok(grants.readDirectories.includes("/var"));
  assert.ok(grants.readWriteDirectories.includes("/private/var/folders"));
});

test("grants omit paths that do not exist on the current host", () => {
  const present = new Set(["/bin", "/dev", "/home/tester/.gitconfig"]);
  const grants = systemGrants({
    platform: "linux",
    home: "/home/tester",
    pathExists: (path) => present.has(path),
  });

  assert.deepEqual(grants.readDirectories, ["/bin"]);
  assert.deepEqual(grants.readWriteDirectories, ["/dev"]);
  assert.deepEqual(grants.readFiles, ["/home/tester/.gitconfig"]);
});
