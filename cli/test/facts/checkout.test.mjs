// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A checkout supplies the CRDs, and the entries, for kinds cloister does not
// ship (ADR-0073, amendment of 2026-11-24). A declaration wins only where it
// says it does: a row lists in `replaces` each kind it replaces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";

import { KUBERNETES_MAPPING, SHIPPED } from "../../lib/facts/cloudflare.mjs";
import { checkoutRows, readWithCheckout } from "../../lib/facts/checkout.mjs";
import { entryOf } from "../../lib/facts/facts.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { buildReport, sectionsOf } from "../../lib/facts/report.mjs";

// ── A CRD, written as a cluster would export it ─────────────────────────────

const text = { type: "string" };
const container = (without = []) => ({
  type: "object",
  properties: Object.fromEntries(Object.entries({
    name: text,
    image: text,
    args: { type: "array", items: text },
    command: { type: "array", items: text },
    env: { type: "array", items: { type: "object", properties: {
      name: text, value: text,
      valueFrom: { type: "object", properties: { secretKeyRef: { type: "object", properties: { name: text, key: text } } } },
    } } },
    ports: { type: "array", items: { type: "object", properties: { name: text, containerPort: { type: "integer" } } } },
  }).filter(([field]) => !without.includes(field))),
});
const podTemplate = (without) => ({
  type: "object",
  properties: {
    metadata: { type: "object", properties: { labels: { type: "object", additionalProperties: text } } },
    spec: { type: "object", properties: { containers: { type: "array", items: container(without) } } },
  },
});
/** A CRD for `<group>/<version> <kind>` whose spec holds a pod template at `spec.template`. */
const crdYaml = ({ group, kind, version = "v1", plural = `${kind.toLowerCase()}s`, without = [] }) => stringify({
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: `${plural}.${group}` },
  spec: {
    group,
    names: { kind, plural },
    scope: "Namespaced",
    versions: [{ name: version, served: true, storage: true, schema: { openAPIV3Schema: { type: "object", properties: { spec: { type: "object", properties: { template: podTemplate(without) } } } } } }],
  },
});
const WIDGET = "example.test/v1 Widget";
const KNATIVE = "serving.knative.dev/v1 Service";
const widgetCrd = (options = {}) => crdYaml({ group: "example.test", kind: "Widget", ...options });
const knativeCrd = (options = {}) => crdYaml({ group: "serving.knative.dev", kind: "Service", ...options });

/** A checkout entry for Widgets: its pod template read as a Deployment's is. */
const widgetEntry = (more = {}) => ({
  name: "metadata.name",
  read: ["metadata.namespace"],
  podTemplate: "spec.template",
  report: { ...structuredClone(KUBERNETES_MAPPING.types["kubernetes_manifest apps/v1 Deployment"].report), section: "Widgets" },
  ...more,
});
const widgetMapping = (more) => JSON.stringify({ types: { [`kubernetes_manifest ${WIDGET}`]: widgetEntry(more) } });

/** A checkout of files, read from memory: `files` maps a path to its text. */
function checkout(files, { crds = [], mappings = [], env, cluster = CLUSTER } = {}) {
  const read = (path) => {
    if (!Object.hasOwn(files, path)) throw new Error(`no such file: ${path}`);
    return files[path];
  };
  return readWithCheckout({
    crds: crds.map((row) => ({ env: "", replaces: [], from: "cluster.toml", path: row.file, ...row })),
    mappings: mappings.map((file) => ({ file, path: file, from: "cluster.toml" })),
    read,
    env,
    cluster,
  });
}
/** Environments come from placement and connection rows. */
const CLUSTER = { bundles: [{ name: "orders", placements: [{ env: "prod" }, { env: "staging" }] }], connections: [] };

