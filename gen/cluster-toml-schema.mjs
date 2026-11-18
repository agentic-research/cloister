#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen/cluster-toml-schema.mjs — the published JSON Schema for
// cluster.toml (schema/cluster.toml.schema.json).
//
// cluster.toml is the operator's surface, and until this file nothing outside
// cloister could say what a valid one looks like: an editor could not complete
// a key or flag a typo, and another tool could not read one without copying
// the parser. The schema is GENERATED, never written by hand:
//
//   manifest/cluster.capnp
//     →  src/generated/cluster.schema.json     LLO's schema-bridge (`task cluster:jsonschema`)
//     →  schema/cluster.toml.schema.json       this script          (`task cluster:toml:schema`)
//
// LLO's generator already turns the capnp schema into a JSON Schema, one named
// definition per struct. That describes the capnp shape. A cluster.toml is not
// quite that shape, and this script applies the differences, each of which
// cli/lib/cluster/toml-to-cluster.mjs undoes before it validates:
//
//   1. A union. capnp says `kind: { external: {...} }`. TOML has no unions, so
//      the operator writes `kind = "external"` beside a `[bundles.external]`
//      table. Here the tag is an `enum`, each variant's table is a field, and
//      a `oneOf` forbids the tables of the variants not chosen. A union whose
//      variants carry nothing is just a word, and is only the `enum`.
//   2. `[inputs.<name>]`. capnp has a list of inputs that each carry a `name`;
//      TOML keys the table by name.
//   3. Required fields. capnp has none: every field has a value on the wire,
//      which is why LLO marks them all required. A hand-written file omits
//      most of them. Only what such a file must state is required here, and
//      each entry in REQUIRED is something the parser enforces.
//
// Descriptions come through when the capnp schema carries `$Doc` annotations,
// which LLO's generator turns into `description`. cluster.capnp has none yet.
//
// Only keywords gen/lib/json-schema-subset.mjs implements are emitted, so
// the repo's own validator can hold every committed cluster.toml to this file.
//
//   node gen/cluster-toml-schema.mjs          # write
//   node gen/cluster-toml-schema.mjs --check  # fail if the committed file differs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE_PATH = fileURLToPath(new URL("../src/generated/cluster.schema.json", import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL("../schema/cluster.toml.schema.json", import.meta.url));
export const SCHEMA_ID = "https://raw.githubusercontent.com/agentic-research/cloister/main/schema/cluster.toml.schema.json";

/** The definition a cluster.toml is one of. */
const ROOT = "Cluster";

/**
 * Fields a hand-written cluster.toml must state, by definition name.
 *
 * - `ClusterMetadata.name` / `.version`: toml-to-cluster check 4z. capnp
 *   defaults both to "", so a cluster would otherwise build unnamed.
 */
const REQUIRED = Object.freeze({
  Cluster: ["metadata", "storage"],
  ClusterMetadata: ["name", "version"],
});

/**
 * Shapes the parser accepts in TOML that the capnp schema does not describe,
 * as `<Definition>.<field>` → a rewrite of that field's schema. Each is a
 * normalisation toml-to-cluster performs before validating.
 */
const SUGAR = Object.freeze({
  // normalizeConfinement: an fs.allow entry may be a bare path (read-only) or
  // the typed `{ path, mode }` row.
  "ConfinementFs.allow": (field) => ({ ...field, items: { oneOf: [{ type: "string" }, field.items] } }),
  // unflattenInputs: `[inputs.<name>]` is keyed by name, and the row then has
  // no `name` of its own. The list form with an explicit `name` still parses.
  "Cluster.inputs": (field) => ({
    oneOf: [
      { type: "object", properties: {}, additionalProperties: { $ref: `#/$defs/${BY_NAME}` } },
      field,
    ],
  }),
});

/** The definition for an `[inputs.<name>]` row: an InputSpec without `name`. */
const BY_NAME = "InputSpecByName";
const DERIVED = Object.freeze({
  [BY_NAME]: (defs) => {
    const { name: _name, ...properties } = defs.InputSpec.properties;
    return { ...defs.InputSpec, properties };
  },
});

/** capnp's union as LLO writes it: a `oneOf` of `{ <tag>: payload }` objects, one key each. */
function taggedUnion(node) {
  if (!Array.isArray(node?.oneOf)) return null;
  const variants = [];
  for (const branch of node.oneOf) {
    const keys = Object.keys(branch?.properties ?? {});
    if (branch?.type !== "object" || keys.length !== 1 || branch.additionalProperties !== false) return null;
    variants.push({ tag: keys[0], payload: branch.properties[keys[0]] });
  }
  return variants;
}

const isVoid = (payload) => payload?.type === "null";

