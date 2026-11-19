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
