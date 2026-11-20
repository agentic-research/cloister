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

// ── Every fixture, bundled and unbundled ────────────────────────────────────
//
// The steps above are one walk through one sample. The bundle is the same
// code as `cloister inspect`, rebuilt by esbuild with a define that changes
// behaviour (startedAsScript), JSON imports inlined, and every module in one
// scope. So every fixture the checker is tested on runs through both, and the
// output must be identical, byte for byte. A difference is a bundling bug,
// whatever the checker says.

const FIXTURE_DIR = resolve(ROOT, "test/fixtures/terraform");
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "--", "test/fixtures/terraform"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const documents = tracked.filter((f) => f.endsWith(".show.json"));
const wranglers = tracked.filter((f) => /wrangler\.(toml|json)$/.test(f));

/** Run the checker both ways on a copy of `file` in its own directory. */
function both(file, args) {
  const dir = mkdtempSync(join(work, "fixture-"));
  const name = file.split("/").pop();
  copyFileSync(resolve(ROOT, file), join(dir, name));
  copyFileSync(join(work, "cloister-plan.mjs"), join(dir, "cloister-plan.mjs"));
  const withName = args.map((a) => (a === "@" ? name : a));
  const bundled = plan(withName, dir);
  const source = spawnSync(process.execPath, [resolve(ROOT, "bin/cloister.mjs"), "inspect", ...withName], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: work },
  });
  return { bundled, source };
}

test("every fixture is read: the set is not empty", () => {
  assert.ok(documents.length >= 5, `found ${documents.length} rendered documents`);
  assert.ok(wranglers.length >= 1, "found a wrangler config");
});

for (const file of documents) {
  test(`${file}: the bundle reports exactly what the CLI reports`, () => {
    const { bundled, source } = both(file, ["--terraform", "@", "--json"]);
    assert.equal(source.status, 0, source.stderr);
    assert.equal(bundled.status, source.status, bundled.stderr);
    assert.ok(JSON.parse(source.stdout).document.kind, "the CLI read a document");
    assert.equal(bundled.stdout, source.stdout);
    assert.equal(bundled.stderr, source.stderr);
  });

  test(`${file}: the bundle drafts exactly what the CLI drafts`, () => {
    const { bundled, source } = both(file, ["--terraform", "@", "--draft", "--env", "prod"]);
    // Two runs failing alike would also be equal, and would check nothing.
    assert.equal(source.status, 0, source.stderr);
    assert.match(source.stdout, /^\[metadata\]$/m);
    assert.equal(bundled.status, source.status, `${bundled.stderr}\n${source.stderr}`);
    assert.equal(bundled.stdout, source.stdout);
    assert.equal(bundled.stderr, source.stderr);
  });
}

for (const file of wranglers) {
  test(`${file}: the bundle reads a wrangler config exactly as the CLI does`, () => {
    const { bundled, source } = both(file, ["--wrangler", "@"]);
    assert.equal(source.status, 0, source.stderr);
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(bundled.stdout, source.stdout);
  });
}

test("--fail-on exits the same way from the bundle", () => {
  // The `missing` directory from above declares no connection for probe.
  const r = plan(["--terraform", "plan.json", "--env", "prod", "--dir", "missing", "--fail-on", "undeclared"]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /1 undeclared/);
});
