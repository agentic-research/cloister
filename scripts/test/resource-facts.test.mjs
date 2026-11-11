// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resource facts (ADR-0073): imported, never granted; secrets never read.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main as inspectMain, isGitTracked } from "../../cli/commands/inspect.mjs";
import { CLOUDFLARE_ADAPTERS } from "../../cli/lib/facts/cloudflare.mjs";
import { FACT_KEYS, isMarkedSensitive, makeFact, pickPublic } from "../../cli/lib/facts/facts.mjs";
import { importFacts } from "../../cli/lib/facts/import.mjs";
import { buildReport, renderReport } from "../../cli/lib/facts/report.mjs";
import { readShowJson } from "../../cli/lib/facts/terraform.mjs";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/terraform/cloudflare-state.show.json", import.meta.url));
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8"));
const CLUSTER = {
  bundles: [
    { name: "cloister-router", workerdServiceName: "cloister" },
    { name: "mache" },
    { name: "rosary" },
  ],
  wires: [
    { from: "cloister-router", to: "mache", binding: "MACHE_BUNDLE" },
    { from: "cloister-router", to: "rosary", binding: "ROSARY_BUNDLE" },
  ],
};

/** Every string anywhere inside a value. */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

test("a fact has no key that could carry authority, and makeFact refuses one by name", () => {
  for (const key of ["grant", "grants", "connection", "connections", "edge", "edges", "wire", "wires", "allow"]) {
    assert.ok(!FACT_KEYS.includes(key));
    assert.throws(
      () => makeFact({ source: "s", address: "a", type: "t", [key]: [] }),
      new RegExp(`cannot carry "${key}".*never authority`),
    );
  }
  assert.throws(() => makeFact({ source: "s", address: "a", type: "t", extra: 1 }), /has no "extra" field/);
  assert.throws(() => makeFact({ source: "s", address: "", type: "t" }), /non-empty "address"/);
});

test("every imported fact has exactly the fact keys and is frozen", () => {
  const { facts } = importFacts(fixture());
  assert.ok(facts.length >= 9);
  for (const fact of facts) {
    assert.deepEqual(Object.keys(fact).sort(), [...FACT_KEYS].sort());
    assert.ok(Object.isFrozen(fact) && Object.isFrozen(fact.attrs));
    assert.throws(() => { fact.attrs.grants = []; }, TypeError);
  }
});

test("no secret, source or identity value in the document reaches a fact or the report", () => {
  const raw = readFileSync(FIXTURE, "utf8");
  const planted = raw.match(/FIXTURE-[A-Z-]+-MUST-NOT-BE-READ/g);
  assert.equal(new Set(planted).size, 4, "the fixture plants a worker source, a secret, a json var and a tunnel secret");
  const imported = importFacts(fixture());
  const report = buildReport(imported, CLUSTER);
  const seen = [...strings(imported.facts), ...strings(report), renderReport(report)].join("\n");
  for (const marker of planted) assert.ok(!seen.includes(marker), `${marker} leaked`);
  assert.ok(!seen.includes("fixture@example.com"), "who an Access policy admits is not read");
  assert.ok(!seen.includes("origin.example.com\",") && !/CNAME.*origin\.example\.com/.test(renderReport(report)), "a DNS record's content is not read");
});

test("ids are join keys: the rendered report names resources and prints no id", () => {
  const text = renderReport(buildReport(importFacts(fixture()), CLUSTER));
  assert.match(text, /SESSIONS {2}kv_namespace {2}→ sessions/);
  assert.match(text, /LEDGER {2}d1 {2}→ ledger/);
  assert.ok(!/[0-9a-f]{32}/.test(text), "no 32-hex id");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), "no uuid");
});

test("pickPublic drops what the document marks sensitive, and never copies an unlisted key", () => {
  const values = { a: "1", b: "2", c: "3", nested: { x: 1 } };
  assert.deepEqual(pickPublic(values, { b: true }, ["a", "b", "nested"]), { a: "1" });
  assert.ok(isMarkedSensitive([{}, { text: true }]));
  assert.ok(!isMarkedSensitive([{}, {}]));
});

test("a whole binding list marked sensitive is withheld, and its wires are reported unknown", () => {
  const doc = fixture();
  const router = doc.values.root_module.child_modules[0].resources[0];
  router.sensitive_values.bindings = true;
  const imported = importFacts(doc);
  const fact = imported.facts.find((f) => f.name === "cloister");
  assert.deepEqual(fact.attrs.bindings, []);
  assert.equal(fact.attrs.bindingsWithheld, true);
  const report = buildReport(imported, CLUSTER);
  assert.ok(report.findings.every((f) => f.kind === "unknown"));
  assert.match(report.findings[0].reason, /marked sensitive and were not read/);
});

test("the three finding kinds: evidenced, unknown, undeclared", () => {
  const report = buildReport(importFacts(fixture()), CLUSTER);
  const kinds = report.findings.map((f) => f.kind);
  assert.deepEqual(kinds, ["evidenced", "unknown", "undeclared"]);
  assert.equal(report.findings[0].wire.binding, "MACHE_BUNDLE");
  assert.match(report.findings[1].reason, /no binding named ROSARY_BUNDLE/);
  assert.deepEqual(report.findings[2], {
    kind: "undeclared", from: "cloister-router", binding: { name: "BILLING", type: "service", target: "billing" },
  });
  // Storage and config bindings are not workload edges and are never "undeclared".
  assert.ok(!report.findings.some((f) => f.binding?.name === "SESSIONS" || f.binding?.name === "API_TOKEN"));
});

