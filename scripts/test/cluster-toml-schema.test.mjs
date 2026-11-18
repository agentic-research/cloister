// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The published JSON Schema for cluster.toml (schema/cluster.toml.schema.json).
//
// A schema nobody checks drifts from the parser the day after it ships, and a
// schema that accepts everything is worse than none. So this holds it three
// ways: the committed file is what the generator produces; every cluster.toml
// in the tree, and everything cloister's own writer emits, validates; and a
// file the parser refuses for its shape is refused here too.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import { buildTomlSchema, renderSchema, SCHEMA_ID, SCHEMA_PATH } from "../gen-cluster-toml-schema.mjs";
import { validate } from "../lib/json-schema-subset.mjs";
import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../cli/lib/cluster/cluster-to-toml.mjs";
import { undeclaredKeys } from "../../cli/lib/cluster/toml-schema.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const errorsFor = (toml) => validate(parseToml(toml), schema);
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "*cluster.toml"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

test("the committed schema is exactly what the generator produces", async () => {
  assert.equal(readFileSync(SCHEMA_PATH, "utf8"), renderSchema(await buildTomlSchema()), "run `task cluster:toml:schema`");
  assert.equal(schema.$id, SCHEMA_ID);
});

test("every cluster.toml in the tree validates, and so does what the writer emits for it", async () => {
  assert.ok(tracked.length >= 5, "the tree has cluster.toml files to check");
  assert.ok(tracked.includes("cluster.toml"), "the root cluster.toml is among them");
  for (const file of tracked) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.deepEqual(errorsFor(text), [], file);
    // The writer's output is the canonical spelling of every field it knows.
    assert.deepEqual(errorsFor(clusterToToml(await parseTomlToCluster(text))), [], `${file} (written back)`);
  }
});

// A small file that uses each TOML-only shape: a union with a table, a union
// that is just a word, the name-keyed inputs table, and a bare fs.allow path.
const BASE = `
[metadata]
name = "schema-fixture"
version = "0.0.1"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "mache"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/mache:1"

[bundles.confinement.fs]
allow = ["/etc/hosts", { path = "/workspace", mode = "rw" }]

[[bundles.ports]]
name = "http"
port = 7532
appProtocol = "art.http"
expose = "cluster"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "mache.yaml"
`;

test("the fixture is one the parser accepts and the schema accepts", async () => {
  await parseTomlToCluster(BASE);
  assert.deepEqual(errorsFor(BASE), []);
});

// Each of these is a mistake in the file's SHAPE. The parser refuses every
// one, and so must the schema: a schema that let one through would tell an
// editor the file is fine when the build will fail.
const shapeMistakes = [
  ["an unknown top-level table", (t) => `${t}\n[bundels]\nx = 1\n`],
  ["an unknown key on a bundle", (t) => t.replace('tier = "cluster"', 'tier = "cluster"\ntire = "cluster"')],
  ["an unknown key in [bundles.external]", (t) => t.replace("image =", "imgae =")],
  ["a bundle kind that is no variant", (t) => t.replace('kind = "external"', 'kind = "container"')],
  ["a table for a variant the bundle is not", (t) => t.replace("[bundles.confinement.fs]", '[bundles.workerd]\nentryPoint = "src/x.ts"\n\n[bundles.confinement.fs]')],
  ["a bundle with no kind", (t) => t.replace('kind = "external"\n', "")],
  ["a port number written as a string", (t) => t.replace("port = 7532", 'port = "7532"')],
  ["a tier that is no tier", (t) => t.replace('tier = "cluster"', 'tier = "edge"')],
  ["no metadata name", (t) => t.replace('name = "schema-fixture"\n', "")],
  ["no metadata at all", (t) => t.replace('[metadata]\nname = "schema-fixture"\nversion = "0.0.1"\n', "")],
  ["an unknown key in an [inputs.<name>] table", (t) => `${t}\n[inputs.rosary]\nref = "ghcr.io/x/rosary"\nurlBindingg = "TYPO"\n`],
  // The rest sit in tables the parser rebuilds field by field. Before the
  // schema was the guard, each of these parsed clean and the key was dropped.
  ["an unknown key in a confinement table", (t) => t.replace("[bundles.confinement.fs]", "[bundles.confinement.fs]\nalow = []"), /"bundles\[0\]\.confinement\.fs\.alow"/],
  ["an unknown key in an fs.allow row", (t) => t.replace('mode = "rw" }', 'mode = "rw", recursive = true }'), /"bundles\[0\]\.confinement\.fs\.allow\[1\]\.recursive"/],
  ["an unknown key in [gateway.policy]", (t) => `${t}\n[gateway.policy]\nrequireInterlok = true\n`, /"gateway\.policy\.requireInterlok"/],
  ["an unknown table under [gateway]", (t) => `${t}\n[gateway.metdata]\nname = "x"\n`, /"gateway\.metdata"/],
  ["an unknown key on a vault proxy service", (t) => `${t}\n[[gateway.vaultProxyServices]]\nname = "api"\ninjection = "authorizationBearer"\nupstreamBaseURL = "https://api.example.com"\n`, /"gateway\.vaultProxyServices\[0\]\.upstreamBaseURL"/],
  ["an unknown key on a skill", (t) => `${t}\n[[gateway.skills]]\nname = "review"\ndigets = "sha256:00"\n`, /"gateway\.skills\[0\]\.digets"/],
  ["an unknown key on an edge", (t) => `${t}\n[[edges]]\nfrom = "a"\nto = "b"\nprotocol = "art.http"\n`, /"edges\[0\]\.protocol"/],
];
for (const [label, edit, named] of shapeMistakes) {
  test(`a shape mistake is refused by the schema and by the parser: ${label}`, async () => {
    const toml = edit(BASE);
    assert.notEqual(toml, BASE, "the edit applied");
    assert.notDeepEqual(errorsFor(toml), [], "the schema refuses it");
    await assert.rejects(parseTomlToCluster(toml), (err) => {
      if (named) assert.match(err.message, named, "the parser names the key it will not drop");
      return true;
    });
  });
}

