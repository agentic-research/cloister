#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Project a Terraform provider schema (`tofu providers schema -json`) down to
// the resource types the facts mapping names (ADR-0073 §3), so the importer
// can validate its mapping against the provider's own published schema without
// vendoring the whole 2.5 MB document. Generated, never hand-edited:
//
//   node scripts/gen-facts-spec.mjs <providers-schema.json> --version 5.18.0

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = new URL("../cli/lib/facts/", import.meta.url);
const MAPPING = new URL("mappings/cloudflare.json", HERE);
const OUT = new URL("spec/cloudflare.schema.json", HERE);
const PROVIDER_KEY = "registry.opentofu.org/cloudflare/cloudflare";

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

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

/** @returns {object} the deterministic projection for the mapping's resource types */
export function projectSpec(providersSchema, version, mapping) {
  const provider = providersSchema.provider_schemas?.[PROVIDER_KEY];
  if (!provider) throw new Error(`providers schema has no ${PROVIDER_KEY}`);
  const resources = {};
  for (const type of Object.keys(mapping.types)) {
    const schema = provider.resource_schemas?.[type];
    if (!schema) throw new Error(`provider schema has no resource type "${type}"`);
    resources[type] = { attributes: projectAttributes(schema.block.attributes) };
  }
  return sortKeys({ provider: mapping.provider, version, resources });
}

export function renderSpec(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const vIndex = args.indexOf("--version");
  const version = vIndex >= 0 ? args[vIndex + 1] : undefined;
  const input = args.find((a, i) => !a.startsWith("--") && i !== vIndex + 1);
  if (!input || !version) {
    console.error("usage: gen-facts-spec.mjs <providers-schema.json> --version <provider version>");
    process.exit(2);
  }
  const mapping = JSON.parse(readFileSync(MAPPING, "utf8"));
  const spec = projectSpec(JSON.parse(readFileSync(input, "utf8")), version, mapping);
  writeFileSync(OUT, renderSpec(spec));
  console.log(`wrote ${fileURLToPath(OUT)}`);
}
