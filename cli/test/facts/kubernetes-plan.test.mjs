// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Kubernetes resources declared in Terraform are read like any other mapped
// provider: by a mapping file, with no code that knows the provider.
//
// What the mapping needed, and the reader gained for any mapping to use:
//   - a scalar inside a single nested block (`metadata.name`)
//   - an address BUILT from what a resource reads (a cluster DNS name)
//   - a resource that stands for another (a Service, for the workload whose
//     pods its selector matches)

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { emitK8sDir, graphDir, lowerDir } from "../../commands/cluster.mjs";
import { KUBERNETES_MAPPING, KUBERNETES_SPEC } from "../../lib/facts/cloudflare.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { buildReport, sectionsOf } from "../../lib/facts/report.mjs";
import { validateMapping } from "../../lib/facts/validate.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const plan = () => JSON.parse(readFileSync(here("../../../test/fixtures/terraform/kubernetes-plan.show.json"), "utf8"));
const resourcesOf = (doc) => doc.planned_values.root_module.resources;
const find = (doc, address) => resourcesOf(doc).find((r) => r.address === address);
const workloads = (doc) => {
  const imported = importFacts(doc);
  return sectionsOf(imported.facts, imported.kind, { withRun: true }).flatMap((s) => s.resources.map((r) => ({ ...r, section: s.title })));
};
const named = (doc, name, section) => workloads(doc).find((r) => r.name === name && r.section === section);

test("a Deployment, a Job, a Service and a Namespace in a plan are each read", () => {
  const sections = Object.fromEntries(sectionsOf(importFacts(plan()).facts, "plan").map((s) => [s.title, s.resources.map((r) => r.name).sort()]));
  assert.deepEqual(sections, {
    "Kubernetes deployments": ["caller", "server"],
    "Kubernetes jobs": ["probe"],
    "Kubernetes services": ["server"],
    "Kubernetes namespaces": ["shop"],
  });
  assert.deepEqual(importFacts(plan()).skipped, {});
});

test("a name is read from inside the metadata block, not from the Terraform label", () => {
  const doc = plan();
  find(doc, "kubernetes_deployment_v1.server").values.metadata[0].name = "renamed";
  // The selector still matches its pods, so the Service still stands for it.
  assert.ok(named(doc, "renamed", "Kubernetes deployments"));
  assert.equal(named(doc, "server", "Kubernetes deployments"), undefined);
});

test("a workload that dials a Service's cluster name dials the workload behind it", () => {
  const doc = plan();
  // probe names the address as a literal; caller takes it from the Service resource.
  assert.deepEqual(named(doc, "probe", "Kubernetes jobs").dials, [{ to: "server", section: "Kubernetes deployments", by: "address", where: "env SERVER_URL" }]);
  assert.deepEqual(named(doc, "caller", "Kubernetes deployments").dials.map((d) => [d.to, d.section]), [["server", "Kubernetes deployments"]]);
});

test("both cluster forms of the name are the same address", () => {
  for (const host of ["server.shop.svc.cluster.local", "server.shop.svc"]) {
    const doc = plan();
    find(doc, "kubernetes_job_v1.probe").values.spec[0].template[0].spec[0].container[0].env[0].value = `http://${host}:8080`;
    assert.equal(named(doc, "probe", "Kubernetes jobs").dials[0]?.to, "server", host);
  }
});

// `server.shop` is how a pod may dial a Service, and it is also a public
// hostname: `.shop` is a real top-level domain. Reading it as the Service
// would draw an edge to whatever shares the name. A missed edge is reported
// as unknown; a wrong one would be believed.
test("a two-label host is not taken for a Service: it could be anyone's domain", () => {
  const doc = plan();
  find(doc, "kubernetes_job_v1.probe").values.spec[0].template[0].spec[0].container[0].env[0].value = "https://server.shop/hostname";
  assert.deepEqual(named(doc, "probe", "Kubernetes jobs").dials, []);
});

