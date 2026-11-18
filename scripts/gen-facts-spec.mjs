#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Project a Terraform provider schema (`tofu providers schema -json`) down to
// the resource types the facts mapping names (ADR-0073 §3), so the importer
// can validate its mapping against the provider's own published schema without
// vendoring the whole 2.5 MB document. Generated, never hand-edited:
//
//   node scripts/gen-facts-spec.mjs <providers-schema.json> \
//     --provider cloudflare/cloudflare --version 5.23.0 \
//     --mapping cli/lib/facts/mappings/cloudflare.json \
//     --out cli/lib/facts/spec/cloudflare.schema.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REGISTRY = "registry.opentofu.org/";

function projectAttributes(attributes) {
  const out = {};
  for (const [name, attr] of Object.entries(attributes ?? {})) {
    const entry = { sensitive: attr.sensitive === true };
    if (attr.nested_type) {
      entry.nesting_mode = attr.nested_type.nesting_mode;
      entry.attributes = projectAttributes(attr.nested_type.attributes);
    } else {
      entry.type = attr.type;
    }
    out[name] = entry;
  }
  return out;
}

/** Every dotted path a mapping entry names, each as its segments. */
function mappedPaths(entry) {
  const paths = [entry.name, ...(entry.read ?? []), ...(entry.ids ?? []), ...(entry.referenceAttrs ?? [])];
  for (const list of entry.lists ?? []) paths.push(list.path);
  for (const relation of entry.relations ?? []) paths.push(relation.attr);
  return paths.filter((p) => typeof p === "string").map((p) => p.split("."));
}

/**
 * A block's attributes, plus the nested BLOCKS a mapped path walks through.
 *
 * A provider declares structure two ways. A nested attribute
 * (`nested_type`) sits among the attributes and is always projected. A nested
 * block (`block_types`: a Cloud Run service's `template`, its `containers`,
 * their `env`) sits beside them, and a resource can have dozens. Only the
 * blocks on a path the mapping names are projected, each with all of its
 * attributes, so the spec holds what the mapping can read and not the whole
 * resource. A block is written like a nested attribute, which is how the
 * mapping validator already walks one.
 */
function projectBlock(block, paths) {
  const out = projectAttributes(block.attributes);
  for (const [name, nested] of Object.entries(block.block_types ?? {})) {
    const through = paths.filter((p) => p[0] === name);
    if (through.length === 0) continue;
    if (Object.hasOwn(out, name)) throw new Error(`"${name}" is both an attribute and a block`);
    out[name] = {
      sensitive: false,
      nesting_mode: nested.nesting_mode,
      attributes: projectBlock(nested.block, through.map((p) => p.slice(1)).filter((p) => p.length > 0)),
    };
  }
  return out;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

/** @returns {object} the deterministic projection for the mapping's resource types */
export function projectSpec(providersSchema, version, mapping, providerSuffix = mapping.provider) {
  const providerKey = `${REGISTRY}${providerSuffix}`;
  const provider = providersSchema.provider_schemas?.[providerKey];
  if (!provider) throw new Error(`providers schema has no ${providerKey}`);
  const resources = {};
  for (const [type, entry] of Object.entries(mapping.types)) {
    const schema = provider.resource_schemas?.[type];
    if (!schema) throw new Error(`provider schema has no resource type "${type}"`);
    resources[type] = { attributes: projectBlock(schema.block, mappedPaths(entry)) };
  }
  return sortKeys({ provider: mapping.provider, version, resources });
}

export function renderSpec(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  const [input] = positional;
  if (!input || !flags.provider || !flags.version || !flags.mapping || !flags.out) {
    console.error(
      "usage: gen-facts-spec.mjs <providers-schema.json> --provider <registry suffix, e.g. hashicorp/google> " +
        "--version <provider version> --mapping <mapping.json> --out <spec.json>",
    );
    process.exit(2);
  }
  const mapping = JSON.parse(readFileSync(flags.mapping, "utf8"));
  const spec = projectSpec(JSON.parse(readFileSync(input, "utf8")), flags.version, mapping, flags.provider);
  writeFileSync(flags.out, renderSpec(spec));
  console.log(`wrote ${flags.out}`);
}
