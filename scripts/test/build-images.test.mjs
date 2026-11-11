// SPDX-License-Identifier: AGPL-3.0-or-later
//
// tools/dolt-grpc-demo/microvm/build-images.sh never deletes what it did not
// create, and refuses a melange/apko version other than the one the committed
// pins were built with (cloister-2af014 review). melange and apko are stubs on
// PATH that log their calls, so this runs without either tool.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "../../tools/dolt-grpc-demo/microvm/build-images.sh");

function harness(t, { melange = "0.48.2", apko = "1.2.2" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "build-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(bin);
  // `<tool> version` prints the pinned GitVersion; `build` makes the output a
  // real build would (an APK dir for melange, a layout dir for apko).
  const stub = (name, version) => {
    writeFileSync(join(bin, name), `#!/bin/sh
echo "${name} $*" >> '${log}'
if [ "$1" = version ]; then echo "GitVersion:    ${version}"; exit 0; fi
if [ "${name}" = melange ]; then
  while [ $# -gt 0 ]; do [ "$1" = --out-dir ] && mkdir -p "$2/aarch64" && touch "$2/aarch64/x.apk"; shift; done
else
  mkdir -p "$4" && echo '{}' > "$4/index.json"
fi
`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("melange", melange);
  stub("apko", apko);
  const run = (...args) =>
    spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { root, run, calls };
}

test("a non-empty directory it did not make is refused, and its files survive", (t) => {
  const h = harness(t);
  const victim = join(h.root, "victim");
  mkdirSync(join(victim, "important"), { recursive: true });
  writeFileSync(join(victim, "important/file.txt"), "keep me");
  const r = h.run(victim);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /victim is not empty and was not made by build-images\.sh \(no \.build-images-out\); refusing to write into it/);
  assert.equal(readFileSync(join(victim, "important/file.txt"), "utf8"), "keep me");
  assert.doesNotMatch(h.calls(), /build/, "nothing was built");
});

test("in its own output dir it deletes only what it creates", (t) => {
  const h = harness(t);
  const out = join(h.root, "out");
  assert.equal(h.run(out).status, 0, "a new directory is fine");
  assert.ok(existsSync(join(out, ".build-images-out")));
  writeFileSync(join(out, "notes.txt"), "mine");
  writeFileSync(join(out, "orders", "stale"), "old layout");
  const r = h.run(out, "orders");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(out, "notes.txt"), "utf8"), "mine", "an unrelated file survives");
  assert.equal(existsSync(join(out, "orders", "stale")), false, "the image it rebuilds is replaced");
  assert.ok(existsSync(join(out, "dolt", "index.json")), "an image it did not rebuild is left");
});

test("an unknown image is refused before anything is created", (t) => {
  const h = harness(t);
  const out = join(h.root, "new");
  const r = h.run(out, "dolt", "postgres");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown image postgres \(dolt, orders\)/);
  assert.equal(existsSync(out), false);
});

for (const [tool, opts] of [["melange", { melange: "0.49.0" }], ["apko", { apko: "1.3.0" }]]) {
  test(`${tool} at another version is refused by name, before anything is created`, (t) => {
    const h = harness(t, opts);
    const out = join(h.root, "new");
    const r = h.run(out);
    assert.equal(r.status, 2);
    const want = tool === "melange" ? "melange 0.49.0 is not melange 0.48.2" : "apko 1.3.0 is not apko 1.2.2";
    assert.ok(r.stderr.includes(want), r.stderr);
    assert.match(r.stderr, /reaches the image digests/);
    assert.equal(existsSync(out), false);
  });
}
