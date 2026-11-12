// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resource facts (ADR-0073): imported, never granted; secrets never read.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { main as inspectMain, isGitTracked } from "../../cli/commands/inspect.mjs";
import { CLOUDFLARE_MAPPING, CLOUDFLARE_SPEC, CLOUDFLARE_TYPES, GOOGLE_MAPPING, GOOGLE_SPEC, importResource } from "../../cli/lib/facts/cloudflare.mjs";
import { validateMapping, validateWranglerKeys } from "../../cli/lib/facts/validate.mjs";
import { WRANGLER_MAPPING, importWrangler } from "../../cli/lib/facts/wrangler.mjs";
import { projectSpec, renderSpec } from "../../scripts/gen-facts-spec.mjs";
import { FACT_KEYS, isMarkedSensitive, makeFact, pickPublic } from "../../cli/lib/facts/facts.mjs";
import { importFacts } from "../../cli/lib/facts/import.mjs";
import { resolveRelations } from "../../cli/lib/facts/cloudflare.mjs";
import { buildReport, renderReport } from "../../cli/lib/facts/report.mjs";
import { readShowJson, resourceReferences } from "../../cli/lib/facts/terraform.mjs";
import { trimPlan } from "../../scripts/trim-plan-fixture.mjs";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/terraform/cloudflare-state.show.json", import.meta.url));
const WRANGLER_FIXTURE = fileURLToPath(new URL("../../test/fixtures/terraform/wrangler.toml", import.meta.url));
const SPEC_FILES = [
  [CLOUDFLARE_MAPPING, CLOUDFLARE_SPEC, fileURLToPath(new URL("../../cli/lib/facts/spec/cloudflare.schema.json", import.meta.url))],
  [GOOGLE_MAPPING, GOOGLE_SPEC, fileURLToPath(new URL("../../cli/lib/facts/spec/google.schema.json", import.meta.url))],
];
const JSR_FIXTURE = fileURLToPath(new URL("../../test/fixtures/terraform/oss/jsr-plan.show.json", import.meta.url));
const jsrDoc = () => JSON.parse(readFileSync(JSR_FIXTURE, "utf8"));
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

