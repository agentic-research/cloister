// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister inspect --fail-on`: the exit code a CI job reads. A finding
// changed nothing about the exit code before this, so a check in CI could only
// grep the text, and a rewording of one line would have passed every plan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { EXIT_FINDINGS, FAIL_ON_KINDS, main as inspectMain, parseArgs } from "../../commands/inspect.mjs";

const PLAN = fileURLToPath(new URL("../../../test/fixtures/terraform/kubernetes-plan.show.json", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "cloister-fail-on-"));

async function inspect(args) {
  const out = [];
  const err = [];
  const status = await inspectMain(args, {
    log: (line) => out.push(line),
    errLog: (line) => err.push(line),
    // The fixture is tracked in this repository; the refusal is tested elsewhere.
    isGitTracked: () => false,
  });
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** A directory holding `cluster.toml`, drafted from the plan, then edited by `edit`. */
async function clusterDir(name, edit = (doc) => doc) {
  const drafted = await inspect(["--terraform", PLAN, "--draft", "--env", "prod", "--name", "sample"]);
  assert.equal(drafted.status, 0, drafted.stderr);
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "cluster.toml"), stringifyToml(edit(parseToml(drafted.stdout))));
  return dir;
}

/** The drafted file without probe's connection, so the plan makes a call it does not declare. */
const withoutProbe = (doc) => {
  doc.connections = doc.connections.filter((c) => c.from !== "probe");
  const probe = doc.bundles.find((b) => b.name === "probe");
  probe.external.env = probe.external.env.filter((row) => row.connection !== "server");
  return doc;
};

test("a plan that matches its file passes --fail-on", async () => {
  const dir = await clusterDir("matches");
  const r = await inspect(["--terraform", PLAN, "--env", "prod", "--dir", dir, "--fail-on", "undeclared,contradicted"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /evidenced {3}probe → server/);
});

test("an undeclared call exits 3 and names the count, and the report is still printed", async () => {
  const dir = await clusterDir("undeclared", withoutProbe);
  const r = await inspect(["--terraform", PLAN, "--env", "prod", "--dir", dir, "--fail-on", "undeclared"]);
  assert.equal(r.status, EXIT_FINDINGS);
  assert.equal(EXIT_FINDINGS, 3);
  assert.match(r.stdout, /undeclared {2}probe dials server/);
  assert.match(r.stderr, /1 undeclared \(--fail-on undeclared\)/);
});

test("a kind not named is reported and does not fail", async () => {
  const dir = await clusterDir("unnamed", withoutProbe);
  const r = await inspect(["--terraform", PLAN, "--env", "prod", "--dir", dir, "--fail-on", "contradicted"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /undeclared {2}probe dials server/);
});

test("without --fail-on, findings do not change the exit code", async () => {
  const dir = await clusterDir("plain", withoutProbe);
  const r = await inspect(["--terraform", PLAN, "--env", "prod", "--dir", dir]);
  assert.equal(r.status, 0, r.stderr);
});

test("--fail-on with --json exits the same way", async () => {
  const dir = await clusterDir("json", withoutProbe);
  const r = await inspect(["--terraform", PLAN, "--env", "prod", "--dir", dir, "--json", "--fail-on", "undeclared"]);
  assert.equal(r.status, EXIT_FINDINGS);
  assert.ok(JSON.parse(r.stdout).findings.some((f) => f.kind === "undeclared"));
});

test("--fail-on with no cluster.toml is refused, not passed having checked nothing", async () => {
  const empty = join(work, "empty");
  mkdirSync(empty);
  const cwd = process.cwd();
  process.chdir(empty);
  try {
    const r = await inspect(["--terraform", PLAN, "--fail-on", "undeclared"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--fail-on needs a cluster\.toml/);
  } finally {
    process.chdir(cwd);
  }
});

test("--fail-on takes only the kinds a finding can have, other than evidenced", () => {
  assert.deepEqual(parseArgs(["--terraform", "p", "--fail-on", "undeclared, unknown,undeclared"]).failOn, ["undeclared", "unknown"]);
  assert.throws(() => parseArgs(["--terraform", "p", "--fail-on", "evidenced"]), /not one of undeclared, contradicted, unknown/);
  assert.throws(() => parseArgs(["--terraform", "p", "--fail-on", ","]), /needs one or more/);
  assert.throws(() => parseArgs(["--terraform", "p", "--draft", "--env", "e", "--fail-on", "unknown"]), /nothing to check/);
  assert.deepEqual(FAIL_ON_KINDS, ["undeclared", "contradicted", "unknown"]);
});

test("every kind a finding has is evidenced or one --fail-on can name", () => {
  // The kinds are literals in report.mjs. A new kind added there and not here
  // would be a finding no CI check could fail on.
  const source = readFileSync(fileURLToPath(new URL("../../lib/facts/report.mjs", import.meta.url)), "utf8");
  const kinds = new Set([...source.matchAll(/findings\.push\(\{\s*kind: "([a-z]+)"/g)].map((m) => m[1]));
  assert.ok(kinds.size >= 4, `report.mjs was read (${[...kinds]})`);
  for (const kind of kinds) assert.ok(kind === "evidenced" || FAIL_ON_KINDS.includes(kind), `finding kind "${kind}"`);
});
