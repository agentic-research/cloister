// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The cloister CLI ships as one file that needs only Node 22
// (gen/bundle.mjs). This builds it and copies it into an empty directory with
// nothing else in reach (no checkout, no node_modules). Then:
//
//   - the plan checker does its job end to end: draft a cluster.toml from a
//     rendered plan, check the plan against it, flag a call the file does
//     not declare;
//   - every sample plan, and every other standalone command, gives exactly
//     the output the unbundled CLI gives;
//   - every command that is not standalone refuses by name.
//
// Each step is a way the bundle broke while it was being made: modules that
// ran their own main once bundled, files read from beside the module that
// were not there, and a schema loaded through tsx.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { bundleCli } from "../bundle.mjs";
import { COMMANDS, STANDALONE, renderCommandHelp } from "../../cli/surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE = resolve(ROOT, "test/fixtures/terraform/kubernetes-plan.show.json");

const work = mkdtempSync(join(tmpdir(), "cloister-bundle-"));
/** Run the one file, from `cwd`, with nothing from this checkout: a stranger's machine has none of it. */
const cli = (args, cwd = work) => spawnSync(process.execPath, ["cloister.mjs", ...args], {
  cwd,
  encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: work },
});
/** The plan checker, as the one file runs it. */
const plan = (args, cwd = work) => cli(["inspect", ...args], cwd);

test("the CLI builds into one file that imports only Node's own modules", async () => {
  const { out, bytes } = await bundleCli(join(work, "cloister.mjs"));
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
  assert.ok(guide.includes("task bundle"));
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
  copyFileSync(join(work, "cloister.mjs"), join(dir, "cloister.mjs"));
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

// ── Every standalone command, and every other one ───────────────────────────

/** Every file under `dir`, path → content, minus the one file itself. */
function tree(dir, at = "") {
  const out = {};
  for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
    const rel = at ? `${at}/${entry.name}` : entry.name;
    if (rel === "cloister.mjs") continue;
    if (entry.isDirectory()) Object.assign(out, tree(dir, rel));
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

const source = (args, cwd) => spawnSync(process.execPath, [resolve(ROOT, "bin/cloister.mjs"), ...args], {
  cwd,
  encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: work },
});

/**
 * Run each of `steps` in turn in two copies of `fixture`, one with the one
 * file and one with the source CLI. Returns the last step's results.
 */
function bothIn(fixture, steps) {
  const make = (tag) => {
    const dir = mkdtempSync(join(work, `${tag}-`));
    cpSync(resolve(ROOT, fixture), dir, { recursive: true });
    return dir;
  };
  const a = make("bundled");
  copyFileSync(join(work, "cloister.mjs"), join(a, "cloister.mjs"));
  const b = make("source");
  let bundled;
  let fromSource;
  for (const args of steps) {
    bundled = cli(args, a);
    fromSource = source(args, b);
    assert.equal(fromSource.status, 0, `${args.join(" ")}: ${fromSource.stderr}`);
  }
  return { bundled, source: fromSource, bundledTree: tree(a), sourceTree: tree(b) };
}

/** Each standalone command, run on a cluster it can work on. */
const LOWER = ["cluster", "lower", "--env", "local"];
const RUNS = {
  "inspect": ["test/fixtures/terraform", [["inspect", "--terraform", "kubernetes-plan.show.json", "--json"]]],
  "cluster graph": ["test/e2e/lowered-kind", [["cluster", "graph", "--env", "local"]]],
  "cluster lower": ["test/e2e/lowered-kind", [LOWER]],
  // k8s works from the manifests lower writes, as it does for a user.
  "cluster k8s": ["test/e2e/lowered-kind", [LOWER, ["cluster", "k8s", "--env", "local", "--out", "k8s"]]],
};

test("every standalone command has a run here, and inspect is one of them", () => {
  assert.ok(STANDALONE.includes("inspect"));
  assert.deepEqual([...STANDALONE].sort(), Object.keys(RUNS).sort(), "add a run to RUNS for each command marked standalone in cli/surface.mjs");
});

for (const [name, [fixture, steps]] of Object.entries(RUNS)) {
  test(`${name}: the one file does exactly what the CLI does, from a directory with no checkout`, () => {
    const { bundled, source, bundledTree, sourceTree } = bothIn(fixture, steps);
    // Two runs failing alike would also be equal, and would check nothing.
    assert.equal(source.status, 0, source.stderr);
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.equal(bundled.stdout, source.stdout);
    assert.equal(bundled.stderr, source.stderr);
    assert.deepEqual(bundledTree, sourceTree, "the files each run left behind");
  });
}

test("every other command refuses by name, and answers --help from its declaration", () => {
  const others = COMMANDS.filter((c) => !c.standalone);
  assert.ok(others.length > 10, "the surface was read");
  for (const c of others) {
    const words = c.name.split(" ");
    const r = cli(words);
    assert.equal(r.status, 2, `${c.name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^cloister ${c.name}: this command needs a cloister checkout`), c.name);
    // Never the command's own --help code: that is not guaranteed to do nothing.
    const help = cli([...words, "--help"]);
    assert.equal(help.status, 0, `${c.name} --help: ${help.stderr}`);
    assert.equal(help.stdout, `${renderCommandHelp(c.name)}\nThis command needs a cloister checkout; the one-file build does not run it.\n`, `${c.name} --help`);
  }
});

test("the top-level help says what the one file runs", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`It runs: ${STANDALONE.join(", ")}\\.`));
});