const plan = (resources) => ({ format_version: "1.2", planned_values: { root_module: { resources } }, configuration: { root_module: { resources: [] } } });
const manifest = (name, object) => ({
  address: `kubernetes_manifest.${name}`, mode: "managed", type: "kubernetes_manifest", name,
  values: { manifest: object }, sensitive_values: { manifest: {} },
});
const widget = (name) => manifest(name, {
  apiVersion: "example.test/v1",
  kind: "Widget",
  metadata: { name, namespace: "shop" },
  spec: { template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name: "app",
    image: "registry.example.com/orders@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    ports: [{ name: "http", containerPort: 8080 }],
    env: [{ name: "MODE", value: "plain" }],
  }] } } },
});

// ── A kind cloister does not ship ───────────────────────────────────────────

test("a checkout's CRD and entry read a kind cloister does not ship, its pod template as a Deployment's", () => {
  const { registry, checkout: provenance } = checkout(
    { "crds/widgets.yaml": widgetCrd(), "inspect.mapping.json": widgetMapping() },
    { crds: [{ file: "crds/widgets.yaml" }], mappings: ["inspect.mapping.json"] },
  );
  const imported = importFacts(plan([widget("orders")]), registry);
  assert.deepEqual(imported.skipped, {});
  const [fact] = imported.facts;
  assert.equal(fact.type, `kubernetes_manifest ${WIDGET}`);
  assert.equal(fact.source, "terraform:kubernetes");
  assert.equal(fact.name, "orders");
  // podTemplate: containers, ports and env read where a Deployment's are.
  assert.deepEqual(fact.attrs.containers.map((c) => c.name), ["app"]);
  assert.deepEqual(fact.attrs.ports, [{ name: "http", containerPort: 8080 }]);
  assert.deepEqual(fact.attrs.env, [{ name: "MODE", value: "plain" }]);
  assert.deepEqual(fact.attrs.maps, { "spec.template.metadata.labels": { app: "orders" } });
  const [section] = sectionsOf(imported.facts, imported.kind, { withRun: true, registry: imported.registry });
  assert.equal(section.title, "Widgets");
  assert.equal(section.resources[0].bundle.placement, "kubernetes");
  assert.deepEqual(section.resources[0].bundle.ports.map((p) => [p.port, p.appProtocol]), [[8080, "art.http"]]);
  assert.deepEqual(provenance.kinds, [{ kind: WIDGET, schema: "crds/widgets.yaml", replaced: "", entry: "inspect.mapping.json" }]);
  // Without the checkout, cloister does not read it, and says so.
  assert.deepEqual(importFacts(plan([widget("orders")])).skipped, { [`kubernetes_manifest ${WIDGET}`]: 1 });
});

test("cloister's own mappings are not changed by a checkout's, and a fact holds the entry that read it", () => {
  const { registry } = checkout(
    { "crds/widgets.yaml": widgetCrd(), "m.json": widgetMapping() },
    { crds: [{ file: "crds/widgets.yaml" }], mappings: ["m.json"] },
  );
  assert.equal(SHIPPED.mappedType(`kubernetes_manifest ${WIDGET}`), undefined);
  assert.ok(registry.mappedType(`kubernetes_manifest ${WIDGET}`));
  // cloister's entries are the same objects in both, so a fact either reads means one thing.
  assert.equal(registry.mappedType("kubernetes_manifest apps/v1 Deployment"), SHIPPED.mappedType("kubernetes_manifest apps/v1 Deployment"));
  const [fact] = importFacts(plan([widget("orders")]), registry).facts;
  assert.equal(entryOf(fact), registry.mappedType(`kubernetes_manifest ${WIDGET}`));
  // The entry is no field of the fact: JSON and every walk over its keys leave it out.
  assert.deepEqual(Object.keys(fact), ["source", "address", "type", "name", "attrs"]);
  assert.ok(!JSON.stringify(fact).includes("podTemplate"));
  // A report reads with the registry that read the facts.
  const report = buildReport(importFacts(plan([widget("orders")]), registry), undefined);
  assert.ok(report.sections.some((s) => s.title === "Widgets"));
});

// ── Replacing a definition, only where it is listed ─────────────────────────

