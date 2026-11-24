// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The facts reader fails closed (ADR-0073). An invariant-strength review found
// places where it did not: a row the document marks whole still gave up its
// arguments; a withheld port took a default as if it were absent; a name the
// document withholds was replaced by the Terraform label; a reference the
// reader could not classify was read as naming nothing. Each is held here,
// two of them as properties over generated input rather than as examples.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";

import {
  CLOUDFLARE_MAPPING,
  CLOUDFLARE_SPEC,
  KNATIVE_SERVING_SPEC,
  KUBERNETES_MAPPING,
  KUBERNETES_OBJECT_SPECS,
  KUBERNETES_SPEC,
  importResource,
  readsHeldObject,
} from "../../lib/facts/cloudflare.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { objectKind } from "../../lib/facts/mapping.mjs";
import { sectionsOf } from "../../lib/facts/report.mjs";
import { expressionSources } from "../../lib/facts/terraform.mjs";
import { validateMapping } from "../../lib/facts/validate.mjs";

const plan = (resources) => ({ format_version: "1.2", planned_values: { root_module: { resources } }, configuration: { root_module: { resources: [] } } });
const manifest = (name, object, marker) => ({
  address: `kubernetes_manifest.${name}`, mode: "managed", type: "kubernetes_manifest", name,
  values: { manifest: object }, sensitive_values: marker === undefined ? { manifest: {} } : { manifest: marker },
});
const podObject = (apiVersion, kind, name, containers) => ({
  apiVersion, kind, metadata: { name, namespace: "shop" },
  spec: { template: { metadata: { labels: { app: name } }, spec: { containers } } },
});
const workloads = (doc) => {
  const imported = importFacts(doc);
  return sectionsOf(imported.facts, imported.kind, { withRun: true }).flatMap((s) => s.resources.map((r) => ({ ...r, section: s.title })));
};
const containersAt = (marker) => (marker === undefined ? {} : { spec: { template: { spec: { containers: marker } } } });

// ── F1: a value under a marked node never reaches a fact or a draft (∀) ────

/** A marker a document may hold at one position: absent, false, true, or malformed. */
const leafMarker = fc.constantFrom(undefined, false, true, "true", 1, null);
/** A marker for a list of strings: one of the above, or one per element. */
const stringsMarker = fc.oneof(leafMarker, fc.array(fc.constantFrom(undefined, false, true), { maxLength: 3 }));
/** A row's marker: one of the above, a list (malformed for a row), or one per field. */
const rowMarker = fc.oneof(
  leafMarker,
  fc.constant([true]),
  fc.record({ name: leafMarker, image: leafMarker, args: stringsMarker, command: stringsMarker }, { requiredKeys: [] }),
);
/** The list's marker: one of the above (true withholds the list), or one per row, possibly too few. */
const listMarker = fc.oneof(leafMarker, fc.constant({}), fc.array(rowMarker, { maxLength: 3 }));

const isAbsent = (m) => m === undefined || m === false;
const isRow = (m) => m !== null && typeof m === "object" && !Array.isArray(m);
/** True when a field's value may be read: nothing above it, or on it, says otherwise. */
function readable(list, index, field, kind) {
  if (!(isAbsent(list) || Array.isArray(list))) return false;
  if (Array.isArray(list) && index >= list.length) return false;
  const row = Array.isArray(list) ? list[index] : undefined;
  if (!(isAbsent(row) || isRow(row))) return false;
  const m = isRow(row) ? row[field] : undefined;
  if (kind === "strings") return isAbsent(m) || (Array.isArray(m) && m.every(isAbsent));
  return isAbsent(m);
}