test("a protocol read from a port's name is said to be a convention, in the draft", () => {
  const { notes } = draftCluster(importFacts(plan()), { env: "prod" });
  assert.ok(notes.some((n) => /"server": port 8080 is named "http", and its protocol \(art\.http\) is taken from that name\. A port name is free text here, so check it/.test(n)), notes.join("\n"));
  // A name the mapping has no protocol for is not drafted at all, as before.
  const doc = plan();
  find(doc, "kubernetes_deployment_v1.server").values.spec[0].template[0].spec[0].container[0].port[0].name = "metrics";
  assert.ok(draftCluster(importFacts(doc), { env: "prod" }).notes.some((n) => /port 8080 is served as "metrics", which has no appProtocol here; it is not drafted/.test(n)));
});

test("a Service that matches no workload, or two, stands for neither: an edge is never guessed", () => {
  const none = plan();
  find(none, "kubernetes_service_v1.server").values.spec[0].selector = { app: "nobody" };
  assert.deepEqual(named(none, "probe", "Kubernetes jobs").dials, []);

  const two = plan();
  // caller's pods now carry the label the Service selects on, as server's do.
  find(two, "kubernetes_deployment_v1.caller").values.spec[0].template[0].metadata[0].labels = { app: "server" };
  assert.deepEqual(named(two, "probe", "Kubernetes jobs").dials, []);

  const empty = plan();
  find(empty, "kubernetes_service_v1.server").values.spec[0].selector = {};
  assert.deepEqual(named(empty, "probe", "Kubernetes jobs").dials, []);
});

test("a Service in another namespace does not stand for a workload in this one", () => {
  const doc = plan();
  find(doc, "kubernetes_service_v1.server").values.metadata[0].namespace = "elsewhere";
  // Its cluster name is now server.elsewhere..., which nothing dials, and the
  // old name is nobody's.
  assert.deepEqual(named(doc, "probe", "Kubernetes jobs").dials, []);
});

test("an env value is sorted into what it is: an address, a constant, a secret reference", () => {
  const env = Object.fromEntries(named(plan(), "caller", "Kubernetes deployments").bundle.run.env.map((e) => [e.name, e]));
  assert.equal(env.SERVER_URL.kind, "workload");
  assert.equal(env.SERVER_URL.to, "server");
  assert.deepEqual(env.LOG_LEVEL, { name: "LOG_LEVEL", kind: "constant", value: "info" });
  assert.deepEqual(env.DB_PASSWORD, { name: "DB_PASSWORD", kind: "secret", secret: "db-password", version: "latest" });
});

test("a literal address shows the path after it, and the draft carries it", () => {
  const doc = plan();
  const expressions = doc.configuration.root_module.resources.find((r) => r.address === "kubernetes_job_v1.probe").expressions;
  expressions.spec[0].template[0].spec[0].container[0].env[0].value = { constant_value: "http://server.shop.svc.cluster.local:8080/v1/items?all=1" };
  const row = named(doc, "probe", "Kubernetes jobs").bundle.run.env[0];
  assert.deepEqual([row.kind, row.to, row.path], ["workload", "server", "/v1/items?all=1"]);
  const { toml, notes } = draftCluster(importFacts(doc), { env: "prod" });
  assert.match(toml, /name = "SERVER_URL"\nconnection = "server"\npath = "\/v1\/items\?all=1"/);
  // The path is known, so nobody is asked to add one for this row.
  assert.ok(!notes.some((n) => n.includes('"probe"') && n.includes("append a path")));
});

test("a literal that is not one whole URL, or carries credentials, stays a literal", () => {
  for (const value of ["see http://server.shop.svc.cluster.local:8080 for details", "http://user:pw@server.shop.svc.cluster.local:8080"]) {
    const doc = plan();
    doc.configuration.root_module.resources.find((r) => r.address === "kubernetes_job_v1.probe").expressions.spec[0].template[0].spec[0].container[0].env[0].value = { constant_value: value };
    assert.equal(named(doc, "probe", "Kubernetes jobs").bundle.run.env[0].kind, "constant", value);
  }
});