test("a row replaces cloister's projection of a kind it lists, and cloister's entry is checked against the replacement", () => {
  const { registry, checkout: provenance } = checkout(
    { "crds/knative.yaml": knativeCrd() },
    { crds: [{ file: "crds/knative.yaml", replaces: [KNATIVE] }] },
  );
  assert.deepEqual(provenance.kinds, [{ kind: KNATIVE, schema: "crds/knative.yaml", replaced: "cloister's knative-serving 1.24.0 projection", entry: "cloister" }]);
  // cloister's entry still reads it.
  assert.equal(registry.mappedType(`kubernetes_manifest ${KNATIVE}`), KUBERNETES_MAPPING.types[`kubernetes_manifest ${KNATIVE}`]);
  // A replacement without a path cloister's entry reads refuses the run, naming the path.
  assert.throws(
    () => checkout({ "crds/knative.yaml": knativeCrd({ without: ["ports"] }) }, { crds: [{ file: "crds/knative.yaml", replaces: [KNATIVE] }] }),
    /with the checkout's files, .*serving\.knative\.dev\/v1 Service.*ports/,
  );
});

test("an overlap a row does not list is refused, and so is a listed kind with nothing to replace", () => {
  assert.throws(
    () => checkout({ "crds/knative.yaml": knativeCrd() }, { crds: [{ file: "crds/knative.yaml" }] }),
    /crds\/knative\.yaml defines serving\.knative\.dev\/v1 Service, which cloister's knative-serving 1\.24\.0 projection defines already: list it in replaces/,
  );
  const files = { "crds/widgets.yaml": widgetCrd(), "m.json": widgetMapping() };
  assert.throws(
    () => checkout(files, { crds: [{ file: "crds/widgets.yaml", replaces: [WIDGET] }], mappings: ["m.json"] }),
    /lists example\.test\/v1 Widget in replaces, and nothing above it defines example\.test\/v1 Widget: a replacement that replaces nothing is a mistake/,
  );
  assert.throws(
    () => checkout(files, { crds: [{ file: "crds/widgets.yaml", replaces: [KNATIVE] }], mappings: ["m.json"] }),
    /crds\/widgets\.yaml lists serving\.knative\.dev\/v1 Service in replaces, and does not define it/,
  );
  assert.throws(
    () => checkout(files, { crds: [{ file: "crds/widgets.yaml", replaces: [WIDGET, WIDGET] }], mappings: ["m.json"] }),
    /replaces lists example\.test\/v1 Widget twice/,
  );
  assert.throws(
    () => checkout(files, { crds: [{ file: "crds/widgets.yaml", replaces: ["Widget"] }], mappings: ["m.json"] }),
    /replaces lists "Widget", which is not a kind/,
  );
});

test("two rows at one level may not define one kind: neither is above the other", () => {
  const files = { "a.yaml": widgetCrd(), "b.yaml": widgetCrd(), "m.json": widgetMapping() };
  assert.throws(
    () => checkout(files, { crds: [{ file: "a.yaml" }, { file: "b.yaml" }], mappings: ["m.json"] }),
    /b\.yaml and a\.yaml both define example\.test\/v1 Widget, for every environment/,
  );
  assert.throws(
    () => checkout(files, { crds: [{ file: "a.yaml", env: "prod" }, { file: "b.yaml", env: "prod" }], mappings: ["m.json"], env: "prod" }),
    /b\.yaml and a\.yaml both define example\.test\/v1 Widget, for prod/,
  );
  // Even replacing the same thing: two replacements of one kind at one level are two answers.
  assert.throws(
    () => checkout({ "a.yaml": knativeCrd(), "b.yaml": knativeCrd() }, { crds: [{ file: "a.yaml", replaces: [KNATIVE] }, { file: "b.yaml", replaces: [KNATIVE] }] }),
    /b\.yaml and a\.yaml both define serving\.knative\.dev\/v1 Service/,
  );
});

