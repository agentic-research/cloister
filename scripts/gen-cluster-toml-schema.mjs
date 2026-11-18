#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scripts/gen-cluster-toml-schema.mjs — the published JSON Schema for
// cluster.toml (schema/cluster.toml.schema.json).
//
// cluster.toml is the operator's surface, and until this file nothing outside
// cloister could say what a valid one looks like: an editor could not complete
// a key or flag a typo, and another tool could not read one without copying
// the parser. The schema is GENERATED, never written by hand, from the same
// source the parser validates against:
//
//   manifest/cluster.capnp  →  src/generated/cluster.zod.ts  →  this schema
//
// Two things differ between the TOML an operator writes and the shape the zod
// schema describes, and both are mechanical (cli/lib/cluster/toml-to-cluster.mjs
// undoes them before validating):
//
//   1. A union. capnp and zod say `kind: { external: {...} }`. TOML has no
//      unions, so the operator writes `kind = "external"` beside a
//      `[bundles.external]` table. Here that is a `oneOf` with one branch per
//      tag, each fixing the tag with `const` and admitting only its own table.
//   2. `[inputs.<name>]`. zod has a list of inputs that each carry a `name`;
//      TOML keys the table by name.
//
// Everything else is the generated schema as it stands, minus `required`:
// capnp has no required fields, so every field has a default. The few fields a
// hand-written file must still state are listed in REQUIRED below, each for a
// reason the parser enforces.
//
// Only keywords scripts/lib/json-schema-subset.mjs implements are emitted, so
// the repo's own validator can hold every committed cluster.toml to this file.
//
//   node scripts/gen-cluster-toml-schema.mjs          # write
//   node scripts/gen-cluster-toml-schema.mjs --check  # fail if the committed file differs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { z } from "zod";

export const SCHEMA_PATH = fileURLToPath(new URL("../schema/cluster.toml.schema.json", import.meta.url));
export const SCHEMA_ID = "https://raw.githubusercontent.com/agentic-research/cloister/main/schema/cluster.toml.schema.json";

/**
 * Fields a hand-written cluster.toml must state, by dotted path to the object
 * that holds them (`[]` steps into a list's items).
 *
 * - `metadata.name` / `metadata.version`: toml-to-cluster check 4z. capnp
 *   defaults both to "", so the generated schema cannot refuse their absence,
 *   and a cluster would otherwise build unnamed.
 */
const REQUIRED = Object.freeze({
  "": ["metadata"],
  "metadata": ["name", "version"],
});

/**
 * Shapes the parser accepts in TOML that the generated schema does not
 * describe, by dotted path. Each is a normalisation toml-to-cluster performs
 * before validating.
 */
const SUGAR = Object.freeze({
  // normalizeConfinement: an fs.allow entry may be a bare path (read-only) or
  // the typed `{ path, mode }` row.
  "bundles[].confinement.fs.allow[]": (typed) => ({ oneOf: [{ type: "string" }, typed] }),
});

/** A zod union of `{ <tag>: payload }` objects, one key each: capnp's union. */
function taggedUnion(node) {
  if (!Array.isArray(node?.anyOf)) return null;
  const variants = [];
  for (const branch of node.anyOf) {
    const keys = Object.keys(branch?.properties ?? {});
    if (branch?.type !== "object" || keys.length !== 1 || branch.additionalProperties !== false) return null;
    variants.push({ tag: keys[0], payload: branch.properties[keys[0]] });
  }
  return variants;
}

const isVoid = (payload) => payload?.type === "null";

/** Rewrite one node of the generated schema into the TOML shape. */
function toToml(node, path) {
  if (Array.isArray(node?.anyOf) && !taggedUnion(node)) {
    throw new Error(`${path || "(root)"}: a union this generator does not know how to write in TOML`);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    // `readOnly` is zod's note that a list is frozen, and the bound is its
    // "safe integer" ceiling. Neither says anything about a cluster.toml.
    if (key === "readOnly" || key === "required") continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    out[key] = value;
  }
  if (node.type === "array" && node.items) {
    const items = toToml(node.items, `${path}[]`);
    out.items = Object.hasOwn(SUGAR, `${path}[]`) ? SUGAR[`${path}[]`](items) : items;
    return out;
  }
  if (node.type !== "object" || !node.properties) return out;

  const plain = {};
  const unions = [];
  for (const [key, value] of Object.entries(node.properties)) {
    const variants = taggedUnion(value);
    if (variants) unions.push({ key, variants });
    else plain[key] = toToml(value, path ? `${path}.${key}` : key);
  }
  const required = REQUIRED[path];
  const base = { type: "object", properties: plain, ...(required ? { required: [...required] } : {}), additionalProperties: false };

  // A union whose variants all carry nothing is just a choice of word.
  for (const { key, variants } of unions.filter((u) => u.variants.every((v) => isVoid(v.payload)))) {
    base.properties[key] = { type: "string", enum: variants.map((v) => v.tag) };
  }
  const tabled = unions.filter((u) => !u.variants.every((v) => isVoid(v.payload)));
  if (tabled.length === 0) return base;
  if (tabled.length > 1) {
    throw new Error(`${path}: two unions with payloads on one object (${tabled.map((u) => u.key).join(", ")}); write the cross product before emitting it`);
  }
  // One branch per tag: the tag is fixed, and only that tag's table is admitted.
  const [{ key, variants }] = tabled;
  return {
    oneOf: variants.map(({ tag, payload }) => {
      if (Object.hasOwn(base.properties, tag) || tag === key) {
        throw new Error(`${path}: union tag "${tag}" collides with a field of the same name`);
      }
      const properties = { ...base.properties, [key]: { const: tag } };
      if (!isVoid(payload)) properties[tag] = toToml(payload, `${path}.${tag}`);
      return { ...base, properties, required: [...(base.required ?? []), key] };
    }),
  };
}

/** `[inputs.<name>]`: a table keyed by name, each value an input without its `name`. */
function inputsTable(list) {
  const row = list.items;
  const { name: _name, ...properties } = row.properties;
  return {
    oneOf: [
      { type: "object", properties: {}, additionalProperties: { ...row, properties } },
      list,
    ],
  };
}

export async function buildTomlSchema() {
  const { ClusterSchema } = await tsImport(new URL("../src/generated/cluster.zod.ts", import.meta.url).href, { parentURL: import.meta.url });
  const generated = z.toJSONSchema(ClusterSchema, { target: "draft-7", io: "input" });
  const { $schema, ...root } = generated;
  const toml = toToml(root, "");
  toml.properties.inputs = inputsTable(toml.properties.inputs);
  return {
    $schema,
    $id: SCHEMA_ID,
    title: "cloister cluster.toml",
    description:
      "The operator's declaration of a cloister cluster. Generated from manifest/cluster.capnp " +
      "by scripts/gen-cluster-toml-schema.mjs; do not edit by hand. A file that validates here " +
      "has the right shape. The build still checks what a schema cannot: names that must match, " +
      "ports that must exist, strengths that must be met.",
    ...toml,
  };
}

export function renderSchema(schema) {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = renderSchema(await buildTomlSchema());
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