test("no value under a node the document marks, or marks malformed, reaches a fact or a draft (∀)", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 3 }), listMarker, (count, marker) => {
    const containers = Array.from({ length: count }, (_, i) => ({
      name: `name-${i}-zq`, image: `image-${i}-zq`, args: [`arg-${i}-zq`], command: [`cmd-${i}-zq`],
    }));
    const doc = plan([manifest("app", podObject("apps/v1", "Deployment", "app", containers), containersAt(marker))]);
    const imported = importFacts(doc);
    const seen = JSON.stringify(imported.facts) + draftCluster(imported, { env: "prod" }).toml;
    containers.forEach((c, i) => {
      for (const [field, kind] of [["name", "scalar"], ["image", "scalar"], ["args", "strings"], ["command", "strings"]]) {
        const token = Array.isArray(c[field]) ? c[field][0] : c[field];
        if (seen.includes(token)) assert.ok(readable(marker, i, field, kind), `${token} was read under ${JSON.stringify(marker)}`);
      }
    });
  }), { numRuns: 500 });
});

test("a row marked whole is withheld and said to be, for a typed resource as for a manifest", () => {
  const typed = {
    address: "kubernetes_deployment_v1.app", mode: "managed", type: "kubernetes_deployment_v1", name: "app",
    values: { metadata: [{ name: "app", namespace: "shop" }], spec: [{ template: [{ metadata: [{ labels: { app: "app" } }], spec: [{ container: [{ name: "app", image: "registry.test/app:1", args: ["--token=SYNTHETIC-0000"], command: ["/bin/app"] }] }] }] }] },
    sensitive_values: { metadata: [{}], spec: [{ template: [{ metadata: [{}], spec: [{ container: [true] }] }] }] },
  };
  const [app] = workloads(plan([typed]));
  assert.deepEqual(app.bundle.run.args, []);
  assert.ok(app.withheld.includes("container"));
  assert.ok(!draftCluster(importFacts(plan([typed])), { env: "prod" }).toml.includes("SYNTHETIC-0000"));
});

// ── F3: an expression's sources are total (∀) ───────────────────────────────

const referenceString = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "var.x", "local.y", "data.kubernetes_secret_v1.s", "each.value", "count.index",
    "kubernetes_secret_v1.app", "kubernetes_secret_v1.app.data", "kubernetes_secret_v1.app[0]",
    "kubernetes_secret_v1.app[0].data", "kubernetes_secret_v1.café", "kubernetes_secret_v1.café.data", "module.m.out",
  ),
);

test("an expression names nothing only when it names nothing, and every name it gives is sorted (∀)", () => {
  fc.assert(fc.property(fc.array(fc.oneof(referenceString, fc.integer())), (refs) => {
    const { references, unresolved } = expressionSources({ references: refs });
    const named = refs.filter((r) => typeof r === "string");
    assert.equal(references.length + unresolved.length === 0, named.length === 0);
    const within = (r) => references.some((a) => r === a || r.startsWith(`${a}.`) || r.startsWith(`${a}[`));
    for (const r of named) assert.ok(within(r) || unresolved.includes(r), `${JSON.stringify(r)} was dropped`);
  }), { numRuns: 1000 });
  // A Terraform identifier is a Unicode identifier.
  assert.deepEqual(expressionSources({ references: ["kubernetes_secret_v1.café.data", "kubernetes_secret_v1.café"] }).references, ["kubernetes_secret_v1.café"]);
});

test("a value is not drafted as a constant when the object takes from something the reader cannot classify", () => {
  const object = podObject("apps/v1", "Deployment", "app", [{ name: "app", image: "registry.test/app:1", env: [{ name: "FROM_SECRET", value: "SYNTHETIC-2222" }] }]);
  const doc = plan([manifest("app", object)]);
  doc.configuration.root_module.resources = [{ address: "kubernetes_manifest.app", mode: "managed", type: "kubernetes_manifest", name: "app", expressions: { manifest: { references: ["kubernetes_secret_v1.app[0].data"] } } }];
  const [app] = workloads(doc);
  assert.deepEqual(app.bundle.run.env, [{ name: "FROM_SECRET", kind: "unknown", from: ["kubernetes_secret_v1.app[0].data"], inObject: true }]);
  assert.ok(!draftCluster(importFacts(doc), { env: "prod" }).toml.includes("SYNTHETIC-2222"));
});

