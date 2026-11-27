// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A declared connection beside who the plan lets call the target.
//
// An access row is the provider's own enforcement of an edge. A plan can
// show who IS granted. It cannot show that nobody else is: a grant may be
// made in another module, at a wider scope, or by hand. So a row is evidence,
// a public row is a contradiction, and no row is unknown. It is never read as
// "refused", and it does not raise an edge's strength.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { clusterGraph } from "../../lib/cluster/graph.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { GOOGLE_MAPPING, GOOGLE_SPEC } from "../../lib/facts/cloudflare.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { buildReport, renderReport } from "../../lib/facts/report.mjs";
import { validateMapping } from "../../lib/facts/validate.mjs";

const plan = () => JSON.parse(readFileSync(fileURLToPath(new URL("../../../test/fixtures/terraform/google-plan.show.json", import.meta.url)), "utf8"));
const resourcesOf = (doc) => doc.planned_values.root_module.resources;
const drafted = async (edit = (t) => t) => parseTomlToCluster(edit(draftCluster(importFacts(plan()), { env: "prod" }).toml));
const accessFindings = (doc, cluster) => buildReport(importFacts(doc), cluster, { env: "prod" }).findings.filter((f) => f.access);
const WORKQUEUE = "serviceAccount:workqueue@example-project.iam.gserviceaccount.com";

test("a connection whose caller the plan grants invoker is evidenced, by the caller's own service account", async () => {
  const findings = accessFindings(plan(), await drafted());
  const granted = findings.find((f) => f.access.from === "workqueue");
  assert.deepEqual(granted, { kind: "evidenced", access: { from: "workqueue", to: "reconciler", name: "reconciler", env: "prod", label: "invoker" }, principal: WORKQUEUE });
});

test("a caller with no row is unknown, and the reason says a row elsewhere would not be seen", async () => {
  const sweep = accessFindings(plan(), await drafted()).find((f) => f.access.from === "sweep");
  assert.equal(sweep.kind, "unknown");
  assert.match(sweep.reason, /no invoker row in these inputs names serviceAccount:sweep@example-project\.iam\.gserviceaccount\.com; a row made elsewhere is not visible here/);
});

test("a caller whose service account the plan does not state is unknown, not matched by its name", async () => {
  const doc = plan();
  // The service is still called workqueue, and the row still says workqueue@.
  delete resourcesOf(doc).find((r) => r.address === "google_cloud_run_v2_service.workqueue").values.template[0].service_account;
  const finding = accessFindings(doc, await drafted()).find((f) => f.access.from === "workqueue");
  assert.equal(finding.kind, "unknown");
  assert.match(finding.reason, /these inputs do not state who "workqueue" runs as/);
});

test("a public invoker row contradicts every private connection to that target", async () => {
  const doc = plan();
  resourcesOf(doc).find((r) => r.type === "google_cloud_run_v2_service_iam_member").values.member = "allUsers";
  const findings = accessFindings(doc, await drafted());
  assert.deepEqual(findings.map((f) => [f.access.from, f.kind]), [["workqueue", "contradicted"], ["sweep", "contradicted"]]);
  assert.match(findings[0].reason, /invoker is granted to allUsers, so it is not only "workqueue" that may call it/);
});

test("a row for a workload that declares no connection to the target is undeclared", async () => {
  // Drop the workqueue → reconciler connection (and the env row bound to it).
  const cluster = await drafted((toml) => toml
    .replace(/\[\[connections\]\]\nfrom = "workqueue"[\s\S]*?(?=\n\[\[connections\]\]|$)/, "")
    .replace(/\[\[bundles\.external\.env\]\]\nname = "RECONCILER_URL"\nconnection = "reconciler"\n/, ""));
  assert.ok(!cluster.connections.some((c) => c.from === "workqueue"), "the connection was not removed");
  const undeclared = accessFindings(plan(), cluster).filter((f) => f.kind === "undeclared");
  assert.deepEqual(undeclared, [{ kind: "undeclared", access: { from: "workqueue", to: "reconciler", label: "invoker" }, reason: "declares no such connection" }]);
});

