// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CI workflow's own gate, held to what its comments say.
//
// Branch protection requires checks by NAME, and that list lives in repository
// settings where no test can read it. So the workflow carries one job, `ci-ok`,
// that needs every other job, and that one name is what is required. These
// tests keep it true: a job added later and left out of `ci-ok` would be
// advisory, which is how a cluster test or the full-stack smoke could be red
// on a pull request that merged anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const load = (name) => parse(readFileSync(join(WORKFLOWS, name), "utf8"));
const ci = load("ci.yml");
const GATE = "ci-ok";

test("ci-ok needs every other job in ci.yml", () => {
  const others = Object.keys(ci.jobs).filter((j) => j !== GATE).sort();
  assert.deepEqual([...ci.jobs[GATE].needs].sort(), others);
});

test("ci-ok runs when a job it needs failed, so it fails and is not skipped", () => {
  // A skipped required check counts as passing.
  assert.equal(ci.jobs[GATE].if, "always()");
});

test("only a job with a condition may be skipped, and ci-ok names each one", () => {
  const conditional = Object.entries(ci.jobs).filter(([name, job]) => name !== GATE && job.if !== undefined).map(([name]) => name);
  const script = ci.jobs[GATE].steps.map((s) => s.run ?? "").join("\n");
  assert.deepEqual(conditional, ["verify"], "a new conditional job needs a line in ci-ok saying it may be skipped");
  for (const name of conditional) assert.match(script, new RegExp(`\\.key != "${name}"`));
});

test("no job is allowed to fail quietly", () => {
  for (const [name, job] of Object.entries(ci.jobs)) {
    assert.equal(job["continue-on-error"], undefined, `${name} sets continue-on-error`);
  }
});

test("a run on main is never cancelled by the next push", () => {
  for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"))) {
    const { concurrency } = load(file);
    if (!concurrency) continue;
    assert.equal(concurrency["cancel-in-progress"], "${{ github.ref != 'refs/heads/main' }}", file);
    assert.match(concurrency.group, /github\.ref == 'refs\/heads\/main' && github\.sha/, file);
  }
});

test("the engine binary the smoke runs is pinned in the lock file, by digest, and nowhere else", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "schema-bridge.lock.json"), "utf8"));
  assert.match(lock.binaries.leyline["linux-amd64"], /^[0-9a-f]{64}$/);
  const smoke = ci.jobs["smoke-e2e"];
  assert.equal(smoke.env.LEYLINE_RELEASE, undefined, "a second version pin is how the smoke fell behind");
  assert.match(smoke.steps.map((s) => s.run ?? "").join("\n"), /node gen\/fetch-schema-bridge\.mjs leyline/);
  assert.match(smoke.env.MACHE_SHA256, /^[0-9a-f]{64}$/);
});
