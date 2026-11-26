// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bundle is one container (ADR-0074, amendment of 2026-11-26). A workload
// may run several, a sidecar beside the one that serves. What a bundle is
// started with is read from one container: the only one, or the one the
// platform says serves (Cloud Run and Knative let only it have a port), and
// otherwise the workload is not drafted. Two are never merged into one.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";

import { GOOGLE_MAPPING, GOOGLE_SPEC, KUBERNETES_MAPPING, KUBERNETES_OBJECT_SPECS, KUBERNETES_SPEC } from "../../lib/facts/cloudflare.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { validateMapping } from "../../lib/facts/validate.mjs";

const digest = (n) => `registry.example.com/app@sha256:${String(n).repeat(64).slice(0, 64)}`;
const constant = (value) => ({ constant_value: value });

/** A plan of one Cloud Run v2 service running `containers`, env read from its configuration. */
function cloudRun(containers) {
  return {
    format_version: "1.2",
    planned_values: { root_module: { resources: [{
      address: "google_cloud_run_v2_service.api", mode: "managed", type: "google_cloud_run_v2_service", name: "api",
      provider_name: "registry.opentofu.org/hashicorp/google",
      values: { name: "api", location: "us-central1", project: "example-project", ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY", template: [{ containers }] },
      sensitive_values: {},
    }] } },
    configuration: { root_module: { resources: [{
      address: "google_cloud_run_v2_service.api", mode: "managed", type: "google_cloud_run_v2_service", name: "api",
      expressions: { template: [{ containers: containers.map((c) => ({ env: (c.env ?? []).map((e) => ({ name: constant(e.name), value: constant(e.value) })) })) }] },
    }] } },
  };
}

/** A plan of one object a kubernetes_manifest holds whole, running `containers`. */
function manifest(apiVersion, kind, containers) {
  const object = { apiVersion, kind, metadata: { name: "api", namespace: "shop" }, spec: { template: { metadata: { labels: { app: "api" } }, spec: { containers } } } };
  return {
    format_version: "1.2",
    planned_values: { root_module: { resources: [{
      address: "kubernetes_manifest.api", mode: "managed", type: "kubernetes_manifest", name: "api",
      provider_name: "registry.opentofu.org/hashicorp/kubernetes",
      values: { manifest: object }, sensitive_values: { manifest: {} },
    }] } },
    // The object is one expression that takes from nothing: its values are the source's own text.
    configuration: { root_module: { resources: [{ address: "kubernetes_manifest.api", mode: "managed", type: "kubernetes_manifest", name: "api", expressions: { manifest: {} } }] } },
  };
}

const draft = async (doc) => {
  const drafted = draftCluster(importFacts(doc), { env: "prod" });
  return { notes: drafted.notes, cluster: await parseTomlToCluster(drafted.toml) };
};

const APP = { name: "app", image: digest(1), args: ["--listen", ":8080"], env: [{ name: "MODE", value: "app" }] };
const SIDECAR = { name: "collector", image: digest(2), args: ["--config", "/etc/otel.yaml"], env: [{ name: "MODE", value: "sidecar" }] };

test("Cloud Run: the bundle is the container with a port, and its sidecar is named, not merged", async () => {
  const { notes, cluster } = await draft(cloudRun([{ ...APP, ports: [{ name: "http1", container_port: 8080 }] }, SIDECAR]));
  const [api] = cluster.bundles;
  assert.equal(api.kind.external.image, APP.image);
  assert.deepEqual(api.kind.external.args, APP.args);
  assert.deepEqual(api.kind.external.env.map((e) => [e.name, e.value]), [["MODE", "app"]]);
  assert.deepEqual(api.ports.map((p) => [p.name, p.port]), [["http1", 8080]]);
  assert.ok(notes.includes(`"api": drafted from its container "app", the one that serves. "collector" runs beside it and is not drafted: a bundle is one container`), notes.join("\n"));
  // It does not matter where in the list the serving container is.
  const reversed = await draft(cloudRun([SIDECAR, { ...APP, ports: [{ name: "http1", container_port: 8080 }] }]));
  assert.equal(reversed.cluster.bundles[0].kind.external.image, APP.image);
});

test("Cloud Run: several containers and no single one with a port is not drafted", async () => {
  for (const containers of [[APP, SIDECAR], [{ ...APP, ports: [{ container_port: 8080 }] }, { ...SIDECAR, ports: [{ container_port: 9090 }] }]]) {
    const { notes, cluster } = await draft(cloudRun(containers));
    assert.deepEqual(cluster.bundles, []);
    assert.ok(notes.includes(`"api" (Cloud Run services) is not drafted: it runs 2 containers ("app", "collector"), and these inputs do not say which one serves. A bundle is one container`), notes.join("\n"));
  }
});

test("a single container is the bundle, as before", async () => {
  const { notes, cluster } = await draft(cloudRun([APP]));
  assert.equal(cluster.bundles[0].kind.external.image, APP.image);
  assert.ok(!notes.some((n) => /container/.test(n) && /a bundle is one container/i.test(n)), notes.join("\n"));
});

test("Kubernetes says no container serves: a pod of two is not drafted, whichever has a port", async () => {
  const containers = [{ name: "app", image: digest(1), ports: [{ name: "http", containerPort: 8080 }] }, { name: "proxy", image: digest(3) }];
  const { notes, cluster } = await draft(manifest("apps/v1", "Deployment", containers));
  assert.deepEqual(cluster.bundles, []);
  assert.ok(notes.some((n) => n.startsWith(`"api" (Kubernetes deployments) is not drafted: it runs 2 containers ("app", "proxy")`)), notes.join("\n"));
});

test("Knative, as Cloud Run: the container with a port serves", async () => {
  const containers = [
    { name: "app", image: digest(1), args: ["--serve"], ports: [{ name: "h2c", containerPort: 8080 }], env: [{ name: "MODE", value: "app" }] },
    { name: "agent", image: digest(4), args: ["--watch"], env: [{ name: "MODE", value: "agent" }] },
  ];
  const { notes, cluster } = await draft(manifest("serving.knative.dev/v1", "Service", containers));
  const [api] = cluster.bundles;
  assert.equal(api.kind.external.image, digest(1));
  assert.deepEqual(api.kind.external.args, ["--serve"]);
  assert.deepEqual(api.kind.external.env.map((e) => [e.name, e.value]), [["MODE", "app"]]);
  assert.ok(notes.some((n) => n.startsWith(`"api": drafted from its container "app", the one that serves. "agent" runs beside it`)), notes.join("\n"));
});

test("∀ containers: a drafted bundle is exactly one container's, and is drafted only when one can be named", async () => {
  // Each container's args and env carry its own number, so a merge cannot hide.
  const containerArb = fc.record({ port: fc.boolean() });
  await fc.assert(fc.asyncProperty(fc.array(containerArb, { minLength: 1, maxLength: 4 }), async (shape) => {
    const containers = shape.map(({ port }, i) => ({
      name: `c${i}`, image: digest(i + 1), args: [`--from=c${i}`], env: [{ name: `FROM_C${i}`, value: `c${i}` }],
      ...(port ? { ports: [{ name: "http1", container_port: 8080 + i }] } : {}),
    }));
    const { cluster } = await draft(cloudRun(containers));
    const withPort = shape.flatMap(({ port }, i) => (port ? [i] : []));
    const expected = shape.length === 1 ? 0 : withPort.length === 1 ? withPort[0] : null;
    if (expected === null) return cluster.bundles.length === 0;
    const [bundle] = cluster.bundles;
    const external = bundle.kind.external;
    return external.image === digest(expected + 1)
      && external.args.every((a) => a === `--from=c${expected}`)
      && external.env.every((e) => e.name === `FROM_C${expected}` && e.value === `c${expected}`);
  }), { numRuns: 300 });
});

test("every workload entry names its containers, and reads a process from one", () => {
  const edited = (mapping, type, edit) => {
    const copy = structuredClone(mapping);
    edit(copy.types[type].report.bundle, copy.types[type]);
    return copy;
  };
  const RUN = "google_cloud_run_v2_service";
  const google = (edit) => () => validateMapping(edited(GOOGLE_MAPPING, RUN, edit), GOOGLE_SPEC);
  assert.doesNotThrow(google(() => {}));
  assert.throws(google((b) => { delete b.container; }), /bundle needs a "container": the list of the workload's containers, so that one container is drafted and several are never merged/);
  assert.throws(google((b) => { b.container.list = "env"; delete b.container.serving; }), /image must be read from the container list "env"/);
  assert.throws(google((b) => { b.container.serving = "containers"; }), /container serving "containers" must be a list the entry reads within each container/);
  assert.throws(google((b) => { b.container.list = "nope"; }), /container needs a "list" the entry reads/);
  assert.throws(google((b) => { b.container.extra = true; }), /unknown key "extra"/);
  const DEPLOYMENT = "kubernetes_manifest apps/v1 Deployment";
  const held = (edit) => () => validateMapping(edited(KUBERNETES_MAPPING, DEPLOYMENT, edit), KUBERNETES_SPEC, KUBERNETES_OBJECT_SPECS);
  assert.doesNotThrow(held(() => {}));
  assert.throws(held((b) => { b.env.list = "containers"; b.env.name = "name"; b.env.value = "image"; }), /env must be a list within each container/);
});

test("an exposure value is sorted, or left unsorted with a reason, never both", () => {
  const edited = (edit) => {
    const mapping = structuredClone(GOOGLE_MAPPING);
    edit(mapping.types.google_cloud_run_v2_service.report.bundle.exposure);
    return () => validateMapping(mapping, GOOGLE_SPEC);
  };
  assert.doesNotThrow(edited(() => {}));
  assert.throws(edited((e) => { e.unsorted.INGRESS_TRAFFIC_ALL = "why"; }), /exposure lists "INGRESS_TRAFFIC_ALL" as sorted and unsorted/);
  assert.throws(edited((e) => { e.unsorted.INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER = ""; }), /exposure unsorted "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" needs a reason/);
});
