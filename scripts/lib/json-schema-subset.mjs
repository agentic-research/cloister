// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A JSON-Schema validator for the subset cloister's vendored schemas use —
// ADR-0067 L1.
//
// ## Why not a library
//
// cloister has no JSON-Schema dependency and adding one to validate two files
// is a poor trade against a supply-chain surface threat model §17.1 already
// spends effort keeping small. The subset here is 13 validating keywords, all
// enumerated from the schemas actually vendored.
//
// ## The property that makes a hand validator safe
//
// UNKNOWN KEYWORDS ARE A HARD ERROR, not an ignore. That inversion is the whole
// design: a validator that skips what it does not understand reports "valid" for
// a document it never checked, which is a vacuous pass generator pointed at the
// exact artifacts this harness exists to check. If a vendored schema gains
// `maxItems`, this throws and someone implements it — noisily, once — instead of
// silently weakening every check that depends on it.
//
// The same rule applies to `$ref`: only local `#/$defs/<name>` is resolvable,
// and anything else throws rather than resolving to undefined and passing.

/** Keywords with no validation effect. Present, allowed, ignored deliberately. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$comment", "default", "examples"]);

/** Keywords this validator implements. Anything else throws. */
const IMPLEMENTED = new Set([
  "type", "const", "enum", "pattern", "minLength", "minimum", "maximum",
  "required", "properties", "additionalProperties", "minProperties", "items", "oneOf", "$ref", "$defs",
]);

export class UnsupportedSchemaError extends Error {
  override_name = "UnsupportedSchemaError";
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "number" ? "number" : typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function resolveRef(ref, root) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m) {
    throw new UnsupportedSchemaError(
      `only local "#/$defs/<name>" refs are resolvable, got ${JSON.stringify(ref)}`,
    );
  }
  const target = root.$defs?.[m[1]];
  if (target === undefined) {
    throw new UnsupportedSchemaError(`$ref ${JSON.stringify(ref)} resolves to nothing`);
  }
  return target;
}

/**
 * Validate `value` against `schema`. Returns an array of human-readable errors;
 * empty means valid.
 *
 * Throws `UnsupportedSchemaError` when the SCHEMA uses something unimplemented —
 * deliberately distinct from a validation failure, because they need different
 * responses: one means the document is wrong, the other means this file is.
 */
export function validate(value, schema, { root = schema, path = "$" } = {}) {
  const errors = [];

  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !IMPLEMENTED.has(key)) {
      throw new UnsupportedSchemaError(
        `schema at ${path} uses unimplemented keyword ${JSON.stringify(key)}. ` +
        `Implement it in scripts/lib/json-schema-subset.mjs rather than ignoring it — ` +
        `an ignored constraint is a check that reports valid without looking.`,
      );
    }
  }

  if (schema.$ref !== undefined) {
    return validate(value, resolveRef(schema.$ref, root), { root, path });
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors; // further checks would be noise against the wrong type
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === "string"
      && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} below minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path}: ${value} above maximum ${schema.maximum}`);
  }

  if (schema.oneOf !== undefined) {
    // Collected but not reported: `oneOf` failure means none of the branches
    // fit, and dumping every branch's complaint buries the useful one.
    const passing = schema.oneOf.filter((b) => validate(value, b, { root, path }).length === 0);
    if (passing.length !== 1) {
      errors.push(`${path}: matched ${passing.length} of ${schema.oneOf.length} oneOf branches, expected exactly 1`);
    }
  }

  if (typeOf(value) === "object") {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path}: fewer than minProperties ${schema.minProperties}`);
    }
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: missing required property ${JSON.stringify(req)}`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub !== undefined) {
        errors.push(...validate(v, sub, { root, path: `${path}.${k}` }));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property ${JSON.stringify(k)}`);
      }
    }
  }

  if (typeOf(value) === "array" && schema.items !== undefined) {
    value.forEach((item, i) => {
      errors.push(...validate(item, schema.items, { root, path: `${path}[${i}]` }));
    });
  }

  return errors;
}
