// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An object written as `kubernetes_manifest` is read like the same object
// written as the provider's typed resource (ADR-0073, amendment of
// 2026-11-23).
//
// The plan fixture is written once, as typed resources. Every test here
// rewrites it as manifests (`asManifests`), so both forms are always the same
// plan, and a difference between their reports is a difference in reading.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { projectObjectSpec, renderSpec } from "../../../gen/facts-spec.mjs";
import { KUBERNETES_API_SPEC, KUBERNETES_MAPPING, KUBERNETES_SPEC } from "../../lib/facts/cloudflare.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { buildReport, sectionsOf } from "../../lib/facts/report.mjs";
import { validateMapping } from "../../lib/facts/validate.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const plan = () => JSON.parse(readFileSync(here("../../../test/fixtures/terraform/kubernetes-plan.show.json"), "utf8"));
const resourcesOf = (doc) => doc.planned_values.root_module.resources;
const configOf = (doc) => doc.configuration.root_module.resources;

// ── the same plan, written as manifests ─────────────────────────────────────

const KINDS = {
  kubernetes_deployment_v1: ["apps/v1", "Deployment"],
  kubernetes_job_v1: ["batch/v1", "Job"],
  kubernetes_service_v1: ["v1", "Service"],
  kubernetes_namespace_v1: ["v1", "Namespace"],
};
const one = (x) => (Array.isArray(x) ? x[0] : x);

/** The object a typed resource describes, as Kubernetes writes it. */
function objectOf(resource) {
  const [apiVersion, kind] = KINDS[resource.type];
  const values = resource.values;
  const meta = one(values.metadata);
  const object = { apiVersion, kind, metadata: { name: meta.name, ...(meta.namespace ? { namespace: meta.namespace } : {}) } };
  const spec = one(values.spec);
  if (kind === "Service") {
    object.spec = { type: spec.type, selector: spec.selector, ports: spec.port.map((p) => ({ name: p.name, port: p.port, targetPort: Number(p.target_port) })) };
  } else if (spec?.template) {
    const template = one(spec.template);
    const pod = one(template.spec);
    object.spec = {
      ...(kind === "Job" ? {} : { selector: { matchLabels: one(spec.selector).match_labels } }),
      template: {
        metadata: { labels: one(template.metadata).labels },
        spec: {
          containers: pod.container.map((c) => ({
            name: c.name,
            image: c.image,
            ...(c.args ? { args: c.args } : {}),
            ...(c.command ? { command: c.command } : {}),
            env: c.env.map((e) => {
              const ref = one(one(e.value_from)?.secret_key_ref);
              return {
                name: e.name,
                ...(e.value !== null ? { value: e.value } : {}),
                ...(ref ? { valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } } } : {}),
              };
            }),
            ports: c.port.map((p) => ({ name: p.name, containerPort: p.container_port })),
          })),
        },
      },
    };
  }
  return object;
}

/** `kubernetes_deployment_v1.caller` → `kubernetes_manifest.deployment_caller`. */
function manifestAddress(address) {
  const [type, name] = address.split(".");
  return `kubernetes_manifest.${type.replace(/^kubernetes_/, "").replace(/_v1$/, "")}_${name}`;
}

/** Every reference string in an expression tree. */
function referencesIn(node) {
  if (Array.isArray(node)) return node.flatMap(referencesIn);
  if (!node || typeof node !== "object") return [];
  return [...(Array.isArray(node.references) ? node.references : []), ...Object.entries(node).filter(([k]) => k !== "references").flatMap(([, v]) => referencesIn(v))];
}

/** Rewrite every reference into a renamed resource, in place. */
function renameReferences(node, renamed) {
  if (Array.isArray(node)) { node.forEach((n) => renameReferences(n, renamed)); return; }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.references)) {
    node.references = node.references.map((ref) => {
      for (const [from, to] of renamed) if (ref === from || ref.startsWith(`${from}.`)) return to + ref.slice(from.length);
      return ref;
    });
  }
  for (const [key, value] of Object.entries(node)) if (key !== "references") renameReferences(value, renamed);
}

/**
 * The plan with the typed resources at `addresses` (all of them by default)
 * written as `kubernetes_manifest`: the object in `manifest`, and one
 * expression that takes from what the typed resource took from.
 */