// ── F2: withheld is not absent ───────────────────────────────────────────────

const knative = (ports, portsMarker) => {
  const containers = [{ name: "app", image: "registry.test/app:1", ...(ports ? { ports } : {}) }];
  const object = { apiVersion: "serving.knative.dev/v1", kind: "Service", metadata: { name: "app", namespace: "shop" }, spec: { template: { spec: { containers } } } };
  const marker = portsMarker === undefined ? {} : { spec: { template: { spec: { containers: [{ ports: portsMarker }] } } } };
  return plan([manifest("app", object, marker)]);
};

test("a port the document withholds takes no default, and the draft says so", () => {
  // Absent: Knative's own default, said to be assumed.
  assert.deepEqual(workloads(knative(undefined))[0].bundle.ports, [{ name: "http1", port: 8080, appProtocol: "art.http", assumed: true }]);
  // A port row marked whole: no port is assumed in its place.
  for (const marker of [[true], true]) {
    const doc = knative([{ name: "h2c", containerPort: 9000 }], marker);
    const [app] = workloads(doc);
    assert.deepEqual(app.bundle.ports, [], JSON.stringify(marker));
    assert.equal(app.bundle.portsWithheld, true);
    assert.ok(draftCluster(importFacts(doc), { env: "prod" }).notes.includes(`"app": a port it declares is marked sensitive and was not read; no port is assumed in its place`));
  }
  // A port's name withheld: its protocol is not known, so it is not taken as the default.
  const named = knative([{ name: "h2c", containerPort: 9000 }], [{ name: true }]);
  const [app] = workloads(named);
  assert.deepEqual(app.bundle.ports, [{ name: "", port: 9000, appProtocol: "", assumed: false, byConvention: false, nameWithheld: true }]);
  const { notes, toml } = draftCluster(importFacts(named), { env: "prod" });
  assert.ok(notes.includes(`"app": port 9000's name, which says how it is served, is marked sensitive and was not read; it is not drafted`));
  assert.ok(!/port = 9000/.test(toml));
});

test("a name the document withholds is no name, never the Terraform label", () => {
  // A Service named after its Terraform label would answer at an address nothing answers at.
  const service = { apiVersion: "v1", kind: "Service", metadata: { name: "orders-svc", namespace: "shop" }, spec: { type: "ClusterIP", selector: { app: "orders" } } };
  const orders = podObject("apps/v1", "Deployment", "orders", [{ name: "orders", image: "registry.test/orders:1" }]);
  const caller = podObject("apps/v1", "Deployment", "caller", [{ name: "caller", image: "registry.test/caller:1", env: [{ name: "ORDERS_URL", value: "http://api.shop.svc.cluster.local" }] }]);
  const doc = plan([manifest("api", service, { metadata: { name: true } }), manifest("orders", orders), manifest("caller", caller)]);
  const imported = importFacts(doc);
  assert.equal(imported.facts.find((f) => f.address === "kubernetes_manifest.api").name, "");
  assert.deepEqual(workloads(doc).find((w) => w.name === "caller").dials, []);
  // A typed resource the same.
  const typed = {
    address: "kubernetes_deployment_v1.app", mode: "managed", type: "kubernetes_deployment_v1", name: "app",
    values: { metadata: [{ name: "real-name", namespace: "shop" }] }, sensitive_values: { metadata: [{ name: true }] },
  };
  assert.equal(importFacts(plan([typed])).facts[0].name, "");
  // An entry that says nothing of a name keeps the label, which is all it has.
  const tunnel = { address: "cloudflare_zero_trust_tunnel_cloudflared.t", mode: "managed", type: "cloudflare_zero_trust_tunnel_cloudflared", name: "t", values: {}, sensitive_values: {} };
  assert.ok(CLOUDFLARE_MAPPING.types.cloudflare_zero_trust_tunnel_cloudflared);
  assert.equal(typeof importFacts(plan([tunnel])).facts[0].name, "string");
});