test("undeclaredKeys reports paths, never values, and follows the branch a value is written as", () => {
  const raw = parseToml(`${BASE}\n[gateway.policy]\nrequireInterlok = "s3cret-value"\n`);
  assert.deepEqual(undeclaredKeys(raw), ["gateway.policy.requireInterlok"]);
  assert.deepEqual(undeclaredKeys(parseToml(BASE)), []);
  // [inputs.<name>] is keyed by name: the name itself is never an unknown key.
  assert.deepEqual(undeclaredKeys(parseToml(`${BASE}\n[inputs.anything-at-all]\nref = "ghcr.io/x/y"\n`)), []);
  assert.deepEqual(undeclaredKeys(parseToml(`${BASE}\n[inputs.rosary]\nreff = "ghcr.io/x/y"\n`)), ["inputs.rosary.reff"]);
  // A bundle whose kind is no variant fits no branch: left to the validation that names it.
  assert.deepEqual(undeclaredKeys(parseToml(BASE.replace('kind = "external"', 'kind = "container"'))), []);
});

test("the TOML-only shapes are written the way an operator writes them", () => {
  // A union with a table: one branch per tag, the tag fixed and required.
  const bundle = schema.properties.bundles.items;
  assert.deepEqual(bundle.oneOf.map((b) => b.properties.kind.const).sort(), ["external", "workerd"]);
  for (const branch of bundle.oneOf) {
    assert.ok(branch.required.includes("kind"));
    assert.equal(branch.additionalProperties, false);
    const other = branch.properties.kind.const === "external" ? "workerd" : "external";
    assert.equal(Object.hasOwn(branch.properties, other), false, "the other variant's table is not admitted");
  }
  // A union that carries nothing is a word.
  assert.deepEqual(schema.properties.wires.items.properties.transport, { type: "string", enum: ["uds", "leylineNet"] });
  // [inputs.<name>]: keyed by name, and the row has no `name` of its own.
  const [byName, asList] = schema.properties.inputs.oneOf;
  assert.equal(Object.hasOwn(byName.additionalProperties.properties, "name"), false);
  assert.ok(Object.hasOwn(asList.items.properties, "name"));
  // Nothing is required but what a hand-written file must state.
  assert.deepEqual(schema.required, ["metadata"]);
  assert.deepEqual(schema.properties.metadata.required, ["name", "version"]);
});

test("a route's variants and a vault service's injection are unions too", () => {
  const routeKinds = schema.properties.routes.items.oneOf.map((b) => b.properties.kind.const);
  assert.ok(routeKinds.includes("health") && routeKinds.includes("mcp"), routeKinds.join(", "));
  const health = schema.properties.routes.items.oneOf.find((b) => b.properties.kind.const === "health");
  assert.equal(Object.hasOwn(health.properties, "health"), false, "a variant that carries nothing has no table");
  const injections = schema.properties.gateway.properties.vaultProxyServices.items.oneOf.map((b) => b.properties.injection.const);
  assert.ok(injections.includes("authorizationBearer") && injections.includes("headerNamed"), injections.join(", "));
});