function asManifests(doc, addresses = resourcesOf(doc).filter((r) => KINDS[r.type]).map((r) => r.address)) {
  const renamed = new Map(addresses.map((a) => [a, manifestAddress(a)]));
  for (const [i, r] of resourcesOf(doc).entries()) {
    if (!renamed.has(r.address)) continue;
    const address = renamed.get(r.address);
    resourcesOf(doc)[i] = {
      address, mode: "managed", type: "kubernetes_manifest", name: address.split(".")[1], provider_name: r.provider_name,
      schema_version: 1, values: { manifest: objectOf(r) }, sensitive_values: { manifest: {} },
    };
  }
  for (const r of configOf(doc)) if (!renamed.has(r.address)) renameReferences(r.expressions, renamed);
  for (const [i, r] of configOf(doc).entries()) {
    if (!renamed.has(r.address)) continue;
    const address = renamed.get(r.address);
    const takes = [...new Set(referencesIn(r.expressions))].map((ref) => {
      for (const [from, to] of renamed) if (ref === from || ref.startsWith(`${from}.`)) return to + ref.slice(from.length);
      return ref;
    });
    configOf(doc)[i] = {
      address, mode: "managed", type: "kubernetes_manifest", name: address.split(".")[1], provider_config_key: r.provider_config_key,
      expressions: { manifest: takes.length ? { references: takes } : {} },
    };
  }
  return doc;
}

const manifestOf = (doc, address) => resourcesOf(doc).find((r) => r.address === address);
const manifestConfigOf = (doc, address) => configOf(doc).find((r) => r.address === address);

