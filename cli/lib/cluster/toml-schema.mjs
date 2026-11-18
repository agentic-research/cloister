// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/toml-schema.mjs — the published cluster.toml schema, and
// the one check the parser takes from it.
//
// schema/cluster.toml.schema.json is generated from manifest/cluster.capnp
// (scripts/gen-cluster-toml-schema.mjs). It names every key a cluster.toml may
// hold. toml-to-cluster.mjs rebuilds several tables field by field before it
// validates, and a rebuild keeps only the fields it lists: a key it does not
// list was DROPPED, so a typo parsed clean and the setting silently did not
// apply. Each such table needed its own guard, and the ones without a guard
// leaked.
//
// `undeclaredKeys` is the one guard for all of them: every key in the file the
// operator wrote must be a key the schema defines. It reports paths, never
// values.

import { readFileSync } from "node:fs";

export const TOML_SCHEMA_URL = new URL("../../../schema/cluster.toml.schema.json", import.meta.url);

let cached;
/** The published schema, read once. */
export function tomlSchema() {
  cached ??= JSON.parse(readFileSync(TOML_SCHEMA_URL, "utf8"));
  return cached;
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
function branchFor(branches, value) {
  const typed = branches.filter((b) => fits(b, value));
  if (typed.length <= 1) return typed[0] ?? null;
  if (!isTable(value)) return null;
  const tagged = typed.filter((b) =>
    Object.entries(b.properties ?? {}).every(([key, sub]) => sub.const === undefined || value[key] === sub.const));
  return tagged.length === 1 ? tagged[0] : null;
}

/**
 * Dotted paths of every key in `value` that `schema` does not define.
 *
 * @param {unknown} value a parsed cluster.toml, or part of one
 * @param {object} [schema] defaults to the published schema
 * @returns {string[]} e.g. `["bundles[0].confinement.fs.alow"]`
 */
export function undeclaredKeys(value, schema = tomlSchema(), path = "") {
  if (Array.isArray(schema.oneOf)) {
    const branch = branchFor(schema.oneOf, value);
    return branch ? undeclaredKeys(value, branch, path) : [];
  }
  if (Array.isArray(value)) {
    return schema.items ? value.flatMap((item, i) => undeclaredKeys(item, schema.items, `${path}[${i}]`)) : [];
  }
  if (!isTable(value)) return [];
  const out = [];
  for (const [key, inner] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    const sub = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
    if (sub !== undefined) out.push(...undeclaredKeys(inner, sub, at));
    else if (isTable(schema.additionalProperties)) out.push(...undeclaredKeys(inner, schema.additionalProperties, at));
    else if (schema.additionalProperties === false) out.push(at);
  }
  return out;
}
