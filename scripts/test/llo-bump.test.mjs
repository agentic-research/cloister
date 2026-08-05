// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Companion test for `task llo:bump` (cloister-464216).
//
// The property that matters is NOT that the script works — it is that its
// channel list and the rail's are the SAME list. A bump script with its own
// copy would be a checker and a writer disagreeing: add a fifth channel, the
// writer skips it silently, the checker correctly fails every bump afterwards,
// and the bug presents as "the rail is broken".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the bump imports the rail's channel list rather than restating it", () => {
  const src = readFileSync(resolve(ROOT, "scripts/llo-bump.mjs"), "utf8");
  assert.match(src, /from "\.\/lint-upstream-pins\.mjs"/,
    "llo-bump must import the enumeration from the rail");
  // A second literal list of channel files would defeat the point. The rail's
  // own filenames appearing as string literals here is the tell.
  const restated = ["rs/crates/cas/Cargo.toml", "rs/crates/host-runtime/Cargo.toml"]
    .filter((f) => src.includes(`"${f}"`));
  assert.deepEqual(restated, [],
    `llo-bump hardcodes channel files the rail already enumerates: ${restated.join(", ")}`);
});

test("PRECONDITION: an unpublished tag is refused, not bumped", () => {
  // The v0.16.0 case, where the tag was on the remote and the release did not
  // exist yet. Uses a tag that will never have a release.
  const r = spawnSync("node", [resolve(ROOT, "scripts/llo-bump.mjs"), "v0.0.0-never", "--dry-run"],
    { encoding: "utf8", cwd: ROOT });
  assert.notEqual(r.status, 0, "a nonexistent tag must not succeed");
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /not found|no published release/i,
    `expected a refusal naming the cause, got:\n${out}`);
});

// NO END-TO-END DRY RUN IN THE GATE, deliberately.
//
// The obvious test — run `llo-bump v0.16.0 --dry-run` and assert nothing moved
// — downloads twelve release binaries and shells `capnp`. It passed in
// isolation and broke an UNRELATED test in the full suite (`runtime storage
// init`, exit 2), because `task lint` runs these in parallel and this one hit
// the network, wrote the shared rs/target/schema-bridge cache, and spawned
// temp dirs throughout.
//
// A gate test that needs GitHub reachable is also vacuous exactly where it
// would matter — CI without network, or an offline tree — which is the failure
// this repo already names for tests that need a sibling checkout.
//
// So the gate keeps what is PURE (the enumeration is imported, not restated —
// the property this tool exists to preserve) and what fails FAST (a refusal
// path that exits before any download). The full round trip is exercised by
// running the real bump, which is the only time it is worth paying for.