/** What the report says about each resource, without the env rows (they have tests of their own). */
function readout(doc) {
  const imported = importFacts(doc);
  return {
    skipped: imported.skipped,
    sections: sectionsOf(imported.facts, imported.kind, { withRun: true })
      .map((s) => ({
        title: s.title,
        resources: s.resources
          .map((r) => ({
            name: r.name,
            attrs: r.attrs,
            dials: r.dials,
            bundle: r.bundle && {
              placement: r.bundle.placement, runs: r.bundle.runs, image: r.bundle.image, ports: r.bundle.ports,
              exposure: r.bundle.exposure, args: r.bundle.run.args, command: r.bundle.run.command,
            },
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

const workload = (doc, name, section) => {
  const imported = importFacts(doc);
  return sectionsOf(imported.facts, imported.kind, { withRun: true }).find((s) => s.title === section)?.resources.find((r) => r.name === name);
};
const envOf = (doc, name, section) => Object.fromEntries(workload(doc, name, section).bundle.run.env.map((e) => [e.name, e]));

// ── the same plan reads the same ─────────────────────────────────────────────

test("a plan written as manifests reports what the same plan written as typed resources reports", () => {
  const typed = readout(plan());
  const manifests = readout(asManifests(plan()));
  assert.deepEqual(manifests.skipped, {}, "a manifest was not read");
  assert.deepEqual(manifests, typed);
  // Not vacuous: the plan has a Deployment dialling a Service, a Job, and a Namespace.
  assert.deepEqual(typed.sections.map((s) => s.title), ["Kubernetes deployments", "Kubernetes jobs", "Kubernetes namespaces", "Kubernetes services"]);
  assert.ok(typed.sections.find((s) => s.title === "Kubernetes deployments").resources.some((r) => r.dials.length > 0));
});

test("each half of the plan may be written either way: a Service stands for a workload written the other way", () => {
  const typed = readout(plan());
  for (const addresses of [
    ["kubernetes_service_v1.server"],
    ["kubernetes_deployment_v1.server"],
    ["kubernetes_deployment_v1.caller", "kubernetes_job_v1.probe"],
    ["kubernetes_namespace_v1.shop", "kubernetes_service_v1.server", "kubernetes_job_v1.probe"],
  ]) {
    assert.deepEqual(readout(asManifests(plan(), addresses)), typed, addresses.join(", "));
  }
});

test("the findings against cluster.toml are the same, whichever way the plan is written", async () => {
  const { parseTomlToCluster } = await import("../../lib/cluster/toml-to-cluster.mjs");
  const cluster = await parseTomlToCluster(draftCluster(importFacts(plan()), { env: "prod" }).toml);
  const findings = (doc) => buildReport(importFacts(doc), cluster, { env: "prod" }).findings.map((f) => JSON.stringify(f)).sort();
  const typed = findings(plan());
  assert.ok(typed.length >= 2);
  assert.deepEqual(findings(asManifests(plan())), typed);
});

// ── env: a value is what the configuration says it is, or unknown ───────────

test("a secret reference and a workload's address are drafted from a manifest as they are from a typed resource", () => {
  const env = envOf(asManifests(plan()), "caller", "Kubernetes deployments");
  assert.deepEqual(env.DB_PASSWORD, { name: "DB_PASSWORD", kind: "secret", secret: "db-password", version: "latest" });
  assert.deepEqual([env.SERVER_URL.kind, env.SERVER_URL.to], ["workload", "server"]);
});

test("a manifest's value is a constant only when its expression takes from nothing", () => {
  const address = "kubernetes_manifest.deployment_caller";
  // The fixture's caller takes SERVER_URL from the Service. Which of its
  // values that reached is not written, so LOG_LEVEL is not drafted.
  const takes = asManifests(plan());
  const unknown = envOf(takes, "caller", "Kubernetes deployments").LOG_LEVEL;
  assert.equal(unknown.kind, "unknown");
  assert.deepEqual(unknown.from, ["kubernetes_manifest.service_server"]);
  const { toml, notes } = draftCluster(importFacts(takes), { env: "prod" });
  assert.ok(!/name = "LOG_LEVEL"/.test(toml), "a value of unknown origin was drafted");
  assert.ok(notes.some((n) => n.includes("env LOG_LEVEL is not drafted: its value is written in an object that takes values from kubernetes_manifest.service_server")));

  // An expression that takes from nothing: every value is the source's own text.
  const literal = asManifests(plan());
  manifestConfigOf(literal, address).expressions.manifest = {};
  assert.deepEqual(envOf(literal, "caller", "Kubernetes deployments").LOG_LEVEL, { name: "LOG_LEVEL", kind: "constant", value: "info" });
  assert.match(draftCluster(importFacts(literal), { env: "prod" }).toml, /name = "LOG_LEVEL"\nvalue = "info"/);

  // A variable is named, never copied.
  const variable = asManifests(plan());
  manifestConfigOf(variable, address).expressions.manifest = { references: ["var.log_level"] };
  assert.deepEqual(envOf(variable, "caller", "Kubernetes deployments").LOG_LEVEL, { name: "LOG_LEVEL", kind: "unknown", from: ["var.log_level"], inObject: true });

  // No configuration for it (a state document): nothing says where any value came from.
  const state = asManifests(plan());
  delete state.configuration;
  state.values = state.planned_values;
  delete state.planned_values;
  const stateEnv = envOf(state, "caller", "Kubernetes deployments");
  assert.deepEqual(stateEnv.LOG_LEVEL, { name: "LOG_LEVEL", kind: "unknown", from: [], inObject: true });
  assert.equal(stateEnv.DB_PASSWORD.kind, "secret");
});

test("a withheld env list is said in the draft, for a manifest as for a typed resource", () => {
  const doc = asManifests(plan());
  manifestOf(doc, "kubernetes_manifest.deployment_caller").sensitive_values.manifest = { spec: { template: { spec: { containers: [{ env: true }] } } } };
  const { notes } = draftCluster(importFacts(doc), { env: "prod" });
  assert.ok(notes.some((n) => n.startsWith('"caller": its env is marked sensitive and was not read')), notes.join("\n"));
});

// ── what the configuration cannot say is not guessed ────────────────────────

test("a manifest's configuration references are not read as edges: where in the object they sit is not written", async () => {
  // SERVER_URL's value is unknown until apply, so only the configuration
  // could say the caller uses the Service. For a typed resource it does, by
  // the block the reference is written in. For a manifest it cannot.
  const typed = plan();
  const typedRow = resourcesOf(typed).find((r) => r.address === "kubernetes_deployment_v1.caller").values.spec[0].template[0].spec[0].container[0].env[0];
  typedRow.value = null;
  assert.deepEqual(workload(typed, "caller", "Kubernetes deployments").dials.map((d) => [d.to, d.by]), [["server", "configuration"]]);

  const doc = asManifests(plan());
  delete manifestOf(doc, "kubernetes_manifest.deployment_caller").values.manifest.spec.template.spec.containers[0].env[0].value;
  assert.ok(manifestConfigOf(doc, "kubernetes_manifest.deployment_caller").expressions.manifest.references.includes("kubernetes_manifest.service_server"));
  assert.deepEqual(workload(doc, "caller", "Kubernetes deployments").dials, []);
  // A declared connection is then unknown, with the reason, never evidenced by a guess.
  const { parseTomlToCluster } = await import("../../lib/cluster/toml-to-cluster.mjs");
  const cluster = await parseTomlToCluster(draftCluster(importFacts(plan()), { env: "prod" }).toml);
  const caller = buildReport(importFacts(doc), cluster, { env: "prod" }).findings.find((f) => f.connection?.from === "caller");
  assert.equal(caller.kind, "unknown");
});

test("a kind no entry reads is named on the Not read line, and an object whose kind cannot be read is counted as such", () => {
  const doc = plan();
  const add = (name, manifest, sensitive = {}) => resourcesOf(doc).push({
    address: `kubernetes_manifest.${name}`, mode: "managed", type: "kubernetes_manifest", name, values: manifest === undefined ? {} : { manifest }, sensitive_values: sensitive,
  });
  add("ingress", { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "web", namespace: "shop" } });
  add("ingress_two", { apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name: "api", namespace: "shop" } });
  add("no_kind", { apiVersion: "v1", metadata: { name: "x" } });
  add("no_object", undefined);
  add("list", [{ apiVersion: "v1", kind: "Service" }]);
  add("spaced", { apiVersion: "v1", kind: "Service Account" });
  add("kind_sensitive", { apiVersion: "v1", kind: "Service", metadata: { name: "x" } }, { manifest: { kind: true } });
  add("all_sensitive", { apiVersion: "v1", kind: "Service", metadata: { name: "x" } }, { manifest: true });
  const { skipped, facts } = importFacts(doc);
  assert.deepEqual(skipped, {
    "kubernetes_manifest networking.k8s.io/v1 Ingress": 2,
    "kubernetes_manifest (kind not stated)": 6,
  });
  assert.ok(!facts.some((f) => f.address.startsWith("kubernetes_manifest.")), "an unread object produced a fact");
  // The draft says the same, so a draft is never taken for the whole plan.
  const { notes } = draftCluster(importFacts(doc), { env: "prod" });
  assert.ok(notes.includes("2 kubernetes_manifest networking.k8s.io/v1 Ingress resources were not read: no mapping describes that type"));
});

test("a marker on a parent object withholds everything under it", () => {
  // Walking on under a `true` finds no marker and would read the value as
  // public. The walk stops at the marker.
  const doc = asManifests(plan());
  manifestOf(doc, "kubernetes_manifest.deployment_server").sensitive_values.manifest = { spec: true };
  const server = workload(doc, "server", "Kubernetes deployments");
  assert.equal(server.bundle.image, "");
  assert.deepEqual(server.bundle.ports, []);
  assert.deepEqual(server.attrs, { "metadata.namespace": "shop" }, "what is outside the marked parent is still read");
  // Its pod labels are under the marker too, so the Service stands for nothing.
  assert.deepEqual(workload(doc, "probe", "Kubernetes jobs").dials, []);

  // The same for a field read through a nested object in a row.
  const secret = asManifests(plan());
  manifestOf(secret, "kubernetes_manifest.deployment_caller").sensitive_values.manifest = {
    spec: { template: { spec: { containers: [{ env: [{}, {}, { valueFrom: true }] }] } } },
  };
  const env = envOf(secret, "caller", "Kubernetes deployments");
  assert.notEqual(env.DB_PASSWORD.kind, "secret");
  assert.equal(env.SERVER_URL.kind, "workload");
});

// ── the mapping is held to both schemas ──────────────────────────────────────

const HELD = "kubernetes_manifest apps/v1 Deployment";
const edited = (change, spec = KUBERNETES_SPEC) => () => {
  const mapping = structuredClone(KUBERNETES_MAPPING);
  const provider = structuredClone(spec);
  change(mapping, provider);
  validateMapping(mapping, provider, KUBERNETES_API_SPEC);
};

for (const [what, change, message] of [
  ["a path the kind's schema does not have", (m) => { m.types[HELD].read.push("spec.nope"); }, /unknown attribute "kubernetes_manifest apps\/v1 Deployment\.spec\.nope"/],
  ["a provider-shaped path on a kind", (m) => { m.types[HELD].lists[0].path = "spec.template.spec.container"; }, /unknown attribute "kubernetes_manifest apps\/v1 Deployment\.spec\.template\.spec\.container"/],
  ["a kind the API's schema does not define", (m) => { m.types["kubernetes_manifest apps/v1 Nope"] = { name: "metadata.name" }; }, /reads a kind, apps\/v1 Nope, that the kubernetes spec does not define/],
  ["a kind of a resource no `objects` entry declares", (m) => { m.types["kubernetes_other apps/v1 Deployment"] = { name: "metadata.name" }; }, /names "kubernetes_other", which the mapping does not declare under "objects"/],
  ["a kind named by fewer values than `by` lists", (m) => { m.types["kubernetes_manifest Deployment"] = { name: "metadata.name" }; }, /must name kubernetes_manifest and its apiVersion and kind, one space apart/],
  ["reference attributes on a kind", (m) => { m.types[HELD].referenceAttrs = ["manifest"]; }, /referenceAttrs: an object held whole is one expression, and where a reference sits in it is not written/],
  ["configured rows on a kind", (m) => { m.types[HELD].configLists = [{ path: "spec.template.spec.containers.env", fields: ["name"] }]; }, /configLists: an object held whole has no rows in the configuration/],
  ["an env that names neither configured rows nor a list", (m) => { delete m.types[HELD].report.bundle.env.list; }, /env needs exactly one of "configured" \(a configList\) or "list" \(a list the entry reads\)/],
  ["an env field the list does not read", (m) => { m.types[HELD].report.bundle.env.secret = "valueFrom.configMapKeyRef.name"; }, /env secret "valueFrom\.configMapKeyRef\.name" is not a field of list "env"/],
  ["a holding resource that is also a type", (m) => { m.types.kubernetes_manifest = { name: "manifest" }; }, /kubernetes_manifest is read as the objects it holds, and cannot also be a type/],
  ["a `by` that repeats a field", (m) => { m.objects.kubernetes_manifest.by = ["kind", "kind"]; }, /"by" must list the object's fields that say what it is, each once/],
  ["an unknown key on an `objects` entry", (m) => { m.objects.kubernetes_manifest.guess = true; }, /objects\.kubernetes_manifest has unknown key "guess"/],
  ["a holding attribute the provider does not have", (m) => { m.objects.kubernetes_manifest.attr = "manifests"; }, /unknown attribute "kubernetes_manifest\.manifests"/],
  ["a holding attribute the provider types", (m, p) => { p.resources.kubernetes_manifest.attributes.manifest.type = "string"; }, /kubernetes_manifest\.manifest is typed by the provider; map its paths, not an object/],
]) {
  test(`the mapping validator refuses ${what}`, () => {
    assert.throws(edited(change), message);
  });
}

test("a kind that is like a provider type is held to Kubernetes' schema, not the provider's", () => {
  // A Service and a Namespace name what is read exactly as the provider does,
  // so their kinds are `like` the provider's types. Each is still checked
  // against its own schema: a path only the provider has is refused.
  assert.throws(edited((m) => { m.types["kubernetes_manifest v1 Service"].read.push("spec.session_affinity"); }), /unknown attribute "kubernetes_manifest v1 Service\.spec\.session_affinity"/);
  assert.doesNotThrow(edited((m) => { m.types["kubernetes_manifest v1 Service"].read.push("spec.sessionAffinity"); }));
});

// ── the API's schema is projected, not hand-written ─────────────────────────

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const WIDGET_API = {
  components: {
    schemas: {
      "x.Widget": {
        "x-kubernetes-group-version-kind": [{ group: "example.test", version: "v1", kind: "Widget" }],
        type: "object",
        properties: {
          apiVersion: { type: "string" },
          kind: { type: "string" },
          metadata: { allOf: [ref("x.Meta")], description: "a ref with a description, as OpenAPI v3 writes it" },
          spec: ref("x.Spec"),
          status: ref("x.Status"),
        },
      },
      "x.Meta": {
        type: "object",
        properties: {
          name: { type: "string" },
          labels: { type: "object", additionalProperties: { type: "string" } },
          owners: { type: "array", items: ref("x.Owner") },
        },
      },
      "x.Owner": { type: "object", properties: { uid: { type: "string" } } },
      "x.Spec": {
        type: "object",
        properties: {
          port: { "x-kubernetes-int-or-string": true },
          replicas: { type: "integer" },
          paused: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          items: { type: "array", items: ref("x.Item") },
        },
      },
      "x.Item": { type: "object", properties: { name: { type: "string" }, size: { type: "integer" }, detail: ref("x.Detail") } },
      "x.Detail": { type: "object", properties: { note: { type: "string" } } },
      "x.Status": { type: "object", properties: { ready: { type: "boolean" } } },
    },
  },
};
const WIDGET_MAPPING = {
  provider: "test/x",
  objects: { x_object: { attr: "body", by: ["apiVersion", "kind"] } },
  types: {
    "x_object example.test/v1 Widget": {
      name: "metadata.name",
      read: ["spec.replicas"],
      maps: ["metadata.labels"],
      lists: [{ path: "spec.items", read: ["name", "detail.note"] }],
    },
  },
};

test("a kind's projection holds every value field on a mapped path, and only the nested objects a mapped path walks", () => {
  const spec = projectObjectSpec([WIDGET_API], { api: "test", version: "1.0.0" }, WIDGET_MAPPING);
  const s = (type) => ({ sensitive: false, type });
  assert.deepEqual(spec, {
    api: "test",
    version: "1.0.0",
    objects: {
      "example.test/v1 Widget": {
        attributes: {
          apiVersion: s("string"),
          kind: s("string"),
          metadata: { nesting_mode: "single", sensitive: false, attributes: { labels: s(["map", "string"]), name: s("string") } },
          spec: {
            nesting_mode: "single",
            sensitive: false,
            attributes: {
              items: {
                nesting_mode: "list",
                sensitive: false,
                attributes: {
                  detail: { nesting_mode: "single", sensitive: false, attributes: { note: s("string") } },
                  name: s("string"),
                  size: s("number"),
                },
              },
              paused: s("bool"),
              port: s("dynamic"),
              replicas: s("number"),
              tags: s(["list", "string"]),
            },
          },
        },
      },
    },
  });
  // And the mapping validates against it, as the shipped one does against Kubernetes'.
  const provider = { resources: { x_object: { attributes: { body: s("dynamic") } } } };
  assert.doesNotThrow(() => validateMapping(WIDGET_MAPPING, provider, spec));
});

test("a kind the documents do not define, or define two ways, stops the projection", () => {
  const missing = structuredClone(WIDGET_MAPPING);
  missing.types["x_object example.test/v1 Gadget"] = { name: "metadata.name" };
  assert.throws(() => projectObjectSpec([WIDGET_API], { api: "test", version: "1.0.0" }, missing), /the test documents define no example\.test\/v1 Gadget/);
  // Every document carries a copy of the kinds it refers to. The copies must agree.
  const other = structuredClone(WIDGET_API);
  other.components.schemas["x.Spec"].properties.replicas = { type: "string" };
  assert.throws(() => projectObjectSpec([WIDGET_API, other], { api: "test", version: "1.0.0" }, WIDGET_MAPPING), /define example\.test\/v1 Widget more than one way/);
  // An identical copy is one definition.
  assert.doesNotThrow(() => projectObjectSpec([WIDGET_API, structuredClone(WIDGET_API)], { api: "test", version: "1.0.0" }, WIDGET_MAPPING));
});

test("the vendored Kubernetes projection is reproducible from Kubernetes' OpenAPI documents", (t) => {
  const dir = process.env.FACTS_KUBERNETES_OPENAPI;
  if (!dir) {
    t.skip(`set FACTS_KUBERNETES_OPENAPI to a directory holding Kubernetes ${KUBERNETES_API_SPEC.version}'s api/openapi-spec/v3 documents to check the projection byte for byte`);
    return;
  }
  const documents = ["api__v1_openapi.json", "apis__apps__v1_openapi.json", "apis__batch__v1_openapi.json"].map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  const projected = renderSpec(projectObjectSpec(documents, { api: KUBERNETES_API_SPEC.api, version: KUBERNETES_API_SPEC.version }, KUBERNETES_MAPPING));
  assert.equal(projected, readFileSync(here("../../lib/facts/spec/kubernetes-api.schema.json"), "utf8"));
});