// ── F4, F5: what a document cannot be trusted to say ────────────────────────

test("a document's type with a space in it is not read as a kind of held object", () => {
  const object = podObject("apps/v1", "Deployment", "app", [{ name: "app", image: "registry.test/app:1" }]);
  const doc = plan([{ address: "other_thing.app", mode: "managed", type: "kubernetes_manifest apps/v1 Deployment", name: "app", values: object, sensitive_values: {} }]);
  const { facts, skipped } = importFacts(doc);
  assert.deepEqual(facts, []);
  assert.deepEqual(skipped, { "kubernetes_manifest apps/v1 Deployment": 1 });
});

test("markers that are not an object mark the whole resource: nothing of it is read", () => {
  const object = podObject("apps/v1", "Deployment", "app", [{ name: "app", image: "registry.test/app:1", env: [{ name: "K", value: "SYNTHETIC-3333" }] }]);
  for (const markers of [true, "true", 1, null, []]) {
    const resource = manifest("app", object);
    resource.sensitive_values = markers;
    const { facts, skipped } = importFacts(plan([resource]));
    assert.deepEqual([facts.length, skipped], [0, { "kubernetes_manifest (kind not stated)": 1 }], JSON.stringify(markers));
    // Read directly, a typed resource gives up nothing either.
    const typed = { address: "kubernetes_deployment_v1.app", mode: "managed", type: "kubernetes_deployment_v1", name: "app", values: { metadata: [{ name: "app", namespace: "shop" }] }, sensitive_values: markers };
    const [fact] = importFacts(plan([typed])).facts;
    assert.deepEqual([fact.name, fact.attrs["metadata.namespace"]], ["", undefined], JSON.stringify(markers));
  }
  // No markers at all means nothing is marked.
  const unmarked = manifest("app", object);
  delete unmarked.sensitive_values;
  assert.equal(importFacts(plan([unmarked])).facts.length, 1);
});

// ── F6: what was validated cannot change ─────────────────────────────────────

test("the mappings and schemas are frozen all the way down once validated", () => {
  const frozen = (value) => value === null || typeof value !== "object" || (Object.isFrozen(value) && Object.values(value).every(frozen));
  for (const value of [CLOUDFLARE_MAPPING, KUBERNETES_MAPPING, KUBERNETES_SPEC, KNATIVE_SERVING_SPEC, ...KUBERNETES_OBJECT_SPECS]) assert.ok(frozen(value));
  assert.throws(() => { KUBERNETES_MAPPING.types["kubernetes_manifest v1 Namespace"] = {}; }, TypeError);
});

// ── F7: every held kind the mapping reads is run, not a fixture's list ─────

for (const type of Object.keys(KUBERNETES_MAPPING.types).filter((t) => readsHeldObject(t) && KUBERNETES_MAPPING.types[t].report?.bundle)) {
  test(`a workload written as ${type} is read, with its image, port and env`, () => {
    const { values } = objectKind(KUBERNETES_MAPPING, type);
    const [apiVersion, kind] = values;
    const object = podObject(apiVersion, kind, "app", [{ name: "app", image: "registry.test/app:1", env: [{ name: "LOG", value: "info" }], ports: [{ name: "http1", containerPort: 8080 }] }]);
    const [app] = workloads(plan([manifest("app", object)]));
    assert.ok(app, `${type} was not read`);
    assert.equal(app.section, KUBERNETES_MAPPING.types[type].report.section);
    assert.equal(app.bundle.image, "registry.test/app:1");
    assert.deepEqual(app.bundle.ports.map((p) => [p.name, p.port]), [["http1", 8080]]);
    assert.deepEqual(app.bundle.run.env.map((e) => e.name), ["LOG"]);
  });
}