/** Rewrite one struct definition into the shape its TOML table has. */
function structToToml(name, def) {
  if (def.type !== "object" || !def.properties) {
    if (def.oneOf) throw new Error(`${name}: a definition that is itself a union; this generator does not write one in TOML yet`);
    return def; // an enum or a constant: the same in TOML
  }
  const plain = {};
  const unions = [];
  for (const [key, value] of Object.entries(def.properties)) {
    const variants = taggedUnion(value);
    if (variants) {
      unions.push({ key, variants });
      continue;
    }
    if (value.oneOf) throw new Error(`${name}.${key}: a union this generator does not know how to write in TOML`);
    plain[key] = Object.hasOwn(SUGAR, `${name}.${key}`) ? SUGAR[`${name}.${key}`](value) : value;
  }
  const { required: _all, properties: _properties, ...rest } = def;
  const required = REQUIRED[name];
  const base = { ...rest, properties: plain, ...(required ? { required: [...required] } : {}) };

  // A union whose variants all carry nothing is just a choice of word.
  for (const { key, variants } of unions.filter((u) => u.variants.every((v) => isVoid(v.payload)))) {
    base.properties[key] = { type: "string", enum: variants.map((v) => v.tag) };
  }
  const tabled = unions.filter((u) => !u.variants.every((v) => isVoid(v.payload)));
  if (tabled.length === 0) return base;
  if (tabled.length > 1) {
    throw new Error(`${name}: two unions with payloads on one struct (${tabled.map((u) => u.key).join(", ")}); write the cross product before emitting it`);
  }
  // The tag is a word, every variant's table is a known key, and a `oneOf`
  // says which table goes with which word: each branch fixes the tag and
  // forbids every other variant's table.
  //
  // The fields stay on the struct itself, outside the `oneOf`, on purpose. An
  // earlier form put a whole copy of the struct in each branch. A typo'd key
  // then failed every branch, and a validator could only say "valid under none
  // of the schemas in oneOf" about the entire table, without naming the key.
  // This way the struct's own `additionalProperties: false` names it.
  const [{ key, variants }] = tabled;
  const tables = variants.filter((v) => !isVoid(v.payload));
  for (const { tag, payload } of tables) {
    if (Object.hasOwn(base.properties, tag) || tag === key) {
      throw new Error(`${name}: union tag "${tag}" collides with a field of the same name`);
    }
    base.properties[tag] = payload;
  }
  base.properties[key] = { type: "string", enum: variants.map((v) => v.tag) };
  return {
    ...base,
    required: [...(base.required ?? []), key],
    oneOf: variants.map(({ tag }) => ({
      properties: {
        [key]: { const: tag },
        ...Object.fromEntries(tables.filter((t) => t.tag !== tag).map((t) => [t.tag, false])),
      },
    })),
  };
}

/** Every definition name a schema node refers to. */
function refsIn(node, out = new Set()) {
  if (Array.isArray(node)) for (const item of node) refsIn(item, out);
  else if (node && typeof node === "object") {
    if (typeof node.$ref === "string") out.add(node.$ref.replace("#/$defs/", ""));
    for (const value of Object.values(node)) refsIn(value, out);
  }
  return out;
}

/**
 * @param {object} source LLO's JSON Schema for cluster.capnp
 * @returns {object} the JSON Schema for a cluster.toml
 */
export function buildTomlSchema(source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"))) {
  if (!source.$defs?.[ROOT]) throw new Error(`the source schema has no ${ROOT} definition`);
  const defs = {};
  for (const [name, def] of Object.entries(source.$defs)) defs[name] = structToToml(name, def);
  for (const [name, derive] of Object.entries(DERIVED)) {
    if (Object.hasOwn(defs, name)) throw new Error(`derived definition ${name} collides with one in the source schema`);
    defs[name] = derive(defs);
  }

  // Only what a cluster.toml can reach. cluster.capnp also declares types that
  // live in other files (a lockfile row), and those are not part of this one.
  const root = defs[ROOT];
  const reachable = new Set();
  const visit = (name) => {
    if (reachable.has(name)) return;
    if (!Object.hasOwn(defs, name)) throw new Error(`a reference to ${name}, which the source schema does not define`);
    reachable.add(name);
    for (const next of refsIn(defs[name])) visit(next);
  };
  for (const name of refsIn(root)) visit(name);

  return {
    $schema: source.$schema,
    $id: SCHEMA_ID,
    title: "cloister cluster.toml",
    description:
      "The operator's declaration of a cloister cluster. Generated from manifest/cluster.capnp by " +
      "LLO's schema-bridge and gen/cluster-toml-schema.mjs; do not edit by hand. A file that " +
      "validates here has the right shape. The build still checks what a schema cannot: names that " +
      "must match, ports that must exist, strengths that must be met.",
    ...root,
    $defs: Object.fromEntries(Object.entries(defs).filter(([name]) => reachable.has(name))),
  };
}

export function renderSchema(schema) {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = renderSchema(buildTomlSchema());
  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(SCHEMA_PATH, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (committed !== text) {
      console.error("schema/cluster.toml.schema.json is out of date. Run `task cluster:toml:schema`.");
      process.exit(1);
    }
    console.log("schema/cluster.toml.schema.json is up to date");
  } else {
    writeFileSync(SCHEMA_PATH, text);
    console.log(`wrote ${SCHEMA_PATH}`);
  }
}
