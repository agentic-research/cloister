// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/toml-schema.mjs — the published cluster.toml schema, and
// the one check the parser takes from it.
//
// schema/cluster.toml.schema.json is generated from manifest/cluster.capnp
// (LLO's schema-bridge, then gen/cluster-toml-schema.mjs). It names
// every key a cluster.toml may hold. toml-to-cluster.mjs rebuilds several
// tables field by field before it validates, and a rebuild keeps only the
// fields it lists: a key it does not list was DROPPED, so a typo parsed clean
// and the setting silently did not apply. Each such table needed its own
// guard, and the ones without a guard leaked.
//
// `undeclaredKeys` is the one guard for all of them: every key in the file the
// operator wrote must be a key the schema defines. It reports paths, never
// values.

// Imported, not read from disk next to this file, so a bundler carries it:
// the plan checker ships as one file (gen/bundle.mjs) with no `schema/`
// directory beside it.
import TOML_SCHEMA from "../../../schema/cluster.toml.schema.json" with { type: "json" };

/** The published schema. */
export function tomlSchema() {
  return TOML_SCHEMA;
}

const REF_PREFIX = "#/$defs/";

/** Follow `$ref` to the definition it names. Only local definitions exist in this schema. */
export function resolve(schema, root) {
  let node = schema;
  while (typeof node?.$ref === "string") {
    const name = node.$ref.startsWith(REF_PREFIX) ? node.$ref.slice(REF_PREFIX.length) : null;
    if (name === null || !Object.hasOwn(root.$defs ?? {}, name)) {
      throw new Error(`the cluster.toml schema refers to ${node.$ref}, which it does not define`);
    }
    node = root.$defs[name];
  }
  return node;
}

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const kindOf = (v) => (Array.isArray(v) ? "array" : isTable(v) ? "object" : typeof v);
const fits = (schema, value) => {
  if (schema.type === undefined) return true;
  if (schema.type === "integer" || schema.type === "number") return typeof value === "number" || typeof value === "bigint";
  return schema.type === kindOf(value);
};

/**
 * The branch of a `oneOf` this value is written as, or null when that cannot
 * be told. Branches differ by type (a bare path or a table) or by the word in
 * a tag field (`kind = "external"`). A value that fits no branch, or several,
 * is left alone: the schema validation before this has already refused it, or
 * will name it better than this could.
 */
function branchFor(branches, value, root) {
  const typed = branches.map((b) => resolve(b, root)).filter((b) => fits(b, value));
  if (typed.length <= 1) return typed[0] ?? null;
  if (!isTable(value)) return null;
  const tagged = typed.filter((b) =>
    Object.entries(b.properties ?? {}).every(([key, sub]) => sub?.const === undefined || value[key] === sub.const));
  return tagged.length === 1 ? tagged[0] : null;
}

/**
 * Dotted paths of every key in `value` that the schema does not define.
 *
 * @param {unknown} value a parsed cluster.toml, or part of one
 * @param {object} [root] defaults to the published schema
 * @returns {string[]} e.g. `["bundles[0].confinement.fs.alow"]`
 */
export function undeclaredKeys(value, root = tomlSchema()) {
  const walk = (inner, schemaNode, path) => {
    const schema = resolve(schemaNode, root);
    // A `oneOf` beside `properties` only says which of the struct's own tables
    // goes with which tag. The keys are all on the struct, so it is read as
    // one. A `oneOf` on its own is a choice between shapes, and is followed.
    if (Array.isArray(schema.oneOf) && !schema.properties) {
      const branch = branchFor(schema.oneOf, inner, root);
      return branch ? walk(inner, branch, path) : [];
    }
    if (Array.isArray(inner)) {
      return schema.items ? inner.flatMap((item, i) => walk(item, schema.items, `${path}[${i}]`)) : [];
    }
    if (!isTable(inner)) return [];
    const out = [];
    for (const [key, child] of Object.entries(inner)) {
      const at = path ? `${path}.${key}` : key;
      const sub = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
      if (sub !== undefined) out.push(...walk(child, sub, at));
      else if (isTable(schema.additionalProperties)) out.push(...walk(child, schema.additionalProperties, at));
      else if (schema.additionalProperties === false) out.push(at);
    }
    return out;
  };
  return walk(value, root, "");
}