test("the plan drafts, and the draft lowers to a second placement and passes cluster k8s", async () => {
  const draft = draftCluster(importFacts(plan()), { env: "prod", name: "shop", local: "local" });
  assert.equal(draft.bundles, 3);
  assert.equal(draft.connections, 2);
  const dir = mkdtempSync(join(tmpdir(), "k8s-plan-"));
  try {
    writeFileSync(join(dir, "cluster.toml"), draft.toml);
    assert.deepEqual([...(await lowerDir({ root: dir, env: "local" })).written].sort(), ["caller.yaml", "probe.yaml", "server.yaml"]);
    const checked = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(checked.references.filter((r) => r.to).map((r) => [r.bundle, r.to]).sort(), [["caller", "server"], ["probe", "server"]]);
    const policy = readFileSync(join(dir, "k8s/server/20-networkpolicy.yaml"), "utf8");
    assert.deepEqual([...policy.matchAll(/kubernetes\.io\/metadata\.name: (\S+)/g)].map((m) => m[1]).sort(), ["caller", "probe"]);

    // The environment the plan describes names no manifest: it is described
    // by the plan. The commands that work from a manifest say so by name, and
    // the graph does not credit a policy nobody wrote.
    await assert.rejects(lowerDir({ root: dir, env: "prod" }), /is placed "kubernetes" for env "prod" and names no manifest\. `cloister cluster lower` works from a manifest/);
    await assert.rejects(emitK8sDir({ root: dir, env: "prod", out: join(dir, "prod") }), /names no manifest\. `cloister cluster k8s` works from a manifest/);
    const prod = await graphDir({ root: dir, env: "prod" });
    for (const edge of prod.edges) {
      assert.equal(edge.strength, "none");
      assert.match(edge.why, /no manifest here, so cloister writes no policy/);
    }
    assert.deepEqual((await graphDir({ root: dir, env: "local" })).edges.map((e) => e.strength), ["policy", "policy"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the declared connections are evidenced by the plan they were drafted from", async () => {
  const { parseTomlToCluster } = await import("../../lib/cluster/toml-to-cluster.mjs");
  const cluster = await parseTomlToCluster(draftCluster(importFacts(plan()), { env: "prod" }).toml);
  const imported = importFacts(plan());
  const { findings } = buildReport(imported, cluster, { env: "prod" });
  const kinds = findings.map((f) => f.kind ?? f.finding ?? f.status);
  assert.ok(findings.length >= 2);
  assert.deepEqual([...new Set(kinds)], ["evidenced"]);
});

// ── the mapping is held to the provider's own schema ─────────────────────────

const withService = (change) => {
  const mapping = structuredClone(KUBERNETES_MAPPING);
  change(mapping.types.kubernetes_service_v1, mapping);
  return mapping;
};

test("the shipped mapping follows the provider's schema", () => {
  assert.doesNotThrow(() => validateMapping(KUBERNETES_MAPPING, KUBERNETES_SPEC));
});

for (const [what, change, message] of [
  ["a host template that uses an attribute the entry does not read", (s) => { s.report.hosts = ["{metadata.uid}.svc"]; }, /hosts uses "\{metadata\.uid\}", which is not in its "read" list/],
  ["a host template that names no attribute", (s) => { s.report.hosts = ["fixed.example"]; }, /names no attribute: a fixed host is not a resource's address/],
  ["a selector that is not one of the entry's maps", (s) => { s.report.standsFor.selector = "spec.other"; }, /selector must be one of the entry's "maps"/],
  ["a label map the target does not read", (s) => { s.report.standsFor.labels = "metadata.labels"; }, /labels "metadata\.labels" is not one of kubernetes_deployment_v1's "maps"/],
  ["a target type the mapping does not describe", (s) => { s.report.standsFor.toTypes = ["kubernetes_pod_v1"]; }, /names "kubernetes_pod_v1", which this mapping does not describe/],
  ["a scope attribute the target does not read", (s, m) => { m.types.kubernetes_deployment_v1.read = []; m.types.kubernetes_deployment_v1.report.show = []; }, /scope "metadata\.namespace" is not read by kubernetes_deployment_v1/],
  ["a map that is not a map of strings", (s) => { s.maps = ["spec.type"]; s.report.standsFor.selector = "spec.type"; }, /"kubernetes_service_v1\.spec\.type" is not a map of strings/],
  ["an unknown key on standsFor", (s) => { s.report.standsFor.guess = true; }, /standsFor has unknown key "guess"/],
]) {
  test(`the mapping validator refuses ${what}`, () => {
    assert.throws(() => validateMapping(withService(change), KUBERNETES_SPEC), message);
  });
}

test("no reader names a Kubernetes resource type: the mapping is the only place", () => {
  for (const file of ["report.mjs", "draft.mjs", "terraform.mjs", "facts.mjs", "import.mjs", "validate.mjs"]) {
    const source = readFileSync(here(`../../lib/facts/${file}`), "utf8");
    for (const type of Object.keys(KUBERNETES_MAPPING.types)) assert.ok(!source.includes(type), `${file} names ${type}`);
  }
});

// ── one definition, and every type that refers to it is run ──────────────────

const RAW = JSON.parse(readFileSync(here("../../lib/facts/mappings/kubernetes.json"), "utf8"));
const likeOf = (type) => RAW.types[type].like ?? type;
const WORKLOAD_TYPES = Object.keys(KUBERNETES_MAPPING.types).filter((type) => KUBERNETES_MAPPING.types[type].report?.bundle);

test("the pod template is written out once, and every other workload type refers to it", () => {
  const written = WORKLOAD_TYPES.filter((type) => RAW.types[type].like === undefined);
  assert.deepEqual(written, ["kubernetes_deployment_v1"]);
  for (const type of WORKLOAD_TYPES) {
    if (type === "kubernetes_deployment_v1") continue;
    // What a type may say for itself is its section and whether it runs to
    // completion. How a pod template is read is not restated anywhere.
    const { like, report, ...rest } = RAW.types[type];
    assert.equal(like, "kubernetes_deployment_v1", type);
    assert.deepEqual(rest, {}, `${type} restates more than its report`);
    // The second name of the same type says nothing for itself at all.
    const { section, bundle, ...other } = report ?? {};
    assert.ok(section === undefined || typeof section === "string", type);
    assert.deepEqual(other, {}, type);
    if (bundle !== undefined) assert.deepEqual(bundle, { runs: "job" }, type);
  }
});

// The fixture holds a Deployment and a Job. Every OTHER mapped workload type
// is run too: the same resource, declared as that type, must read the same.
for (const type of WORKLOAD_TYPES) {
  const isJob = KUBERNETES_MAPPING.types[type].report.bundle.runs === "job";
  test(`a workload declared as ${type} reads as one, with its image, port, env and edges`, () => {
    const doc = plan();
    const from = isJob ? "kubernetes_job_v1.probe" : "kubernetes_deployment_v1.caller";
    const name = from.split(".")[1];
    for (const list of [resourcesOf(doc), doc.configuration.root_module.resources]) {
      const resource = list.find((r) => r.address === from);
      resource.type = type;
      resource.address = `${type}.${name}`;
    }
    const imported = importFacts(doc);
    assert.deepEqual(imported.skipped, {}, "a mapped type was skipped");
    const read = named(doc, name, KUBERNETES_MAPPING.types[type].report.section);
    assert.ok(read, `${type} produced no workload`);
    assert.equal(read.bundle.image, "registry.k8s.io/e2e-test-images/agnhost:2.53");
    assert.equal(read.bundle.runs, isJob ? "job" : "service");
    assert.equal(read.bundle.placement, "kubernetes");
    assert.deepEqual(read.dials.map((d) => d.to), ["server"]);
    assert.equal(read.bundle.run.env.find((e) => e.name === "SERVER_URL").kind, "workload");
  });
}

// A Service must be able to stand for every long-running workload type.
for (const type of WORKLOAD_TYPES.filter((t) => KUBERNETES_MAPPING.types[t].report.bundle.runs !== "job")) {
  test(`a Service stands for a workload declared as ${type}`, () => {
    const doc = plan();
    for (const list of [resourcesOf(doc), doc.configuration.root_module.resources]) {
      const resource = list.find((r) => r.address === "kubernetes_deployment_v1.server");
      resource.type = type;
      resource.address = `${type}.server`;
    }
    assert.deepEqual(named(doc, "probe", "Kubernetes jobs").dials.map((d) => [d.to, d.section]), [["server", KUBERNETES_MAPPING.types[type].report.section]]);
  });
}

test("both names of the Service type, and of the Namespace type, read the same", () => {
  for (const [from, type] of [["kubernetes_service_v1.server", "kubernetes_service"], ["kubernetes_namespace_v1.shop", "kubernetes_namespace"]]) {
    const doc = plan();
    for (const list of [resourcesOf(doc), doc.configuration.root_module.resources]) {
      const resource = list.find((r) => r.address === from);
      if (!resource) continue;
      resource.type = type;
      resource.address = `${type}.${from.split(".")[1]}`;
    }
    assert.deepEqual(importFacts(doc).skipped, {});
    assert.deepEqual(named(doc, "probe", "Kubernetes jobs").dials.map((d) => d.to), ["server"], type);
  }
});

// ── `like` itself ────────────────────────────────────────────────────────────

test("an entry that is like another gets everything it says, with its differences laid over", async () => {
  const { expandMapping } = await import("../../lib/facts/mapping.mjs");
  const mapping = { provider: "x/y", types: { a: { name: "n", read: ["p", "q"], report: { section: "A", show: ["p"] } }, b: { like: "a", read: ["p"], report: { section: "B" } } } };
  const expanded = expandMapping(mapping);
  assert.deepEqual(expanded.types.b, { name: "n", read: ["p"], report: { section: "B", show: ["p"] } });
  assert.equal(expanded.types.b.like, undefined);
  // The input is untouched, and the base is not shared with the copy.
  assert.equal(mapping.types.b.like, "a");
  expanded.types.b.report.show.push("z");
  assert.deepEqual(expanded.types.a.report.show, ["p"]);
});

test("a `like` that names nothing, itself, or another `like` is refused by name", async () => {
  const { expandMapping } = await import("../../lib/facts/mapping.mjs");
  const types = (t) => ({ provider: "x/y", types: t });
  assert.throws(() => expandMapping(types({ b: { like: "missing" } })), /b is like "missing", which this mapping does not describe/);
  assert.throws(() => expandMapping(types({ b: { like: "b" } })), /b is like itself/);
  assert.throws(() => expandMapping(types({ a: { name: "n" }, b: { like: "a" }, c: { like: "b" } })), /c is like b, which is itself like "a"\. Name the entry that is written out in full/);
  // A name from the document must not find Object.prototype.
  assert.throws(() => expandMapping(types({ b: { like: "constructor" } })), /which this mapping does not describe/);
});

test("a type that is like another is still held to its own schema", () => {
  // The Job type has no `strategy`; the Deployment type does. A path that is
  // valid for the entry it is like must still be refused for the Job.
  const mapping = structuredClone(KUBERNETES_MAPPING);
  mapping.types.kubernetes_job_v1.read = [...mapping.types.kubernetes_job_v1.read, "spec.min_ready_seconds"];
  assert.throws(() => validateMapping(mapping, KUBERNETES_SPEC), /unknown attribute "kubernetes_job_v1\.spec\.min_ready_seconds"/);
});
