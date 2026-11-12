// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Resource facts (ADR-0073).
//
// A fact is something an infrastructure tool's rendered output says exists:
// a Worker script, a route, a tunnel, a database. Facts are IMPORTED. They are
// never GRANTED. Only a declaration in cluster.toml grants anything
// (ADR-0070 §2: forwarded specs are parsed, not owned).
//
// That rule is carried by the shape, not by reviewer discipline. A fact has
// exactly the keys in FACT_KEYS, and none of them can hold an edge, a
// connection or a grant. `makeFact` refuses any other key by name, so an
// importer cannot smuggle authority into the graph even by accident.

/** Every key a fact may have. There is no grant, connection or edge key. */
export const FACT_KEYS = Object.freeze(["source", "address", "type", "name", "attrs"]);

/** Keys that would carry authority. Named so the refusal can say why. */
const AUTHORITY_KEYS = new Set([
  "grant", "grants", "connection", "connections", "edge", "edges", "wire", "wires", "allow", "allows",
]);

/**
 * Build one frozen fact.
 *
 * `attrs` is a flat or shallow-nested record of allowlisted, non-secret
 * values. `relations` inside attrs are OBSERVATIONS ("this script's config
 * names that script"); the report shows them beside declarations and nothing
 * consumes them as authority.
 */
export function makeFact(fields) {
  for (const key of Object.keys(fields)) {
    if (AUTHORITY_KEYS.has(key)) {
      throw new Error(
        `a resource fact cannot carry "${key}": discovered infrastructure is never authority (ADR-0073)`,
      );
    }
    if (!FACT_KEYS.includes(key)) {
      throw new Error(`a resource fact has no "${key}" field (allowed: ${FACT_KEYS.join(", ")})`);
    }
  }
  for (const key of ["source", "address", "type"]) {
    if (typeof fields[key] !== "string" || fields[key] === "") {
      throw new Error(`a resource fact needs a non-empty "${key}"`);
    }
  }
  return deepFreeze(printable({
    source: fields.source,
    address: fields.address,
    type: fields.type,
    name: typeof fields.name === "string" ? fields.name : "",
    attrs: fields.attrs ?? {},
  }));
}

/**
 * Every string in a fact comes from a document someone else wrote, and the
 * report prints it. A name holding a newline or a terminal escape could forge
 * a report line (a fake "evidenced" finding) or repaint the screen. So control
 * characters, including line breaks, become U+FFFD before a fact exists. The
 * JSON report gets the same strings.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
function printable(value) {
  if (typeof value === "string") return value.replace(CONTROL, "\ufffd");
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [printable(k), printable(v)]));
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * Copy `keys` from `values`, leaving out any the document marks sensitive.
 *
 * `sensitive` is the document's `sensitive_values` sibling: `true` for a
 * sensitive scalar, or a nested object/list for a container that holds
 * sensitive leaves. A key is copied only when its marker is absent, `false`,
 * or an empty container. An attribute this importer was not told about is
 * never copied at all: the allowlist is the first rule and this is the second.
 */
export function pickPublic(values, sensitive, keys) {
  const out = {};
  if (!values || typeof values !== "object") return out;
  // A row's marker must be an object (or absent). Anything else is malformed: read nothing.
  if (sensitive !== undefined && (sensitive === null || typeof sensitive !== "object" || Array.isArray(sensitive))) return out;
  for (const key of keys) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (value === null || value === undefined || value === "") continue;
    // `pickPublic` copies scalars only, and a well-formed document marks a
    // sensitive scalar `true` and omits a public one. Any other marker on a
    // scalar is malformed, so the value is dropped: fail closed.
    const marker = sensitive?.[key];
    if (marker !== undefined && marker !== false) continue;
    if (typeof value === "object") continue; // nested values are read by their adapter, key by key
    out[key] = value;
  }
  return out;
}

/** True when a `sensitive_values` marker says any part of the value is sensitive. */
export function isMarkedSensitive(marker) {
  if (marker === undefined || marker === false) return false;
  if (Array.isArray(marker)) return marker.some(isMarkedSensitive);
  if (marker !== null && typeof marker === "object") return Object.values(marker).some(isMarkedSensitive);
  // `true`, and anything a well-formed document would not put here ("true",
  // 1, null): fail closed.
  return true;
}