// ── the mapping format refuses what it does not define ──────────────────────

const edited = (change) => () => {
  const mapping = structuredClone(KUBERNETES_MAPPING);
  change(mapping);
  validateMapping(mapping, KUBERNETES_SPEC, KUBERNETES_OBJECT_SPECS);
};
const HELD = "kubernetes_manifest apps/v1 Deployment";

for (const [what, change, message] of [
  ["a key the mapping format does not define", (m) => { m.typez = {}; }, /the mapping has unknown key "typez"/],
  ["a mistyped key on an entry", (m) => { m.types[HELD].lits = m.types[HELD].lists; }, /kubernetes_manifest apps\/v1 Deployment has unknown key "lits"/],
  ["a mistyped key on a list", (m) => { m.types[HELD].lists[0].reed = ["name"]; }, /kubernetes_manifest apps\/v1 Deployment lists has unknown key "reed"/],
]) {
  test(`the mapping validator refuses ${what}`, () => {
    assert.throws(edited(change), message);
  });
}

// A list is kept in a fact under the last segment of its path. Paths that
// exist in the schema can still collide there, so the schema here has them.
const rowOf = (attributes) => ({ sensitive: false, nesting_mode: "list", attributes });
const text = { sensitive: false, type: "string" };
const LISTS_SPEC = {
  resources: {
    x_thing: {
      attributes: {
        name: text, env: text,
        a: rowOf({ env: rowOf({ name: text }) }),
        b: rowOf({ env: rowOf({ name: text }), maps: rowOf({ name: text }), envWithheld: rowOf({ name: text }) }),
      },
    },
  },
};
const withLists = (lists, read = []) => ({ provider: "test/x", types: { x_thing: { name: "name", read, lists } } });

for (const [what, mapping, message] of [
  ["two lists kept under one name", withLists([{ path: "a.env", read: ["name"] }, { path: "b.env", read: ["name"] }]), /lists "a\.env" and "b\.env" would both be kept as "env"/],
  ["a list kept under a name a fact already uses", withLists([{ path: "b.maps", read: ["name"] }]), /list "b\.maps" would be kept as "maps", which a fact already uses/],
  ["a list kept where another list's withheld flag goes", withLists([{ path: "b.envWithheld", read: ["name"] }]), /would be kept as "envWithheld", which a fact already uses/],
  ["a list kept under a name its read list also writes", withLists([{ path: "a.env", read: ["name"] }], ["env"]), /list "a\.env" would be kept as "env", which its "read" list also writes/],
]) {
  test(`the mapping validator refuses ${what}`, () => {
    assert.doesNotThrow(() => validateMapping(withLists([{ path: "a.env", read: ["name"] }]), LISTS_SPEC));
    assert.throws(() => validateMapping(mapping, LISTS_SPEC), message);
  });
}

test("the shipped mappings pass the stricter validator", () => {
  assert.doesNotThrow(() => validateMapping(KUBERNETES_MAPPING, KUBERNETES_SPEC, KUBERNETES_OBJECT_SPECS));
  assert.doesNotThrow(() => validateMapping(CLOUDFLARE_MAPPING, CLOUDFLARE_SPEC));
});

test("a fact states the provider of the mapping that read it, and an entry from none is refused", () => {
  const resource = { address: "kubernetes_service_v1.x", type: "kubernetes_service_v1", name: "x", values: { metadata: [{ name: "x" }] }, sensitive: {} };
  assert.equal(importResource(resource, KUBERNETES_MAPPING.types.kubernetes_service_v1).source, "terraform:kubernetes");
  // A copy is not an entry of a loaded mapping: it was not validated, and names no provider.
  assert.throws(
    () => importResource(resource, structuredClone(KUBERNETES_MAPPING.types.kubernetes_service_v1)),
    /kubernetes_service_v1\.x was read with an entry no loaded mapping holds/,
  );
});
