#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trim a `terraform show -json` PLAN down to what the facts mappings read
// (ADR-0073), so a real public plan can be committed as a fixture without the
// rest of the document. Keeps:
//   - format_version;
//   - planned_values resources of MAPPED types, with only their mapped
//     attributes and the matching sensitive_values entries;
//   - configuration.root_module.resources for those addresses, with
//     expressions reduced to { references } for the type's referenceAttrs.
// Everything else is dropped. Output has sorted keys, so it is deterministic.
//
//   node scripts/trim-plan-fixture.mjs <plan.show.json> <out.json>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FACTS = new URL("../cli/lib/facts/mappings/", import.meta.url);
const MAPPINGS = ["cloudflare.json", "google.json"].map((f) => JSON.parse(readFileSync(new URL(f, FACTS), "utf8")));
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);
const entryOf = (type) => MAPPINGS.map((m) => own(m.types, type)).find(Boolean);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
function setPath(obj, path, value) {
  const parts = path.split(".");
  const last = parts.pop();
  let level = obj;
  for (const part of parts) level = level[part] ??= {};
  level[last] = value;
}
const pick = (row, keys) =>
  row && typeof row === "object" && !Array.isArray(row)
    ? Object.fromEntries(keys.filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]]))
    : row;

/** Copy only the mapped scalar paths and list rows from `source`, in the same shape. */
function reduce(source, entry) {
  const out = {};
  for (const path of [entry.name, ...(entry.read ?? []), ...(entry.ids ?? [])].filter(Boolean)) {
    const v = getPath(source, path);
    if (v !== undefined && (typeof v !== "object" || v === null)) setPath(out, path, v);
  }
  for (const list of entry.lists ?? []) {
    const rows = getPath(source, list.path);
    if (rows === undefined) continue;
    setPath(out, list.path, Array.isArray(rows) ? rows.map((row) => pick(row, list.read)) : rows);
  }
  return out;
}

export function trimPlan(plan) {
  const kept = new Set();
  const planned = [];
  const walk = (module) => {
    for (const r of module.resources ?? []) {
      const entry = r?.mode === "managed" ? entryOf(r.type) : undefined;
      if (!entry) continue;
      kept.add(r.address);
      planned.push({
        address: r.address, mode: r.mode, type: r.type, name: r.name, provider_name: r.provider_name,
        values: reduce(r.values ?? {}, entry),
        sensitive_values: reduce(r.sensitive_values ?? {}, entry),
      });
    }
    for (const child of module.child_modules ?? []) walk(child);
  };
  walk(plan.planned_values?.root_module ?? {});
  const configuration = (plan.configuration?.root_module?.resources ?? [])
    .filter((r) => kept.has(r.address))
    .map((r) => {
      const entry = entryOf(r.type);
      const expressions = {};
      for (const attr of entry.referenceAttrs ?? []) {
        const refs = r.expressions?.[attr]?.references;
        if (Array.isArray(refs)) expressions[attr] = { references: refs };
      }
      return { address: r.address, type: r.type, name: r.name, expressions };
    });
  return sortKeys({
    format_version: plan.format_version,
    planned_values: { root_module: { resources: planned } },
    configuration: { root_module: { resources: configuration } },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: trim-plan-fixture.mjs <plan.show.json> <out.json>");
    process.exit(2);
  }
  writeFileSync(output, `${JSON.stringify(trimPlan(JSON.parse(readFileSync(input, "utf8"))), null, 2)}\n`);
  console.log(`wrote ${output}`);
}
