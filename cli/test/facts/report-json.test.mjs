// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inspect --json` is a projection of the report (cli/lib/facts/report-json.mjs)
// checked against manifest/cli.capnp before it is printed (ADR-0077). The
// sample plans reach only some kinds of finding. This reaches every one the
// schema declares, through the real buildReport, and puts each report through
// the projection and the generated schema.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { buildReport } from "../../lib/facts/report.mjs";
import { declaredFinding, declaredReport } from "../../lib/facts/report-json.mjs";
import { importWrangler } from "../../lib/facts/wrangler.mjs";
import { declaredOutput } from "../../lib/output-format.mjs";

const read = (path) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8"));
const SCHEMA = read("schema/cli.schema.json");
const googlePlan = () => read("test/fixtures/terraform/google-plan.show.json");
const cloudflareState = () => read("test/fixtures/terraform/cloudflare-state.show.json");
const kubernetesPlan = () => read("test/fixtures/terraform/kubernetes-plan.show.json");
const WRANGLER = fileURLToPath(new URL("../../../test/fixtures/terraform/wrangler.toml", import.meta.url));
const drafted = async (doc, edit = (t) => t) => parseTomlToCluster(edit(draftCluster(importFacts(doc), { env: "prod" }).toml));
/** The drafted file without `from`'s connections, and the env rows that name them. */
const withoutConnectionsFrom = (from) => (toml) => {
  const doc = parseToml(toml);
  const names = doc.connections.filter((c) => c.from === from).map((c) => c.name);
  doc.connections = doc.connections.filter((c) => c.from !== from);
  const bundle = doc.bundles.find((b) => b.name === from);
  bundle.external.env = (bundle.external.env ?? []).filter((row) => !names.includes(row.connection));
  return stringifyToml(doc);
};
const WIRED = {
  bundles: [{ name: "cloister-router", workerdServiceName: "cloister" }, { name: "mache" }, { name: "rosary" }],
  wires: [
    { from: "cloister-router", to: "mache", binding: "MACHE_BUNDLE" },
    { from: "cloister-router", to: "rosary", binding: "ROSARY_BUNDLE" },
  ],
};

/** Reports that, between them, reach every kind of finding. */
async function reports() {
  const out = [];
  const add = (imported, cluster, env) => out.push(buildReport(imported, cluster, env ? { env } : {}));

  // Connections, dials, access rows and exposure, from a Cloud Run plan and its draft.
  add(importFacts(googlePlan()), await drafted(googlePlan()), "prod");
  add(importFacts(kubernetesPlan()), await drafted(kubernetesPlan(), withoutConnectionsFrom("probe")), "prod");
  // An access row for a workload with no declared connection to the target.
  add(importFacts(googlePlan()), await drafted(googlePlan(), withoutConnectionsFrom("workqueue")), "prod");
  // A public invoker row contradicts a private connection; an ingress that disagrees with expose.
  const open = googlePlan();
  for (const r of open.planned_values.root_module.resources) {
    if (r.type === "google_cloud_run_v2_service") r.values.ingress = "INGRESS_TRAFFIC_ALL";
    if (r.type.endsWith("_iam_member")) r.values.member = "allUsers";
  }
  add(importFacts(open), await drafted(googlePlan()), "prod");
  // An address the operator says is in a secret.
  const unseen = googlePlan();
  delete unseen.configuration.root_module.resources.find((r) => r.address === "google_cloud_run_v2_service.workqueue").expressions.template;
  add(importFacts(unseen), await drafted(googlePlan(), (t) => t.replace('name = "RECONCILER_URL"\nconnection = "reconciler"', 'name = "RECONCILER_URL"\nsecret = "reconciler-url"\nconnection = "reconciler"')), "prod");
  // Wires: bindings read from a wrangler config, and none at all.
  const withWrangler = importFacts(cloudflareState());
  withWrangler.facts.push(importWrangler(WRANGLER));
  add(withWrangler, WIRED);
  add(importFacts(cloudflareState()), { bundles: [{ name: "cloister-router", workerdServiceName: "cloister" }, { name: "mache" }], wires: [] });
  add({ kind: null, formatVersion: null, facts: [], skipped: {} }, WIRED);
  return out;
}

/** The variant names a union in the generated schema declares. */
const variantsOf = (def) => SCHEMA.$defs[def].oneOf.map((v) => Object.keys(v.properties)[0]).sort();

test("every report matches the declared InspectReport, and together they reach every kind of finding", async () => {
  const subjects = new Set();
  const bases = new Set();
  for (const report of await reports()) {
    const out = await declaredOutput("InspectReport", declaredReport(report));
    for (const f of out.findings) {
      subjects.add(Object.keys(f.subject)[0]);
      bases.add(Object.keys(f.basis)[0]);
    }
  }
  assert.deepEqual([...subjects].sort(), variantsOf("FindingSubject"), "a subject the schema declares and no test reaches");
  assert.deepEqual([...bases].sort(), variantsOf("FindingBasis"), "a basis the schema declares and no test reaches");
});

test("a finding the projection has no form for is refused by name, not dropped", () => {
  assert.throws(() => declaredFinding({ kind: "unknown", route: {} }), /a finding with no declared form: \["kind","route"\]/);
});