test("the mapping reads only scalars it names: a fact holds no nested value it was not built to hold", () => {
  for (const type of Object.keys(CLOUDFLARE_TYPES)) {
    const fact = importResource({
      address: `x.${type}`, type, name: "x",
      values: { unexpected_secret: "FIXTURE-UNLISTED", nested: { deep: "FIXTURE-UNLISTED" } },
      sensitive: {},
    }, CLOUDFLARE_TYPES[type]);
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
    assert.match(errors.join("\n"), /--terraform <file>.*or --wrangler <file> is required[\s\S]*no such file[\s\S]*no cluster\.toml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- spec-driven mapping (ADR-0073 §3) ----

const clone = (x) => structuredClone(x);

test("mapping-vs-spec validation refuses each violation by name", () => {
  const bad = (edit) => { const m = clone(CLOUDFLARE_MAPPING); edit(m); return m; };
  const T = "cloudflare_zero_trust_tunnel_cloudflared";
  assert.doesNotThrow(() => validateMapping(CLOUDFLARE_MAPPING, CLOUDFLARE_SPEC));
  assert.throws(
    () => validateMapping(bad((m) => { m.types.cloudflare_nonexistent = { name: "x" }; }), CLOUDFLARE_SPEC),
    /unknown resource type "cloudflare_nonexistent"/,
  );
  assert.throws(
    () => validateMapping(bad((m) => { m.types[T].read = ["no_such_attribute"]; }), CLOUDFLARE_SPEC),
    /unknown attribute "cloudflare_zero_trust_tunnel_cloudflared\.no_such_attribute"/,
  );
  assert.throws(
    () => validateMapping(bad((m) => { m.types[T].read = ["tunnel_secret"]; }), CLOUDFLARE_SPEC),
    /sensitive attribute "cloudflare_zero_trust_tunnel_cloudflared\.tunnel_secret"/,
  );
  assert.throws(
    () => validateMapping(bad((m) => { m.types.cloudflare_workers_script.read = ["bindings"]; }), CLOUDFLARE_SPEC),
    /attribute "cloudflare_workers_script\.bindings" is not a scalar/,
  );
  assert.throws(
    () => validateMapping(bad((m) => { m.types.cloudflare_workers_route.relations[0].toType = "cloudflare_nope"; }), CLOUDFLARE_SPEC),
    /targets unknown type "cloudflare_nope"/,
  );
  assert.throws(
    () => validateMapping(bad((m) => { m.types.cloudflare_workers_route.relations[0].toAttr = "nope"; }), CLOUDFLARE_SPEC),
    /targets bad attribute: unknown attribute "cloudflare_workers_script\.nope"/,
  );
});

test("every attribute in the real mapping exists in the vendored spec and is not sensitive", () => {
  // validateMapping throws on the first violation; also assert the spec itself marks no mapped path sensitive.
  validateMapping(CLOUDFLARE_MAPPING, CLOUDFLARE_SPEC);
  for (const [type, entry] of Object.entries(CLOUDFLARE_MAPPING.types)) {
    const attrs = CLOUDFLARE_SPEC.resources[type].attributes;
    for (const path of [entry.name, ...(entry.read ?? []), ...(entry.ids ?? [])].filter(Boolean)) {
      assert.equal(attrs[path]?.sensitive, false, `${type}.${path}`);
    }
  }
  assert.ok(!CLOUDFLARE_MAPPING.types.cloudflare_connectivity_directory_service.read.includes("host"));
});

test("the spec projection is reproducible from the providers schema", (t) => {
  const source = process.env.FACTS_PROVIDERS_SCHEMA;
  if (!source) {
    t.skip("set FACTS_PROVIDERS_SCHEMA to a `tofu providers schema -json` file to check the projection byte for byte");
    return;
  }
  const schema = JSON.parse(readFileSync(source, "utf8"));
  for (const [mapping, vendored, file] of SPEC_FILES) {
    assert.equal(renderSpec(projectSpec(schema, vendored.version, mapping)), readFileSync(file, "utf8"), file);
  }
});

test("wrangler mapping keys all exist in wrangler's config schema, and a bad key is refused by name", () => {
  const schema = createRequire(import.meta.url)("wrangler/config-schema.json");
  assert.doesNotThrow(() => validateWranglerKeys(WRANGLER_MAPPING.keys, schema));
  assert.throws(() => validateWranglerKeys(["services[].nope"], schema), /key "services\[\]\.nope" is not in wrangler's config schema/);
  assert.throws(() => validateWranglerKeys(["not_a_key"], schema), /key "not_a_key"/);
});

test("a wrangler.toml's bindings are read, and its vars never reach a fact or the report", () => {
  assert.match(readFileSync(WRANGLER_FIXTURE, "utf8"), /FIXTURE-VAR-MUST-NOT-BE-READ/);
  const fact = importWrangler(WRANGLER_FIXTURE);
  assert.equal(fact.type, "wrangler_worker");
  assert.equal(fact.source, "wrangler");
  assert.equal(fact.name, "cloister");
  assert.deepEqual(fact.attrs.bindings.map((b) => [b.name, b.type]), [
    ["MACHE_BUNDLE", "service"], ["BILLING", "service"], ["SESSIONS", "kv_namespace"], ["LEDGER", "d1"],
  ]);
  const report = buildReport({ facts: [fact], skipped: {} }, CLUSTER);
  const seen = [...strings(fact), ...strings(report), renderReport(report)].join("\n");
  assert.ok(!seen.includes("FIXTURE-VAR-MUST-NOT-BE-READ"));
  assert.deepEqual(report.findings.map((f) => f.kind), ["evidenced", "unknown", "undeclared"]);
});

test("wrangler and Terraform describing one Worker list it once, as in both, and resolve ids exactly", () => {
  const imported = importFacts(fixture());
  imported.facts.push(importWrangler(WRANGLER_FIXTURE));
  const report = buildReport(imported, CLUSTER);
  assert.equal(report.workloads.filter((w) => w.name === "cloister").length, 1);
  assert.equal(report.workloads.find((w) => w.name === "cloister").source, "both");
  assert.match(renderReport(report), /cloister {2}Worker {2}\(in both\)/);
  assert.match(renderReport(report), /SESSIONS {2}kv_namespace {2}→ sessions/);
});

test("wrangler config refusals: jsonc is unsupported by name, a nameless config is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "wrangler-bad-"));
  try {
    writeFileSync(join(dir, "wrangler.jsonc"), "{}");
    assert.throws(() => importWrangler(join(dir, "wrangler.jsonc")), /wrangler\.jsonc is not supported/);
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify({ vars: { A: "FIXTURE-VAR-MUST-NOT-BE-READ" } }));
    assert.throws(() => importWrangler(join(dir, "wrangler.json")), /has no name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A small synthetic Terraform document built from resource stubs. */
function docOf(resources) {
  return {
    format_version: "1.0",
    values: {
      root_module: {
        resources: resources.map(([type, name, values]) => ({
          address: `${type}.${name}`, mode: "managed", type, name,
          provider_name: "registry.opentofu.org/cloudflare/cloudflare", values, sensitive_values: {},
        })),
      },
    },
  };
}
const zeros = "0".repeat(32);
const ones = "1".repeat(32);

test("report: a dangling route, and the route-to-tunnel request path by exact host", () => {
  const imported = importFacts(docOf([
    ["cloudflare_workers_script", "a", { script_name: "edge", account_id: zeros }],
    ["cloudflare_workers_route", "ok", { pattern: "app.example.com/*", script: "edge", zone_id: zeros }],
    ["cloudflare_workers_route", "dangling", { pattern: "gone.example.com/*", script: "ghost", zone_id: zeros }],
    ["cloudflare_workers_route", "wild", { pattern: "*.example.com/*", script: "edge", zone_id: zeros }],
    ["cloudflare_zero_trust_tunnel_cloudflared", "t", { id: ones, account_id: zeros, name: "origin" }],
    ["cloudflare_zero_trust_tunnel_cloudflared_config", "c", {
      tunnel_id: ones, account_id: zeros,
      config: { ingress: [
        { hostname: "app.example.com", service: "http://localhost:8080" },
        { hostname: "other.example.com", service: "http://localhost:9090" },
      ] },
    }],
  ]));
  const report = buildReport(imported, undefined);
  const text = renderReport(report);
  assert.match(text, /gone\.example\.com\/\*  → ghost \(not in this document\)/);
  assert.match(text, /app\.example\.com\/\*  → edge\n/);
  assert.deepEqual(report.requestPaths, [
    { host: "app.example.com", script: "edge", tunnel: "origin", service: "http://localhost:8080" },
  ]);
  assert.match(text, /app\.example\.com: route → edge; tunnel origin → http:\/\/localhost:8080/);
  assert.ok(!text.includes("other.example.com: route"), "no join without an exact host match");
});

test("report: an unresolved tunnel is (unnamed); a relation that matches nothing resolves to null", () => {
  const imported = importFacts(docOf([
    ["cloudflare_workers_route", "r", { pattern: "app.example.com/*", script: "edge", zone_id: zeros }],
    ["cloudflare_zero_trust_tunnel_cloudflared_config", "c", {
      tunnel_id: ones, account_id: zeros, config: { ingress: [{ hostname: "app.example.com", service: "http://localhost:1" }] },
    }],
  ]));
  assert.match(renderReport(buildReport(imported, undefined)), /tunnel \(unnamed\) → http:\/\/localhost:1/);
  const config = imported.facts.find((f) => f.type.endsWith("_config"));
  assert.equal(resolveRelations(config, imported.facts)[0].to, null);
});

test("report: no Worker in the inputs gives one line, not one finding per wire", () => {
  const imported = importFacts(docOf([["cloudflare_d1_database", "d", { id: ones, uuid: ones, name: "ledger" }]]));
  const report = buildReport(imported, CLUSTER);
  assert.equal(report.findings.length, 1);
  assert.match(
    renderReport(report),
    /unknown: no Worker in these inputs; 2 declared wires could not be checked \(pass --wrangler <file>\)/,
  );
});

test("report: private services are listed with type and ports, and `host` is never read", () => {
  const imported = importFacts(docOf([
    ["cloudflare_connectivity_directory_service", "s", {
      id: ones, service_id: ones, account_id: zeros, name: "internal-api", type: "http",
      http_port: 8080, https_port: 8443, host: { hostname: "FIXTURE-HOST-MUST-NOT-BE-READ.example.com" },
    }],
  ]));
  const text = renderReport(buildReport(imported, undefined));
  assert.match(text, /Private services:\n {2}internal-api {2}http {2}\(http 8080, https 8443\)/);
  assert.ok(!text.includes("FIXTURE-HOST-MUST-NOT-BE-READ"));
});

test("inspect accepts --wrangler alone, with --terraform, and does not refuse a tracked wrangler file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inspect-wrangler-"));
  try {
    const out = [];
    const errors = [];
    const io = { log: (m) => out.push(m), errLog: (m) => errors.push(m), isGitTracked: () => true };
    assert.equal(await inspectMain(["--wrangler", WRANGLER_FIXTURE, "--json"], io), 0);
    const alone = JSON.parse(out.pop());
    assert.equal(alone.document.kind, null);
    assert.equal(alone.workloads[0].name, "cloister");

    const tf = join(dir, "state.json");
    cpSync(FIXTURE, tf);
    const untracked = { ...io, isGitTracked: () => false };
    assert.equal(await inspectMain(["--terraform", tf, "--wrangler", WRANGLER_FIXTURE, "--json"], untracked), 0);
    assert.equal(JSON.parse(out.pop()).workloads.find((w) => w.name === "cloister").source, "both");

    // The tracked-file refusal still applies to the Terraform document, and only to it.
    assert.equal(await inspectMain(["--terraform", tf, "--wrangler", WRANGLER_FIXTURE], io), 2);
    assert.match(errors.join("\n"), /tracked by git/);
    assert.equal(await inspectMain(["--wrangler", join(dir, "missing.toml")], io), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Hostile inputs (the review of PR #298) ───────────────────────────────

test("a name with a newline or terminal escape cannot forge a report line", () => {
  const doc = fixture();
  const router = doc.values.root_module.child_modules[0].resources[0];
  router.values.bindings[0].name = "B\nFindings:\n  evidenced   x → y (z): bound as d1\x1b[2J\r";
  router.values.script_name = "cloister\n  evidenced   a → b (X): forged";
  const imported = importFacts(doc);
  const text = renderReport(buildReport(imported, CLUSTER));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), "no control character reaches the text report");
  assert.equal(text.split("\n").filter((l) => /^Findings:$/.test(l)).length, 1, "exactly one Findings header");
  assert.ok(!text.split("\n").some((l) => /^ {2}evidenced {3}(x → y|a → b)/.test(l)), "no forged finding line");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(JSON.stringify(imported.facts).replaceAll("\\n", "")), "facts hold no control characters");
});

test("a malformed sensitivity marker fails closed", () => {
  for (const marker of ["true", 1, null, { 0: true }]) {
    const doc = fixture();
    const router = doc.values.root_module.child_modules[0].resources[0];
    router.sensitive_values.bindings = marker;
    const fact = importFacts(doc).facts.find((f) => f.type === "cloudflare_workers_script" && f.attrs.bindingsWithheld);
    assert.ok(fact, `a bindings marker of ${JSON.stringify(marker)} withholds the list`);
    assert.deepEqual(fact.attrs.bindings, []);
  }
  for (const marker of ["true", 1, null, {}, []]) {
    assert.deepEqual(pickPublic({ a: "secret" }, { a: marker }, ["a"]), {}, `scalar marker ${JSON.stringify(marker)}`);
  }
  assert.deepEqual(pickPublic({ a: "x" }, "true", ["a"]), {}, "a non-object row marker reads nothing");
  assert.ok(isMarkedSensitive("true") && isMarkedSensitive(1) && isMarkedSensitive(null));
});

test("a marker list shorter than the rows withholds the unmarked rows", () => {
  const doc = fixture();
  const router = doc.values.root_module.child_modules[0].resources[0];
  router.sensitive_values.bindings = [{}, {}];
  const fact = importFacts(doc).facts.find((f) => f.address.endsWith("cloudflare_workers_script.router"));
  assert.equal(fact.attrs.bindings.length, 2);
  assert.equal(fact.attrs.bindingsWithheld, true);
});

test("a resource or binding type named after an Object.prototype member is not mapped and does not crash", () => {
  for (const type of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
    const doc = fixture();
    const resources = doc.values.root_module.child_modules[0].resources;
    resources.push({ address: `x.${type}`, mode: "managed", type, name: "x", values: { Object: "FIXTURE-PROTO", name: "FIXTURE-PROTO" }, sensitive_values: {} });
    resources[0].values.bindings.push({ name: "ODD", type, service: "mache" });
    resources[0].sensitive_values.bindings.push({});
    const imported = importFacts(doc);
    assert.equal(imported.skipped[type], 1, `${type} is counted as not read`);
    assert.ok(!imported.facts.some((f) => f.type === type));
    const report = buildReport(imported, CLUSTER);
    assert.ok(!strings(report).some((s) => s.includes("FIXTURE-PROTO")));
    assert.ok(!report.findings.some((f) => f.binding?.name === "ODD"), "an unmapped binding type is not a workload edge");
  }
});

test("a Worker with 100,000 bindings is reported in well under ten seconds", () => {
  const doc = fixture();
  const router = doc.values.root_module.child_modules[0].resources[0];
  router.values.bindings = Array.from({ length: 100_000 }, (_, i) => ({ name: `B${i}`, type: "service", service: `s${i}` }));
  router.sensitive_values.bindings = router.values.bindings.map(() => ({}));
  const started = Date.now();
  const report = buildReport(importFacts(doc), CLUSTER);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.equal(report.workloads.find((w) => w.name === "cloister").bindings.length, 100_000);
});

test("inspect refuses a symlink that points at a tracked file", async () => {
  const repo = mkdtempSync(join(tmpdir(), "inspect-link-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "inspect-link-out-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "state.json"), "{}");
    execFileSync("git", ["add", "state.json"], { cwd: repo });
    const link = join(outside, "link.json");
    symlinkSync(join(repo, "state.json"), link);
    const errors = [];
    assert.equal(await inspectMain(["--terraform", link], { log: () => {}, errLog: (m) => errors.push(m) }), 2);
    assert.match(errors.join("\n"), /tracked by git/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a Durable Object binding with no script named is shown as a class in the same Worker", () => {
  const doc = fixture();
  const router = doc.values.root_module.child_modules[0].resources[0];
  router.values.bindings.push({ name: "AGENT", type: "durable_object_namespace", class_name: "Agent" });
  router.sensitive_values.bindings.push({});
  const report = buildReport(importFacts(doc), CLUSTER);
  assert.match(renderReport(report), /AGENT {2}durable_object_namespace {2}→ \(this Worker, class Agent\)/);
});

// ---- plan references, Google types, the jsr plan (cloister-ca2582) ----

const jsrReport = () => buildReport(importFacts(jsrDoc()), CLUSTER);
const jsrText = () => renderReport(jsrReport());

test("jsr plan: both Workers appear and the LB's FRONTEND binding resolves to the frontend Worker", () => {
  const text = jsrText();
  assert.match(text, /deno-registry3-staging-jsr-lb {2}Worker/);
  assert.match(text, /deno-registry3-staging-jsr-frontend {2}Worker/);
  assert.match(text, /LB {2}service {2}→ deno-registry3-staging-jsr-lb\n/);
  assert.match(text, /FRONTEND {2}service {2}→ deno-registry3-staging-jsr-frontend\n/);
  assert.ok(!text.includes("not in this document"));
  const frontend = jsrReport().workloads.find((w) => w.name.endsWith("-frontend"));
  assert.ok(frontend.bindings.some((b) => b.name === "ASSETS"), "the version's bindings belong to the Worker");
});

test("jsr plan: the Cloud Run reference is listed as an observation, with no wire or finding", () => {
  const report = jsrReport();
  assert.match(renderReport(report), /Referenced by configuration:\n(?:.*\n)*? {2}deno-registry3-staging-jsr-lb: bindings reference google_cloud_run_v2_service registry-api\n/);
  assert.ok(!report.referencedByConfiguration.some((r) => r.workload.endsWith("-lb") && r.type === "cloudflare_r2_bucket"), "resolved bucket bindings are not repeated");
  assert.deepEqual(report.findings.map((f) => f.kind), ["unknown", "unknown"]);
});

test("jsr plan: Cloud Run services, invokers, Cloud SQL, queues and R2 buckets", () => {
  const text = jsrText();
  assert.equal(jsrReport().cloudRun.length, 2);
  assert.match(text, /registry-api {2}us-central1 {2}INGRESS_TRAFFIC_ALL\n {4}invoker: allUsers {2}\(publicly invocable\)/);
  assert.match(text, /registry-api-tasks {2}us-central1 {2}INGRESS_TRAFFIC_INTERNAL_ONLY\n {4}invoker: serviceAccount:task-dispatcher@[^\n]*\n/);
  assert.ok(!/serviceAccount:[^\n]*publicly/.test(text));
  assert.match(text, /Databases:\n {2}main-pg15 {2}POSTGRES_15 {2}us-central1/);
  assert.equal(jsrReport().queues.length, 3);
  for (const q of ["email-delivery", "npm-tarball-build-tasks2", "publishing-tasks"]) assert.match(text, new RegExp(`Queues:\\n(?:.*\\n)*? {2}${q} {2}us-central1`));
  assert.match(text, /Storage:\n(?: {2}.*\n)* {2}r2 {2}deno-registry3-staging-modules\n/);
  assert.equal(jsrReport().storage.filter((s) => s.kind === "r2").length, 5);
});

test("jsr plan: a service with no invoker row says unknown", () => {
  const doc = jsrDoc();
  doc.planned_values.root_module.resources = doc.planned_values.root_module.resources.filter((r) => !r.type.endsWith("_iam_member"));
  const text = renderReport(buildReport(importFacts(doc), CLUSTER));
  assert.equal(text.split("invoker: unknown (no member row in this document; member rows are non-authoritative)").length - 1, 2);
});

test("jsr plan: no id-shaped string, project id or plain_text value in text or JSON", () => {
  const imported = importFacts(jsrDoc());
  const report = buildReport(imported, CLUSTER);
  const out = `${renderReport(report)}\n${JSON.stringify(report)}`;
  assert.ok(!/[0-9a-f]{32}/.test(out) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(out), "no id-shaped string");
  // The `project` id is a join key too, but resource names and service-account
  // members in this plan embed it as text, so it is checked by key, not by value.
  for (const fact of imported.facts) for (const [key, id] of Object.entries(fact.attrs.ids ?? {})) {
    if (key !== "project" && id.length >= 8) assert.ok(!out.replace(/serviceAccount:\S+/g, "").includes(id), `id ${id.slice(0, 4)}... printed`);
  }
  const raw = readFileSync(JSR_FIXTURE, "utf8");
  assert.ok(!raw.includes('"text"'), "the fixture holds no binding value");
  assert.ok(!JSON.stringify(imported.facts).includes('"text"'));
});

test("jsr fixture: only mapped attributes and no placeholder credential text", () => {
  const raw = readFileSync(JSR_FIXTURE, "utf8");
  assert.ok(!/dummy/i.test(raw));
  assertMappedKeysOnly(jsrDoc());
});

/** Every key under planned_values/configuration is a structural key or a mapped attribute name. */
function assertMappedKeysOnly(doc) {
  const allowed = new Set([
    "format_version", "planned_values", "configuration", "root_module", "resources", "address", "mode", "type",
    "name", "provider_name", "values", "sensitive_values", "expressions", "references",
  ]);
  for (const mapping of [CLOUDFLARE_MAPPING, GOOGLE_MAPPING]) {
    for (const entry of Object.values(mapping.types)) {
      for (const path of [entry.name, ...(entry.read ?? []), ...(entry.ids ?? []), ...(entry.referenceAttrs ?? [])].filter(Boolean)) path.split(".").forEach((p) => allowed.add(p));
      for (const list of entry.lists ?? []) { list.path.split(".").forEach((p) => allowed.add(p)); list.read.forEach((p) => allowed.add(p)); }
    }
  }
  const walk = (value, path) => {
    if (Array.isArray(value)) value.forEach((v) => walk(v, path));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        assert.ok(allowed.has(k), `unmapped key ${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(doc, "$");
}

test("trim-plan-fixture is deterministic and emits only mapped keys", () => {
  const source = jsrDoc();
  source.variables = { v: { value: "x" } };
  source.planned_values.root_module.resources[0].values.unmapped = "FIXTURE-UNLISTED";
  source.planned_values.root_module.resources[0].sensitive_values.unmapped = true;
  const a = JSON.stringify(trimPlan(source));
  assert.equal(a, JSON.stringify(trimPlan(JSON.parse(JSON.stringify(source)))));
  assert.ok(!a.includes("FIXTURE-UNLISTED") && !a.includes("variables"));
  assertMappedKeysOnly(JSON.parse(a));
});

test("resourceReferences keeps only <type>.<name> and drops the rest", () => {
  const kept = resourceReferences([
    "var.x", "local.x", "data.a.b", "data.a", "module.m.x", "module.m", "a.b.c", "each.key", "count.index", "path.module", "terraform.workspace",
    "google_x.y", "google_x.y", "aws_s3.b[0]", "cloudflare_r2_bucket.modules.name", "cloudflare_r2_bucket.modules",
  ]);
  assert.deepEqual(kept, ["cloudflare_r2_bucket.modules", "google_x.y"]);
  assert.deepEqual(resourceReferences(undefined), []);
});

/** A plan whose route/member values are unknown, so only references can relate them. */
function planWith(resources, configuration) {
  return {
    format_version: "1.2",
    planned_values: {
      root_module: {
        resources: resources.map(([type, name, values]) => ({
          address: `${type}.${name}`, mode: "managed", type, name, provider_name: "p", values, sensitive_values: {},
        })),
      },
    },
    configuration: {
      root_module: {
        resources: Object.entries(configuration).map(([address, expressions]) => ({ address, mode: "managed", expressions })),
      },
    },
  };
}
const SCRIPTS = [["cloudflare_workers_script", "a", { script_name: "alpha" }], ["cloudflare_workers_script", "b", { script_name: "beta" }]];
const routeTarget = (doc) => {
  const { facts, kind } = importFacts(doc);
  return resolveRelations(facts.find((f) => f.type === "cloudflare_workers_route"), facts, kind)[0].to?.address ?? null;
};

test("reference resolution: one candidate resolves; zero or two stay unresolved", () => {
  const route = ["cloudflare_workers_route", "r", { pattern: "x.example.com/*" }];
  const refs = (...a) => ({ "cloudflare_workers_route.r": { script: { references: a } } });
  assert.equal(routeTarget(planWith([...SCRIPTS, route], refs("cloudflare_workers_script.a.script_name", "cloudflare_workers_script.a"))), "cloudflare_workers_script.a");
  assert.equal(routeTarget(planWith([...SCRIPTS, route], refs("var.x"))), null);
  assert.equal(routeTarget(planWith([...SCRIPTS, route], refs("cloudflare_workers_script.a", "cloudflare_workers_script.b"))), null);
  assert.equal(routeTarget(planWith([...SCRIPTS, route], refs("cloudflare_workers_script.gone"))), null);
});

test("reference resolution: value equality wins, and a state document ignores references", () => {
  const route = ["cloudflare_workers_route", "r", { pattern: "x.example.com/*", script: "beta" }];
  const config = { "cloudflare_workers_route.r": { script: { references: ["cloudflare_workers_script.a"] } } };
  assert.equal(routeTarget(planWith([...SCRIPTS, route], config)), "cloudflare_workers_script.b");
  const unknown = ["cloudflare_workers_route", "r", { pattern: "x.example.com/*" }];
  const state = planWith([...SCRIPTS, unknown], config);
  state.values = state.planned_values;
  delete state.planned_values;
  const imported = importFacts(state);
  assert.equal(imported.kind, "state");
  assert.ok(imported.facts.every((f) => !f.attrs.references));
  assert.equal(routeTarget(state), null);
  // And the engine itself refuses references unless told the document is a plan.
  const planFacts = importFacts(planWith([...SCRIPTS, unknown], { "cloudflare_workers_route.r": { script: { references: ["cloudflare_workers_script.a"] } } })).facts;
  const route0 = planFacts.find((f) => f.type === "cloudflare_workers_route");
  assert.equal(resolveRelations(route0, planFacts, "state")[0].to, null);
  assert.equal(resolveRelations(route0, planFacts, "plan")[0].to?.address, "cloudflare_workers_script.a");
});

test("references are kept only for mapped referenceAttrs", () => {
  const route = ["cloudflare_workers_route", "r", { pattern: "x.example.com/*" }];
  const doc = planWith([...SCRIPTS, route], {
    "cloudflare_workers_route.r": { script: { references: ["cloudflare_workers_script.a"] }, pattern: { references: ["cloudflare_dns_record.d"] } },
  });
  const fact = importFacts(doc).facts.find((f) => f.type === "cloudflare_workers_route");
  assert.deepEqual(fact.attrs.references, { script: ["cloudflare_workers_script.a"] });
});

test("mapping validation refuses a referenceAttrs entry that is not in the spec", () => {
  const bad = structuredClone(CLOUDFLARE_MAPPING);
  bad.types.cloudflare_workers_route.referenceAttrs = ["no_such_attribute"];
  assert.throws(() => validateMapping(bad, CLOUDFLARE_SPEC), /unknown attribute "cloudflare_workers_route\.referenceAttrs\.no_such_attribute"/);
  assert.doesNotThrow(() => validateMapping(GOOGLE_MAPPING, GOOGLE_SPEC));
});

test("each mapping is validated against its own spec", () => {
  assert.throws(() => validateMapping(GOOGLE_MAPPING, CLOUDFLARE_SPEC), /unknown resource type "google_/);
  assert.throws(() => validateMapping(CLOUDFLARE_MAPPING, GOOGLE_SPEC), /unknown resource type "cloudflare_/);
});
