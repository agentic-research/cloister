// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The v1 Cloud Run service (`google_cloud_run_service`), shaped like the
// Knative Service it is, read as the v2 one is; and a v2 service's every URL
// (`urls`) as an address it is dialled at.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { buildReport, sectionsOf } from "../../lib/facts/report.mjs";

const constant = (value) => ({ constant_value: value });
const IMAGE = `registry.example.com/orders@sha256:${"1".repeat(64)}`;

/** A plan of one v1 Cloud Run service. `annotations` are the service's own. */
function v1Service({ name = "orders", annotations = {}, containers, account = "orders@example-project.iam.gserviceaccount.com" } = {}) {
  const running = containers ?? [{ name: "app", image: IMAGE, ports: [{ name: "h2c", container_port: 8080 }], env: [{ name: "MODE", value: "live" }] }];
  return {
    address: `google_cloud_run_service.${name}`, mode: "managed", type: "google_cloud_run_service", name,
    provider_name: "registry.opentofu.org/hashicorp/google",
    values: {
      name, location: "us-central1", project: "example-project",
      metadata: [{ annotations }],
      template: [{ spec: [{ service_account_name: account, containers: running }] }],
    },
    sensitive_values: {},
    configured: { template: [{ spec: [{ containers: running.map((c) => ({ env: (c.env ?? []).map((e) => ({ name: constant(e.name), value: constant(e.value) })) })) }] }] },
  };
}
const planOf = (...resources) => ({
  format_version: "1.2",
  planned_values: { root_module: { resources: resources.map(({ configured, ...r }) => r) } },
  configuration: { root_module: { resources: resources.map((r) => ({ address: r.address, mode: "managed", type: r.type, name: r.name, expressions: r.configured ?? {} })) } },
});
const workloads = (doc) => {
  const imported = importFacts(doc);
  return sectionsOf(imported.facts, imported.kind, { withRun: true, registry: imported.registry }).flatMap((s) => s.resources.map((r) => ({ ...r, section: s.title })));
};

test("a v1 service is a Cloud Run workload: its containers, env, ports and who it runs as", async () => {
  const [orders] = workloads(planOf(v1Service({ annotations: { "run.googleapis.com/ingress": "internal" } })));
  assert.equal(orders.section, "Cloud Run services");
  assert.equal(orders.identity, "serviceAccount:orders@example-project.iam.gserviceaccount.com");
  assert.equal(orders.bundle.placement, "cloudRun");
  assert.equal(orders.bundle.image, IMAGE);
  assert.deepEqual(orders.bundle.ports.map((p) => [p.name, p.port, p.appProtocol]), [["h2c", 8080, "art.http2"]]);
  assert.deepEqual(orders.bundle.run.env, [{ name: "MODE", kind: "constant", value: "live" }]);
  const drafted = draftCluster(importFacts(planOf(v1Service({ annotations: { "run.googleapis.com/ingress": "internal" } }))), { env: "prod" });
  const cluster = await parseTomlToCluster(drafted.toml);
  assert.deepEqual(cluster.bundles.map((b) => [b.name, b.placements[0].kind, b.ports[0].expose]), [["orders", "cloudRun", "cluster"]]);
});

test("its ingress is the run.googleapis.com/ingress annotation, sorted as the v2 setting is", () => {
  const exposure = (annotations) => workloads(planOf(v1Service({ annotations })))[0].bundle.exposure;
  assert.deepEqual(exposure({ "run.googleapis.com/ingress": "internal" }), { attr: 'metadata.annotations["run.googleapis.com/ingress"]', setting: "internal", expose: "cluster" });
  assert.equal(exposure({ "run.googleapis.com/ingress": "all" }).expose, "edge");
  const balanced = exposure({ "run.googleapis.com/ingress": "internal-and-cloud-load-balancing" });
  assert.equal(balanced.expose, "");
  assert.match(balanced.why, /only through an external load balancer, and cloister reads no load balancer/);
  // Not set in the configuration: the plan does not say, so it is unknown, never the API's default.
  assert.deepEqual(exposure({}), { attr: 'metadata.annotations["run.googleapis.com/ingress"]', setting: "", expose: "" });
});

test("a v1 invoker row reaches a v1 service by its name", () => {
  const member = {
    address: "google_cloud_run_service_iam_member.public", mode: "managed", type: "google_cloud_run_service_iam_member", name: "public",
    provider_name: "registry.opentofu.org/hashicorp/google",
    values: { service: "orders", location: "us-central1", project: "example-project", role: "roles/run.invoker", member: "allUsers", condition: [] },
    sensitive_values: {},
  };
  const [orders] = workloads(planOf(v1Service(), member));
  assert.deepEqual(orders.access, [{ label: "invoker", principal: "allUsers", public: true }]);
});

test("a v2 service is dialled at any of its URLs, not only its main one", () => {
  // A state document: the URLs are known. The caller holds the deterministic URL, which is not the main one.
  const v2 = (name, extra = {}, env = []) => ({
    address: `google_cloud_run_v2_service.${name}`, mode: "managed", type: "google_cloud_run_v2_service", name,
    provider_name: "registry.opentofu.org/hashicorp/google",
    values: { name, location: "us-central1", project: "example-project", ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY", template: [{ containers: [{ name: "app", image: IMAGE, env }] }], ...extra },
    sensitive_values: {},
  });
  const state = (resources) => ({ format_version: "1.0", values: { root_module: { resources } } });
  const target = v2("reconciler", {
    uri: "https://reconciler-1111111111-uc.a.run.app",
    urls: ["https://reconciler-1111111111-uc.a.run.app", "https://reconciler-111111111111.us-central1.run.app"],
  });
  const caller = v2("workqueue", {}, [{ name: "RECONCILER_URL", value: "https://reconciler-111111111111.us-central1.run.app" }]);
  const dials = (doc) => workloads(doc).find((w) => w.name === "workqueue").dials.map((d) => d.to);
  assert.deepEqual(dials(state([target, caller])), ["reconciler"]);
  // Without urls, the deterministic URL matches nothing: it is unknown, not guessed from the name.
  const withoutUrls = structuredClone(target);
  delete withoutUrls.values.urls;
  assert.deepEqual(dials(state([withoutUrls, caller])), []);
  // A report reads the same: one service, dialled by the other.
  const report = buildReport(importFacts(state([target, caller])), undefined);
  assert.ok(report.sections.some((s) => s.title === "Cloud Run services"));
});