test("an environment's row replaces a row for every environment, in that environment only, when it says so", () => {
  const files = { "crds/widgets.yaml": widgetCrd(), "crds/prod/widgets.yaml": widgetCrd(), "m.json": widgetMapping() };
  const rows = [{ file: "crds/widgets.yaml" }, { file: "crds/prod/widgets.yaml", env: "prod", replaces: [WIDGET] }];
  const prod = checkout(files, { crds: rows, mappings: ["m.json"], env: "prod" }).checkout;
  assert.deepEqual(prod.kinds, [{ kind: WIDGET, schema: "crds/prod/widgets.yaml", replaced: "crds/widgets.yaml", entry: "m.json" }]);
  const staging = checkout(files, { crds: rows, mappings: ["m.json"], env: "staging" }).checkout;
  assert.deepEqual(staging.kinds, [{ kind: WIDGET, schema: "crds/widgets.yaml", replaced: "", entry: "m.json" }]);
  assert.deepEqual(staging.files.map((f) => [f.file, f.applies]), [["crds/widgets.yaml", true], ["crds/prod/widgets.yaml", false], ["m.json", true]]);
  // Without `replaces`, the environment's row is refused: no precedence rule picks one.
  assert.throws(
    () => checkout(files, { crds: [rows[0], { file: "crds/prod/widgets.yaml", env: "prod" }], mappings: ["m.json"], env: "prod" }),
    /crds\/prod\/widgets\.yaml defines example\.test\/v1 Widget, which crds\/widgets\.yaml defines already: list it in replaces/,
  );
  // An environment's row may replace cloister's projection directly too.
  const direct = checkout({ "k.yaml": knativeCrd() }, { crds: [{ file: "k.yaml", env: "prod", replaces: [KNATIVE] }], env: "prod" }).checkout;
  assert.equal(direct.kinds[0].replaced, "cloister's knative-serving 1.24.0 projection");
});

test("a row's environment is one cluster.toml names, and rows for particular environments need --env", () => {
  const files = { "w.yaml": widgetCrd(), "m.json": widgetMapping() };
  assert.throws(
    () => checkout(files, { crds: [{ file: "w.yaml", env: "prdo" }], mappings: ["m.json"], env: "prdo" }),
    /\[\[inspect\.crds\]\] row for w\.yaml names environment "prdo", which no placement or connection in cluster\.toml names/,
  );
  assert.throws(
    () => checkout(files, { crds: [{ file: "w.yaml", env: "prod" }], mappings: ["m.json"] }),
    /say which environment this plan describes with --env/,
  );
  // A connection's target row names an environment too.
  const cluster = { bundles: [], connections: [{ from: "a", name: "b", targets: [{ env: "edge", bundle: "c" }] }] };
  assert.doesNotThrow(() => checkout(files, { crds: [{ file: "w.yaml", env: "edge" }], mappings: ["m.json"], env: "edge", cluster }));
});

