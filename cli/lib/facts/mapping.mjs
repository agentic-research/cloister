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
