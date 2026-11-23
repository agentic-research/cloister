// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A mapping entry may say it is LIKE another (ADR-0073).
//
// A provider often has several resource types that are read the same way: a
// Deployment, a StatefulSet and a DaemonSet all hold a pod template, and most
// types exist twice under an old and a new name. Written out, that is the
// same block many times, and a mistake in one copy is a mistake nobody reads.
//
//   "kubernetes_stateful_set_v1": {
//     "like": "kubernetes_deployment_v1",
//     "report": { "section": "Kubernetes stateful sets" }
//   }
//
// means: everything the named entry says, with these differences laid over
// it. A table is merged key by key; anything else (a string, a list) replaces
// what was there. The named entry must be written out in full: a chain of
// `like` is refused, so what a type means is never more than one step away.
//
// Every reader of a mapping file expands it first, and the validator then
// checks every expanded entry against the provider's schema, so a type that
// is `like` another is still held to its own schema.

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function overlay(base, over) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    out[key] = isTable(value) && isTable(out[key]) ? overlay(out[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * The mapping with every `like` resolved. The input is not changed.
 * Throws by name on an unknown, chained or self-referring `like`.
 */
export function expandMapping(mapping) {
  const types = mapping?.types ?? {};
  const out = {};
  for (const [type, entry] of Object.entries(types)) {
    if (!isTable(entry) || entry.like === undefined) { out[type] = entry; continue; }
    const { like, ...differences } = entry;
    if (typeof like !== "string" || !Object.hasOwn(types, like)) {
      throw new Error(`mapping: ${type} is like ${JSON.stringify(like)}, which this mapping does not describe`);
    }
    if (like === type) throw new Error(`mapping: ${type} is like itself`);
    if (types[like].like !== undefined) {
      throw new Error(`mapping: ${type} is like ${like}, which is itself like ${JSON.stringify(types[like].like)}. Name the entry that is written out in full`);
    }
    out[type] = overlay(types[like], differences);
  }
  return { ...mapping, types: out };
}

// A resource may hold an object of another API whole, in one attribute the
// provider leaves untyped (ADR-0073, amendment of 2026-11-23). A mapping
// declares it under `objects`:
//
//   "objects": { "kubernetes_manifest": { "attr": "manifest", "by": ["apiVersion", "kind"] } }
//
// and describes each kind of object it reads as a type of its own, named by
// the resource type and the values of `by`, with single spaces between:
//
//   "kubernetes_manifest apps/v1 Deployment": { "name": "metadata.name", ... }
//
// A type name never holds a space otherwise, so the two cannot be confused.

/** The `objects` declaration for a resource type, or undefined. */
export function heldObject(mapping, resourceType) {
  const objects = mapping?.objects ?? {};
  return typeof resourceType === "string" && Object.hasOwn(objects, resourceType) ? objects[resourceType] : undefined;
}

/** The type that reads an object of the kind `values` name, held by a resource of `resourceType`. */
export const objectType = (resourceType, values) => [resourceType, ...values].join(" ");

/**
 * What a type that reads a held object names: the resource type that holds
 * it, the declaration, and the kind (the values of `by`, joined by spaces).
 * Undefined for a type that reads a resource directly. A spaced name whose
 * first word is not a declared resource type is still reported, with no
 * declaration, so the validator can refuse it by name.
 */
export function objectKind(mapping, type) {
  if (typeof type !== "string" || !type.includes(" ")) return undefined;
  const [resourceType, ...values] = type.split(" ");
  return { resourceType, object: heldObject(mapping, resourceType), values, kind: values.join(" ") };
}