test("the report prints each access finding, and no value beyond the principal", async () => {
  const imported = importFacts(plan());
  const text = renderReport(buildReport(imported, await drafted(), { env: "prod" }));
  assert.match(text, /evidenced {3}workqueue → reconciler \(invoker\): granted to serviceAccount:workqueue@example-project\.iam\.gserviceaccount\.com/);
  assert.match(text, /unknown {5}sweep → reconciler \(invoker\): no invoker row in these inputs names/);
});

// The plan shows a grant. It does not show the absence of every other grant,
// so the edge's strength is not raised by it.
test("an evidenced grant does not raise the edge's strength", async () => {
  const graph = clusterGraph(await drafted(), "prod");
  const edge = graph.edges.find((e) => e.from === "workqueue" && e.to === "reconciler");
  assert.equal(edge.strength, "none");
});

test("the mapping validator holds `identity` to what the entry reads", () => {
  const withIdentity = (change) => {
    const mapping = structuredClone(GOOGLE_MAPPING);
    change(mapping.types.google_cloud_run_v2_service.report.bundle.identity);
    return mapping;
  };
  assert.doesNotThrow(() => validateMapping(GOOGLE_MAPPING, GOOGLE_SPEC));
  assert.throws(() => validateMapping(withIdentity((i) => { i.attr = "template.execution_environment"; }), GOOGLE_SPEC), /identity attr "template\.execution_environment" is not in its "read" list/);
  assert.throws(() => validateMapping(withIdentity((i) => { i.principal = "serviceAccount:"; }), GOOGLE_SPEC), /identity principal must hold exactly one "\{\}"/);
  assert.throws(() => validateMapping(withIdentity((i) => { i.guess = true; }), GOOGLE_SPEC), /identity has unknown key "guess"/);
});

// ── an address the operator says is in a secret (ADR-0074 §7 amendment) ──────