test("a file a flag adds may only add kinds", () => {
  const files = { "w.yaml": widgetCrd(), "k.yaml": knativeCrd(), "m.json": widgetMapping() };
  const flag = (row) => ({ env: "", replaces: [], from: "--crd", path: row.file, ...row });
  const run = (crds) => readWithCheckout({
    crds, mappings: [{ file: "m.json", path: "m.json", from: "--mapping" }], read: (p) => files[p], cluster: CLUSTER,
  });
  assert.deepEqual(run([flag({ file: "w.yaml" })]).checkout.kinds, [{ kind: WIDGET, schema: "w.yaml", replaced: "", entry: "m.json" }]);
  assert.throws(() => run([flag({ file: "k.yaml" })]), /k\.yaml defines serving\.knative\.dev\/v1 Service, which cloister's knative-serving 1\.24\.0 projection defines already\. A file a flag adds may only add kinds/);
  assert.throws(() => run([flag({ file: "k.yaml", replaces: [KNATIVE] })]), /a file a flag adds may only add kinds\. A replacement is declared in cluster\.toml/);
  assert.throws(() => run([flag({ file: "w.yaml" }), flag({ file: "w.yaml" })]), /w\.yaml defines example\.test\/v1 Widget, which w\.yaml defines already/);
});

// ── What a checkout's files may hold ────────────────────────────────────────

test("a checkout mapping holds entries only, each for a kind of held object no other entry reads", () => {
  const crd = { "w.yaml": widgetCrd() };
  const withMapping = (text, more = {}) => checkout({ ...crd, "m.json": text, ...more }, { crds: [{ file: "w.yaml" }], mappings: ["m.json", ...Object.keys(more)] });
  for (const key of ["objects", "provider", "bindingRelations"]) {
    assert.throws(() => withMapping(JSON.stringify({ types: {}, [key]: {} })), new RegExp(`m\\.json declares "${key}": a checkout mapping holds entries only`));
  }
  assert.throws(() => withMapping("{"), /m\.json is not JSON/);
  assert.throws(() => withMapping(JSON.stringify({ types: {} })), /m\.json holds no entries/);
  assert.throws(() => withMapping(JSON.stringify({ types: { kubernetes_deployment_v1: widgetEntry() } })), /a checkout entry reads an object a resource holds whole/);
  assert.throws(() => withMapping(JSON.stringify({ types: { "kubernetes_manifest apps/v1 Deployment": widgetEntry() } })), /cloister reads kubernetes_manifest apps\/v1 Deployment already, and a checkout may not replace an entry cloister ships/);
  assert.throws(() => withMapping(widgetMapping(), { "n.json": widgetMapping() }), /n\.json and m\.json both describe kubernetes_manifest example\.test\/v1 Widget/);
  // The validator's own rules hold for it: an unknown key, a path the CRD lacks.
  assert.throws(() => withMapping(widgetMapping({ reads: ["metadata.name"] })), /with the checkout's files, mapping: kubernetes_manifest example\.test\/v1 Widget has unknown key "reads"/);
  assert.throws(() => withMapping(widgetMapping({ read: ["spec.replicas"] })), /with the checkout's files, .*spec\.replicas/);
  assert.throws(() => withMapping(widgetMapping({ podTemplate: "spec template" })), /podTemplate must be the dotted path of the pod template/);
  // An entry with no schema for its kind is refused by name.
  assert.throws(
    () => checkout({ "m.json": widgetMapping() }, { mappings: ["m.json"] }),
    /reads a kind, example\.test\/v1 Widget, that no object spec defines/,
  );
});

test("a CRD file is read even where its environment does not apply, and must define a kind an entry reads", () => {
  assert.throws(
    () => checkout({ "m.json": widgetMapping() }, { crds: [{ file: "missing.yaml", env: "prod" }], mappings: ["m.json"], env: "staging" }),
    /no such file: missing\.yaml/,
  );
  assert.throws(
    () => checkout({ "notes.yaml": "kind: ConfigMap\napiVersion: v1\n" }, { crds: [{ file: "notes.yaml" }] }),
    /notes\.yaml holds no CustomResourceDefinition/,
  );
  assert.throws(
    () => checkout({ "g.yaml": crdYaml({ group: "example.test", kind: "Gadget" }) }, { crds: [{ file: "g.yaml" }] }),
    /g\.yaml defines no kind an entry reads \(it serves example\.test\/v1 Gadget\)/,
  );
});

test("a file cluster.toml names is a path inside the checkout", () => {
  const resolve = (file) => `/checkout/${file}`;
  assert.deepEqual(checkoutRows({ mappings: ["m.json"], crds: [{ file: "crds/w.yaml", env: "prod", replaces: [WIDGET] }] }, resolve), {
    mappings: [{ file: "m.json", path: "/checkout/m.json", from: "cluster.toml" }],
    crds: [{ file: "crds/w.yaml", path: "/checkout/crds/w.yaml", env: "prod", replaces: [WIDGET], from: "cluster.toml" }],
  });
  for (const file of ["/etc/crd.yaml", "../other/crd.yaml", "crds/../../crd.yaml"]) {
    assert.throws(() => checkoutRows({ crds: [{ file }] }, resolve), /a file the checkout names is a path inside the checkout/);
  }
  assert.throws(() => checkoutRows({ crds: [{ file: "" }] }, resolve), /\[\[inspect\.crds\]\] row needs a "file"/);
  assert.deepEqual(checkoutRows(undefined, resolve), { mappings: [], crds: [] });
});

test("with no checkout files, inspect reads with cloister's own mappings", () => {
  assert.deepEqual(readWithCheckout({ read: () => { throw new Error("nothing is read"); } }), { registry: SHIPPED, checkout: null });
});

// ── ∀ arrangements of rows ──────────────────────────────────────────────────

test("∀ rows: the loader refuses exactly when the rule does, and otherwise each kind's schema is the most specific row that says so", async () => {
  const { default: fc } = await import("fast-check");
  const KINDS = [WIDGET, KNATIVE];
  const SHIPPED_KINDS = new Set([KNATIVE]);
  const files = {
    "widget.yaml": widgetCrd(), "knative.yaml": knativeCrd(), "both.yaml": `${widgetCrd()}---\n${knativeCrd()}`,
    "m.json": widgetMapping(),
  };
  const DEFINES = { "widget.yaml": [WIDGET], "knative.yaml": [KNATIVE], "both.yaml": [WIDGET, KNATIVE] };
  const row = fc.record({
    file: fc.constantFrom("widget.yaml", "knative.yaml", "both.yaml"),
    env: fc.constantFrom("", "prod", "staging"),
    replaces: fc.subarray(KINDS),
  });
  /** The rule, stated directly: the outcome for `rows` read for prod. */
  const rule = (rows) => {
    const levels = [rows.filter((r) => r.env === ""), rows.filter((r) => r.env === "prod")];
    const winner = new Map([...SHIPPED_KINDS].map((k) => [k, "cloister's knative-serving 1.24.0 projection"]));
    for (const level of levels) {
      const here = new Map();
      for (const r of level) {
        for (const k of DEFINES[r.path]) {
          if (here.has(k)) return null; // two at one level
          here.set(k, r);
        }
        for (const k of r.replaces) if (!DEFINES[r.path].includes(k) || !winner.has(k)) return null;
      }
      for (const [k, r] of here) {
        if (winner.has(k) && !r.replaces.includes(k)) return null;
      }
      for (const [k, r] of here) winner.set(k, r.file);
    }
    // Every kind an entry reads has a schema: the checkout's Widget entry needs a row.
    if (!winner.has(WIDGET)) return null;
    return winner;
  };
  // Rows get distinct names, so the winner is known by name; `path` is the file it reads.
  const named = (rows) => rows.map((r, i) => ({ ...r, file: `${i}/${r.file}`, path: r.file }));
  fc.assert(fc.property(fc.array(row, { maxLength: 4 }), (rows) => {
    const expected = rule(named(rows));
    let outcome;
    try {
      outcome = checkout(files, { crds: named(rows), mappings: ["m.json"], env: "prod" }).checkout;
    } catch {
      outcome = null;
    }
    if (expected === null) return outcome === null;
    if (outcome === null) return false;
    // Every kind a row defined is checked against the winner the rule names.
    return outcome.kinds.every(({ kind, schema }) => schema === expected.get(kind));
  }), { numRuns: 500 });
});

// ── cloister inspect, reading a checkout ────────────────────────────────────

test("cloister inspect reads cluster.toml's [inspect] files, says what checked each kind, and --draft takes them as flags", async (t) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parse: parseToml, stringify: stringifyToml } = await import("smol-toml");
  const { main } = await import("../../commands/inspect.mjs");
  const dir = mkdtempSync(join(tmpdir(), "cloister-checkout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "crds", "prod"), { recursive: true });
  writeFileSync(join(dir, "crds", "widgets.yaml"), widgetCrd());
  writeFileSync(join(dir, "crds", "prod", "widgets.yaml"), widgetCrd());
  writeFileSync(join(dir, "inspect.mapping.json"), widgetMapping());
  const planFile = join(dir, "plan.json");
  writeFileSync(planFile, JSON.stringify(plan([widget("orders")])));
  const run = async (args) => {
    const out = [];
    const err = [];
    const status = await main(args, { log: (l) => out.push(l), errLog: (l) => err.push(l), isGitTracked: () => false });
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  };

  // --draft reads no cluster.toml, so the checkout's files come as flags.
  const drafted = await run(["--terraform", planFile, "--draft", "--env", "prod", "--crd", join(dir, "crds", "widgets.yaml"), "--mapping", join(dir, "inspect.mapping.json")]);
  assert.equal(drafted.status, 0, drafted.stderr);
  const doc = parseToml(drafted.stdout);
  assert.deepEqual(doc.bundles.map((b) => b.name), ["orders"]);
  doc.inspect = {
    mappings: ["inspect.mapping.json"],
    crds: [{ file: "crds/widgets.yaml" }, { env: "prod", file: "crds/prod/widgets.yaml", replaces: [WIDGET] }],
  };
  writeFileSync(join(dir, "cluster.toml"), stringifyToml(doc));

  const text = await run(["--terraform", planFile, "--dir", dir, "--env", "prod"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Checked with the checkout's files:\n {2}example\.test\/v1 Widget: schema crds\/prod\/widgets\.yaml, replacing crds\/widgets\.yaml; read by inspect\.mapping\.json/);
  assert.match(text.stdout, /file: crds\/prod\/widgets\.yaml \(crd, cluster\.toml, for prod\)/);
  assert.match(text.stdout, /\nWidgets:\n {2}orders {2}shop/);
  assert.doesNotMatch(text.stdout, /Not read/);

  const json = JSON.parse((await run(["--terraform", planFile, "--dir", dir, "--env", "prod", "--json"])).stdout);
  const { formatVersion } = await import("../../lib/output-format.mjs");
  assert.equal(json.formatVersion, formatVersion("InspectReport"));
  assert.deepEqual(json.checkout.kinds, [{ kind: WIDGET, schema: "crds/prod/widgets.yaml", replaced: "crds/widgets.yaml", entry: "inspect.mapping.json" }]);
  assert.deepEqual(json.checkout.files.map((f) => [f.file, f.applies]), [["crds/widgets.yaml", true], ["crds/prod/widgets.yaml", true], ["inspect.mapping.json", true]]);

  // A run that cannot say which rows apply is refused, and so is a file that is not there.
  const noEnv = await run(["--terraform", planFile, "--dir", dir]);
  assert.equal(noEnv.status, 1);
  assert.match(noEnv.stderr, /say which environment this plan describes with --env/);
  const missing = await run(["--terraform", planFile, "--dir", dir, "--env", "prod", "--crd", join(dir, "nope.yaml")]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such file: .*nope\.yaml/);
});

test("the entry docs/plan-checker.md shows reads its kind against a CRD for it", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../../../docs/plan-checker.md", import.meta.url), "utf8");
  const [, shown] = doc.match(/## Kinds cloister does not ship[\s\S]*?```json\n([\s\S]*?)```/) ?? [];
  assert.ok(shown, "docs/plan-checker.md shows an entry under \"Kinds cloister does not ship\"");
  const files = { "widgets.yaml": crdYaml({ group: "example.com", kind: "Widget" }), "m.json": shown };
  const { registry, checkout: provenance } = checkout(files, { crds: [{ file: "widgets.yaml" }], mappings: ["m.json"] });
  assert.deepEqual(provenance.kinds, [{ kind: "example.com/v1 Widget", schema: "widgets.yaml", replaced: "", entry: "m.json" }]);
  assert.ok(registry.mappedType("kubernetes_manifest example.com/v1 Widget").report.bundle);
});
