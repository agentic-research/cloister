// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wrangler config source for resource facts (ADR-0073 §6). A Worker's bindings
// live in its wrangler config, not in Terraform state. Only the keys listed in
// `mappings/wrangler.json` are read, and at load each is checked against
// wrangler's published config schema. `vars`, secrets and everything else in
// the file are never read.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, extname } from "node:path";

import { parse as parseToml } from "smol-toml";

import { makeFact } from "./facts.mjs";
import { validateWranglerKeys } from "./validate.mjs";

export const WRANGLER_MAPPING = Object.freeze(
  JSON.parse(readFileSync(new URL("./mappings/wrangler.json", import.meta.url), "utf8")),
);
const WRANGLER_CONFIG_SCHEMA = createRequire(import.meta.url)("wrangler/config-schema.json");
validateWranglerKeys(WRANGLER_MAPPING.keys, WRANGLER_CONFIG_SCHEMA);

const KEYS = new Set(WRANGLER_MAPPING.keys);

/** Parse a wrangler config file: `.toml` or `.json`. `.jsonc` is refused. */
export function parseWranglerConfig(file) {
  const ext = extname(file).toLowerCase();
  const text = readFileSync(file, "utf8");
  if (ext === ".toml") return parseToml(text);
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".jsonc") throw new Error(`${basename(file)}: wrangler.jsonc is not supported (use wrangler.toml or wrangler.json)`);
  throw new Error(`${basename(file)}: unrecognised wrangler config extension "${ext}" (use wrangler.toml or wrangler.json)`);
}

/** Read one listed key; asking for an unlisted key is a bug and throws by name. */
function read(node, key) {
  if (!KEYS.has(key)) throw new Error(`wrangler: "${key}" is not in the wrangler mapping`);
  const v = node?.[key.split(".").pop()];
  return typeof v === "string" && v !== "" ? v : undefined;
}

const rows = (value) => (Array.isArray(value) ? value.filter((r) => r && typeof r === "object") : []);

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** @returns one `wrangler_worker` fact for the config's top-level Worker */
export function wranglerFact(config, label = "wrangler.toml") {
  const name = read(config, "name");
  if (!name) throw new Error(`${label}: the wrangler config has no name`);
  const bindings = [];
  const push = (b) => { if (b.name) bindings.push(compact(b)); };
  for (const r of rows(config.services)) {
    push({ name: read(r, "services[].binding"), type: "service", service: read(r, "services[].service") });
  }
  for (const r of rows(config.durable_objects?.bindings)) {
    push({
      name: read(r, "durable_objects.bindings[].name"),
      type: "durable_object_namespace",
      class_name: read(r, "durable_objects.bindings[].class_name"),
      script_name: read(r, "durable_objects.bindings[].script_name"),
    });
  }
  for (const r of rows(config.kv_namespaces)) {
    push({ name: read(r, "kv_namespaces[].binding"), type: "kv_namespace", namespace_id: read(r, "kv_namespaces[].id") });
  }
  for (const r of rows(config.d1_databases)) {
    push({ name: read(r, "d1_databases[].binding"), type: "d1", id: read(r, "d1_databases[].database_id") });
    // database_name is read so it is on the record, but it is a name, not a join key.
    void read(r, "d1_databases[].database_name");
  }
  for (const r of rows(config.r2_buckets)) {
    push({ name: read(r, "r2_buckets[].binding"), type: "r2_bucket", bucket_name: read(r, "r2_buckets[].bucket_name") });
  }
  for (const r of rows(config.queues?.producers)) {
    push({ name: read(r, "queues.producers[].binding"), type: "queue", queue_name: read(r, "queues.producers[].queue") });
  }
  const routes = [];
  if (Array.isArray(config.routes)) {
    for (const r of config.routes) {
      const pattern = typeof r === "string" ? r : read(r, "routes[].pattern");
      if (pattern) routes.push(pattern);
    }
  }
  return makeFact({
    source: "wrangler",
    address: `wrangler:${name}`,
    type: "wrangler_worker",
    name,
    attrs: { bindings, routes, ids: {} },
  });
}

export function importWrangler(file) {
  return wranglerFact(parseWranglerConfig(file), basename(file));
}