test("a connection whose address is in a secret is unknown, and says the edge is declared, not observed", async () => {
  const cluster = await drafted((toml) => toml.replace('name = "RECONCILER_URL"\nconnection = "reconciler"', 'name = "RECONCILER_URL"\nsecret = "reconciler-url"\nconnection = "reconciler"'));
  assert.ok(cluster.bundles.find((b) => b.name === "workqueue").kind.external.env.some((e) => e.secret === "reconciler-url" && e.connection === "reconciler"), "the row was not rewritten");
  // A plan in which nothing workqueue is started with names reconciler.
  const doc = plan();
  delete doc.configuration.root_module.resources.find((r) => r.address === "google_cloud_run_v2_service.workqueue").expressions.template;
  const report = buildReport(importFacts(doc), cluster, { env: "prod" });
  const finding = report.findings.find((f) => f.connection?.from === "workqueue" && f.connection.to === "reconciler");
  // Nothing was observed, so it is not `evidenced`. The reason is the true one.
  assert.equal(finding.kind, "unknown");
  assert.deepEqual(finding.declaredIn, { secret: "reconciler-url", env: "RECONCILER_URL" });
  assert.match(renderReport(report), /unknown {5}workqueue → reconciler \(connection "reconciler", env prod\): cluster\.toml says its address is in secret "reconciler-url" \(env RECONCILER_URL\)\. A secret's value is never read, so this edge is declared, not observed/);
});

test("without that row the same plan gives the plain reason", async () => {
  const doc = plan();
  delete doc.configuration.root_module.resources.find((r) => r.address === "google_cloud_run_v2_service.workqueue").expressions.template;
  const finding = buildReport(importFacts(doc), await drafted(), { env: "prod" }).findings.find((f) => f.connection?.from === "workqueue" && f.connection.to === "reconciler");
  assert.equal(finding.kind, "unknown");
  assert.equal(finding.declaredIn, undefined);
  assert.match(finding.reason, /nothing "workqueue" is started with names "reconciler" in these inputs/);
});

test("a service whose invoker check is off is open to every caller, as a public row says", async () => {
  // invoker_iam_disabled: Cloud Run checks no invoker role, so anyone the network lets through may call it.
  const doc = plan();
  resourcesOf(doc).find((r) => r.address === "google_cloud_run_v2_service.reconciler").values.invoker_iam_disabled = true;
  const findings = accessFindings(doc, await drafted());
  assert.deepEqual(findings.filter((f) => f.access.to === "reconciler").map((f) => [f.access.from, f.kind]), [["workqueue", "contradicted"], ["sweep", "contradicted"]]);
  assert.match(findings[0].reason, /invoker is granted to anyone, since invoker_iam_disabled is true, so it is not only "workqueue" that may call it/);
  // Off is not stated by its absence, nor by false.
  for (const value of [false, undefined]) {
    const plain = plan();
    resourcesOf(plain).find((r) => r.address === "google_cloud_run_v2_service.reconciler").values.invoker_iam_disabled = value;
    assert.ok(!accessFindings(plain, await drafted()).some((f) => f.kind === "contradicted"), String(value));
  }
});

test("a setting that turns an access check off is a bool the entry reads, for a label an access type gives", () => {
  const edited = (edit) => {
    const mapping = structuredClone(GOOGLE_MAPPING);
    edit(mapping.types.google_cloud_run_v2_service);
    return () => validateMapping(mapping, GOOGLE_SPEC);
  };
  assert.doesNotThrow(edited(() => {}));
  assert.throws(edited((e) => { e.report.unchecked.attr = "ingress"; }), /unchecked needs an "attr" that is a bool in the entry's "read" list/);
  assert.throws(edited((e) => { e.read = e.read.filter((r) => r !== "invoker_iam_disabled"); }), /unchecked needs an "attr" that is a bool/);
  assert.throws(edited((e) => { e.report.unchecked.label = "admin"; }), /unchecked label "admin" is not one an access type gives google_cloud_run_v2_service/);
});

// ── Grants made under a condition, and grants to a list of members ───────────

const member = (doc) => resourcesOf(doc).find((r) => r.type === "google_cloud_run_v2_service_iam_member");
const CONDITION = [{ title: "until the migration", expression: "request.time < timestamp(\"2026-12-01T00:00:00Z\")" }];

test("a grant made under a condition is not evidence that it holds, and says so", async () => {
  const doc = plan();
  member(doc).values.condition = structuredClone(CONDITION);
  const granted = accessFindings(doc, await drafted()).find((f) => f.access.from === "workqueue");
  assert.equal(granted.kind, "unknown");
  assert.match(granted.reason, /invoker is granted to serviceAccount:workqueue@example-project\.iam\.gserviceaccount\.com only under a condition, which cloister does not evaluate/);
  // The report shows the row, and that it is conditional.
  const text = renderReport(buildReport(importFacts(doc), await drafted(), { env: "prod" }));
  assert.match(text, /invoker: serviceAccount:workqueue@example-project\.iam\.gserviceaccount\.com {2}\(under a condition\)/);
  // A condition whose fields the document withholds is still a condition.
  const hidden = plan();
  member(hidden).values.condition = [{}];
  member(hidden).sensitive_values = { condition: [{ expression: true, title: true }] };
  assert.equal(accessFindings(hidden, await drafted()).find((f) => f.access.from === "workqueue").kind, "unknown");
  // No condition block, or an empty one, is no condition.
  const plain = plan();
  member(plain).values.condition = [];
  assert.equal(accessFindings(plain, await drafted()).find((f) => f.access.from === "workqueue").kind, "evidenced");
});

test("a public grant under a condition still opens the target, and says it is conditional", async () => {
  const doc = plan();
  Object.assign(member(doc).values, { member: "allUsers", condition: structuredClone(CONDITION) });
  const findings = accessFindings(doc, await drafted());
  assert.deepEqual(findings.filter((f) => f.access.to === "reconciler").map((f) => f.kind), ["contradicted", "contradicted"]);
  assert.match(findings[0].reason, /invoker is granted to allUsers \(under a condition\), so it is not only "workqueue" that may call it/);
});

test("a binding grants its role to each of its members", async () => {
  const asBinding = (members, extra = {}) => {
    const doc = plan();
    const row = member(doc);
    row.type = "google_cloud_run_v2_service_iam_binding";
    row.address = "google_cloud_run_v2_service_iam_binding.reconciler_invokers";
    delete row.values.member;
    Object.assign(row.values, { members, ...extra });
    const configured = doc.configuration.root_module.resources.find((r) => r.type === "google_cloud_run_v2_service_iam_member");
    Object.assign(configured, { type: row.type, address: row.address });
    return doc;
  };
  const both = asBinding([WORKQUEUE, "serviceAccount:sweep@example-project.iam.gserviceaccount.com"]);
  assert.deepEqual(accessFindings(both, await drafted()).filter((f) => f.access.to === "reconciler").map((f) => [f.access.from, f.kind]), [["workqueue", "evidenced"], ["sweep", "evidenced"]]);
  const open = asBinding([WORKQUEUE, "allAuthenticatedUsers"]);
  assert.deepEqual(accessFindings(open, await drafted()).filter((f) => f.access.to === "reconciler").map((f) => f.kind), ["contradicted", "contradicted"]);
  const conditional = asBinding([WORKQUEUE], { condition: structuredClone(CONDITION) });
  assert.equal(accessFindings(conditional, await drafted()).find((f) => f.access.from === "workqueue").kind, "unknown");
  // A members list the document withholds grants nothing that can be read.
  const hidden = asBinding([WORKQUEUE]);
  resourcesOf(hidden).find((r) => r.type === "google_cloud_run_v2_service_iam_binding").sensitive_values = { members: [true] };
  assert.equal(accessFindings(hidden, await drafted()).find((f) => f.access.from === "workqueue").kind, "unknown");
});

test("the JSON report says which grants are conditional", async () => {
  const { declaredReport } = await import("../../lib/facts/report-json.mjs");
  const doc = plan();
  member(doc).values.condition = structuredClone(CONDITION);
  const json = declaredReport(buildReport(importFacts(doc), await drafted(), { env: "prod" }));
  const rows = json.sections.flatMap((s) => s.resources).flatMap((r) => r.access);
  assert.deepEqual(rows.find((a) => a.principal === WORKQUEUE), { label: "invoker", principal: WORKQUEUE, public: false, conditional: true });
});

test("an access rule names one principal or a list of them, and its condition is a block it reads", () => {
  const edited = (type, edit) => {
    const mapping = structuredClone(GOOGLE_MAPPING);
    edit(mapping.types[type]);
    return () => validateMapping(mapping, GOOGLE_SPEC);
  };
  const MEMBER = "google_cloud_run_v2_service_iam_member";
  const BINDING = "google_cloud_run_v2_service_iam_binding";
  assert.doesNotThrow(edited(MEMBER, () => {}));
  assert.doesNotThrow(edited(BINDING, () => {}));
  assert.throws(edited(MEMBER, (e) => { e.access.principals = "members"; }), /needs exactly one of "principal" .* or "principals"/);
  assert.throws(edited(BINDING, (e) => { e.strings = []; }), /access principals "members" is not in its "strings" list/);
  assert.throws(edited(MEMBER, (e) => { e.present = []; }), /access condition "condition" is not in its "present" list/);
  assert.throws(edited(MEMBER, (e) => { e.present = ["role"]; }), /"google_cloud_run_v2_service_iam_member\.role" is not a block/);
  assert.throws(edited(BINDING, (e) => { e.strings = ["role"]; e.access.principals = "role"; }), /"google_cloud_run_v2_service_iam_binding\.role" is not a list of strings/);
});
