// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister cluster up|down` — and the scaffold that depends on it.
//
// Why this verb exists: `task cluster:up` worked in THIS repo and nowhere else.
// A scaffolded cluster ships cluster.toml + cloister.capnp +
// cluster.compose.yaml and NO Taskfile, so both the recipe README and the CLI's
// own next-steps told operators to run `task cluster:up` in a directory where
// `task` reports "No Taskfile found". Measured, not inferred.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs, clusterComposePath, resolveComposeCmd, main, ClusterUsageError,
} from "../cli-cluster.mjs";
import { SHARED_FILES } from "../cli-init.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function clusterDir(t) {
  const d = mkdtempSync(join(tmpdir(), "cluster-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, "cluster.compose.yaml"), "services: {}\n");
  return d;
}

test("a directory with no compose file is refused BEFORE spawning anything", (t) => {
  // compose's own "file not found" reads as a compose problem and sends people
  // to the wrong docs. This names what is missing and how to get one.
  const empty = mkdtempSync(join(tmpdir(), "not-a-cluster-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => clusterComposePath(empty), ClusterUsageError);
  assert.throws(() => clusterComposePath(empty), /cloister init --recipe/);
});

test("down PRESERVES volumes unless --destroy is passed", async (t) => {
  // DO SQLite state lives in those volumes, so removing them is unrecoverable.
  // A routine-looking verb must not do it by default.
  const d = clusterDir(t);
  let seen = null;
  const fake = (_bin, argv) => {
    seen = argv;
    return { on: (e, cb) => { if (e === "close") queueMicrotask(() => cb(0)); } };
  };
  await main(["down", "--dir", d], { spawn: fake, composeCmd: ["docker", "compose"], log: () => {} });
  assert.ok(!seen.includes("-v"), `default down must not pass -v; got ${seen.join(" ")}`);

  await main(["down", "--dir", d, "--destroy"], { spawn: fake, composeCmd: ["docker", "compose"], log: () => {} });
  assert.ok(seen.includes("-v"), "--destroy must opt in explicitly");
});

test("COMPOSE_CMD overrides runtime detection", () => {
  assert.deepEqual(
    resolveComposeCmd({ env: { COMPOSE_CMD: "podman compose" } }),
    ["podman", "compose"],
  );
});

test("no compose runtime at all names what to install", () => {
  assert.throws(
    () => resolveComposeCmd({ env: {}, which: () => false }),
    /no compose-capable runtime found.*nerdctl, podman, docker/s,
  );
});

test("parseArgs: --dir is present from the start, for the many-cloisters case", () => {
  assert.equal(parseArgs(["up", "--dir", "/x"]).dir, "/x");
  assert.equal(parseArgs(["up"]).dir, ".", "defaults to cwd");
  assert.throws(() => parseArgs(["up", "--dir"]), /--dir requires a value/);
  assert.throws(() => parseArgs(["up", "--bogus"]), /unknown option/);
});

// ── the scaffold must actually be runnable ────────────────────────────────

test("PROPERTY: every scaffold ships the Taskfile, and it delegates to the CLI", () => {
  // The regression: a scaffold whose README said `task cluster:up` into a
  // directory with no Taskfile. Asserting SHARED_FILES exists is not enough —
  // the file has to be a door onto the CLI rather than a second implementation
  // of compose, which is the whole reason it is one file and not four.
  for (const f of SHARED_FILES) {
    const p = resolve(ROOT, "recipes/_shared", f);
    assert.ok(existsSync(p), `recipes/_shared/${f} must exist — every scaffold ships it`);
  }
  // lint-allow-rawparse: the property is "which COMMANDS does this declare",
  // and the answer lives in command strings a YAML parse would hand back
  // verbatim anyway. Parsing would let the assertion pass while a second
  // compose implementation sat in a `cmds:` entry the pattern stopped matching
  // — the opposite of what checking the text does here.
  const taskfile = readFileSync(resolve(ROOT, "recipes/_shared/Taskfile.yml"), "utf8");
  // lint-allow-rawparse: the property IS "does this file invoke the CLI", which
  // is a textual fact about the commands it declares.
  assert.match(taskfile, /cluster up --dir \./, "up must delegate to the CLI verb");
  assert.match(taskfile, /cluster down --dir \./, "down must delegate too");
  assert.doesNotMatch(
    taskfile, /nerdctl|podman|docker compose/,
    "runtime detection belongs in the CLI — a copy here is the drift this replaced",
  );
});

test("PROPERTY: _shared is not offered as a recipe", async () => {
  // It has no cluster.toml, so listRecipes already excludes it — asserted
  // because the exclusion is incidental to that filter rather than explicit,
  // and someone adding a cluster.toml to _shared would make it selectable.
  const { listRecipes } = await import("../cli-init.mjs");
  const names = listRecipes(resolve(ROOT, "recipes"));
  assert.ok(names.length > 0, "there must be recipes to list");
  assert.ok(!names.includes("_shared"), `_shared must not be selectable; got ${names.join(", ")}`);
});
