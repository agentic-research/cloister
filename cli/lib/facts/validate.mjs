// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Validate a facts mapping against the published spec it claims to follow
// (ADR-0073 §3). The attribute set is data; the spec is what keeps that data
// honest: a typo'd attribute, a secret, or a non-scalar cannot be mapped.

const SCALARS = new Set(["string", "number", "bool"]);

/** Walk a dotted attribute path through a spec attribute map; returns the leaf entry. */
function lookup(attributes, path, label) {
  let level = attributes;
  let entry;
  const segments = path.split(".");
  for (const [i, segment] of segments.entries()) {
    entry = level?.[segment];
    if (!entry) throw new Error(`mapping: unknown attribute "${label}${path}" (not in the provider spec)`);
    if (entry.sensitive) throw new Error(`mapping: sensitive attribute "${label}${path}" cannot be mapped`);
    if (i < segments.length - 1) {
      if (!entry.attributes) throw new Error(`mapping: "${label}${path}" is not a nested attribute`);
      level = entry.attributes;
    }
  }
  return entry;
}

function scalar(attributes, path, label) {
  const entry = lookup(attributes, path, label);
  if (!SCALARS.has(entry.type)) {
    throw new Error(`mapping: attribute "${label}${path}" is not a scalar (string, number, bool)`);
  }
  return entry;
}

/** Throws by name on the first violation. */
export function validateMapping(mapping, spec) {
  const resources = spec?.resources ?? {};
  const attrsOf = (type, where) => {
    if (!resources[type]) throw new Error(`mapping: unknown resource type "${type}" (${where})`);
    return resources[type].attributes;
  };
  for (const [type, entry] of Object.entries(mapping.types ?? {})) {
    const attributes = attrsOf(type, "not in the provider spec");
    const here = `${type}.`;
    if (entry.name !== undefined) scalar(attributes, entry.name, here);
    for (const path of [...(entry.read ?? []), ...(entry.ids ?? [])]) scalar(attributes, path, here);
    // A reference attribute only has to exist (and not be sensitive): it is
    // whatever the configuration wires into it, and only its references are read.
    for (const path of entry.referenceAttrs ?? []) lookup(attributes, path, `${here}referenceAttrs.`);
    for (const list of entry.lists ?? []) {
      const nested = lookup(attributes, list.path, here);
      if (!nested.attributes) throw new Error(`mapping: list "${here}${list.path}" is not a nested attribute`);
      for (const path of list.read ?? []) scalar(nested.attributes, path, `${here}${list.path}.`);
    }
    for (const rel of entry.relations ?? []) {
      scalar(attributes, rel.attr, here);
      checkTarget(rel, attrsOf, `${here}${rel.attr}`);
    }
  }
  const bindingList = mapping.types?.cloudflare_workers_script?.lists?.find((l) => l.path === "bindings");
  const bindingAttrs = bindingList && resources.cloudflare_workers_script?.attributes.bindings?.attributes;
  for (const [bindingType, relations] of Object.entries(mapping.bindingRelations ?? {})) {
    for (const rel of relations) {
      if (bindingAttrs) scalar(bindingAttrs, rel.attr, `binding(${bindingType}).`);
      checkTarget(rel, attrsOf, `binding(${bindingType}).${rel.attr}`);
    }
  }
}

function checkTarget(rel, attrsOf, from) {
  let attributes;
  try {
    attributes = attrsOf(rel.toType, "relation target");
  } catch {
    throw new Error(`mapping: relation ${from} targets unknown type "${rel.toType}"`);
  }
  try {
    scalar(attributes, rel.toAttr, `${rel.toType}.`);
  } catch (error) {
    throw new Error(`mapping: relation ${from} targets bad attribute: ${error.message.replace(/^mapping: /, "")}`);
  }
}

/** Resolve `$ref`s under `definitions`. */
function deref(schema, root) {
  let node = schema;
  while (node?.$ref) {
    node = node.$ref.replace(/^#\/definitions\//, "").split("/").reduce((d, k) => d?.[k], root.definitions);
  }
  return node;
}

/** Property `name` of an object schema, searching through anyOf/oneOf/allOf. */
function property(schema, name, root) {
  const node = deref(schema, root);
  if (!node) return undefined;
  if (node.properties?.[name]) return deref(node.properties[name], root);
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    const found = property(branch, name, root);
    if (found) return found;
  }
  return undefined;
}

/** Array items schema, searching through combinators. */
function items(schema, root) {
  const node = deref(schema, root);
  if (!node) return undefined;
  if (node.type === "array" && node.items) return deref(node.items, root);
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
    const found = items(branch, root);
    if (found) return found;
  }
  return undefined;
}

/** Throws by name when a listed wrangler key is absent from wrangler's config schema. */
export function validateWranglerKeys(keys, configSchema) {
  const top = deref(configSchema, configSchema);
  for (const key of keys) {
    let node = top;
    for (const part of key.split(".")) {
      const isArray = part.endsWith("[]");
      node = property(node, isArray ? part.slice(0, -2) : part, configSchema);
      if (node && isArray) node = items(node, configSchema);
      if (!node) throw new Error(`wrangler mapping: key "${key}" is not in wrangler's config schema`);
    }
  }
}