test("a report never changes the declared graph, and an undeclared binding adds no wire", () => {
  const cluster = structuredClone(CLUSTER);
  const report = buildReport(importFacts(fixture()), cluster);
  assert.deepEqual(cluster, CLUSTER);
  assert.equal(report.declared.length, CLUSTER.wires.length);
  assert.ok(!report.declared.some((d) => d.binding === "BILLING"));
});

test("a Worker with no bundle is listed as not in cluster.toml and yields no finding", () => {
  const report = buildReport(importFacts(fixture()), CLUSTER);
  assert.equal(report.workloads.find((w) => w.name === "reports").bundle, "");
  assert.match(renderReport(report), /reports {2}Worker {2}\(not in cluster\.toml\)/);
  assert.ok(!report.findings.some((f) => f.from === "reports"));
});

test("types with no adapter are counted, not silently dropped; data sources are skipped", () => {
  const { skipped, facts } = importFacts(fixture());
  assert.deepEqual(skipped, { cloudflare_ruleset: 1 });
  assert.ok(!facts.some((f) => f.type === "cloudflare_zone"));
  assert.match(renderReport(buildReport(importFacts(fixture()), CLUSTER)), /Not read[\s\S]*1 {2}cloudflare_ruleset/);
});

test("the reader refuses an unknown format version, a raw state file and a non-object", () => {
  assert.throws(() => readShowJson({ format_version: "2.0", values: {} }), /format_version "2\.0" is not supported/);
  assert.throws(() => readShowJson({ format_version: "0.2", values: {} }), /not supported/);
  assert.throws(() => readShowJson({ version: 4, serial: 9, lineage: "x", resources: [] }), /raw \.tfstate.*show -json/s);
  assert.throws(() => readShowJson({}), /no format_version/);
  assert.throws(() => readShowJson([]), /not a JSON object/);
});

test("a plan document is read from planned_values", () => {
  const doc = fixture();
  doc.planned_values = doc.values;
  delete doc.values;
  const imported = importFacts(doc);
  assert.equal(imported.kind, "plan");
  assert.ok(imported.facts.length >= 9);
});

test("every adapter reads only scalars it names: a fact holds no nested value it was not built to hold", () => {
  for (const type of Object.keys(CLOUDFLARE_ADAPTERS)) {
    const fact = CLOUDFLARE_ADAPTERS[type]({
      address: `x.${type}`, type, name: "x",
      values: { unexpected_secret: "FIXTURE-UNLISTED", nested: { deep: "FIXTURE-UNLISTED" } },
      sensitive: {},
    });
    assert.ok(!strings(fact).some((s) => s.includes("FIXTURE-UNLISTED")), type);
  }
});

test("committed fixtures are synthetic: reserved names and repeated-digit ids only", () => {
  // Hostnames live in resource VALUES (addresses like `cloudflare_zone.example`
  // are Terraform names, not hosts), so walk the values with their keys.
  const hosts = [];
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (key === "main_module" || key === "compatibility_date") return;
      const host = value.match(/^(?:[a-z]+:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/.*)?$/)?.[1];
      if (host) hosts.push(host);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  const doc = fixture();
  const resources = [...doc.values.root_module.resources, ...doc.values.root_module.child_modules.flatMap((m) => m.resources)];
  for (const resource of resources) walk(resource.values, "");
  assert.ok(hosts.length >= 4, "the fixture has hostnames to check");
  for (const host of hosts) assert.match(host, /(^|\.)example\.com$/, `${host} is not a reserved example name`);

  const raw = readFileSync(FIXTURE, "utf8");
  const ids = raw.match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  assert.ok(ids.length >= 6, "the fixture has ids to check");
  for (const id of ids) assert.equal(new Set(id.replaceAll("-", "")).size, 1, `${id} does not look synthetic`);
});

test("inspect refuses a file git tracks, before reading it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inspect-tracked-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const file = join(dir, "state.json");
    writeFileSync(file, "this is not JSON; reading it would fail differently");
    assert.equal(isGitTracked(file), false);
    execFileSync("git", ["add", "state.json"], { cwd: dir });
    assert.equal(isGitTracked(file), true);
    const errors = [];
    const code = await inspectMain(["--terraform", file], { log: () => {}, errLog: (m) => errors.push(m) });
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /tracked by git.*must not be committed/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect prints the report for an untracked copy, and refuses bad usage by name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inspect-ok-"));
  try {
    const file = join(dir, "state.json");
    cpSync(FIXTURE, file);
    const out = [];
    const errors = [];
    const io = { log: (m) => out.push(m), errLog: (m) => errors.push(m), isGitTracked: () => false };
    assert.equal(await inspectMain(["--terraform", file, "--json"], io), 0);
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.document.kind, "state");
    assert.ok(Array.isArray(report.findings));

    assert.equal(await inspectMain([], io), 2);
    assert.equal(await inspectMain(["--terraform", join(dir, "missing.json")], io), 2);
    assert.equal(await inspectMain(["--terraform", file, "--dir", dir], io), 2);
    assert.match(errors.join("\n"), /--terraform <file> is required[\s\S]*no such file[\s\S]*no cluster\.toml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
