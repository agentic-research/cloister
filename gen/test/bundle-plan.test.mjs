// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The plan checker ships as one file that needs only Node 22
// (gen/bundle-plan.mjs). This builds it, copies it into an empty directory
// with nothing else in reach (no checkout, no node_modules), and does the job
// it is for, end to end: draft a cluster.toml from a rendered plan, check the
// plan against it, and flag a call the file does not declare.
//
// Each step is a way the bundle broke while it was being made: modules that
// ran their own main once bundled, files read from beside the module that
// were not there, and a schema loaded through tsx.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { bundlePlan } from "../bundle-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE = resolve(ROOT, "test/fixtures/terraform/kubernetes-plan.show.json");

const work = mkdtempSync(join(tmpdir(), "cloister-plan-"));
const plan = (args, cwd = work) => spawnSync(process.execPath, ["cloister-plan.mjs", ...args], {
  cwd,
  encoding: "utf8",
  // Nothing from this checkout: a stranger's machine has none of it.
  env: { PATH: process.env.PATH, HOME: work },
});

test("the plan checker builds into one file that imports only Node's own modules", async () => {
  const { out, bytes } = await bundlePlan(join(work, "cloister-plan.mjs"));
  assert.ok(bytes > 100_000, "the bundle holds the checker, not a stub");
  const head = readFileSync(out, "utf8").slice(0, 400);
  assert.match(head, /^#!\/usr\/bin\/env node\n/);
  assert.match(head, /AGPL-3\.0-or-later/);
  // The rendered plan is copied in. The checker refuses a plan git tracks,
  // and this directory is not a repository, so that check is exercised too.
  copyFileSync(SAMPLE, join(work, "plan.json"));
});

test("it drafts a cluster.toml from the plan, with nothing installed", () => {
  const r = plan(["--terraform", "plan.json", "--draft", "--env", "prod", "--name", "sample"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[\[connections\]\]$/m);
  assert.match(r.stdout, /^from = "probe"$/m);
  writeFileSync(join(work, "cluster.toml"), r.stdout);
});

test("it checks the plan against that file, and every declared call is evidenced", () => {
  const r = plan(["--terraform", "plan.json", "--env", "prod", "--dir", "."]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}evidenced {3}caller → server/m);
  assert.match(r.stdout, /^ {2}evidenced {3}probe → server/m);
  assert.doesNotMatch(r.stdout, /undeclared/);
});

test("it flags a call the plan makes and the file does not declare", () => {
  const drafted = parseToml(readFileSync(join(work, "cluster.toml"), "utf8"));
  // Remove probe's connection, and the env row that names it.
  const before = drafted.connections.length;
  drafted.connections = drafted.connections.filter((c) => c.from !== "probe");
  assert.equal(drafted.connections.length, before - 1);
  const probe = drafted.bundles.find((b) => b.name === "probe");
  const rows = probe.external.env.length;
  probe.external.env = probe.external.env.filter((row) => row.connection !== "server");
  assert.equal(probe.external.env.length, rows - 1);
  const without = stringifyToml(drafted);
  mkdirSync(join(work, "missing"));
  writeFileSync(join(work, "missing", "cluster.toml"), without);

  const r = plan(["--terraform", "plan.json", "--env", "prod", "--dir", "missing"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}undeclared {2}probe dials server .*cluster\.toml declares no such connection$/m);
  assert.match(r.stdout, /^ {2}evidenced {3}caller → server/m);
});

test("the sample the guide points at is the one this test runs", () => {
  const guide = readFileSync(resolve(ROOT, "docs/plan-checker.md"), "utf8");
  assert.ok(guide.includes("test/fixtures/terraform/kubernetes-plan.show.json"));
  assert.ok(guide.includes("task plan:bundle"));
  // And the sample is a rendered plan document, trimmed by gen/trim-plan-fixture.mjs.
  const doc = JSON.parse(readFileSync(SAMPLE, "utf8"));
  assert.equal(typeof doc.format_version, "string");
  assert.ok(doc.planned_values?.root_module, "the sample carries planned values");
  assert.equal(execFileSync("git", ["-C", ROOT, "ls-files", "--error-unmatch", "test/fixtures/terraform/kubernetes-plan.show.json"], { encoding: "utf8" }).trim(), "test/fixtures/terraform/kubernetes-plan.show.json");
});
