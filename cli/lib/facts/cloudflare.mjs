// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloudflare provider adapter for resource facts (ADR-0073).
//
// Each entry names the attributes this importer may read for one resource
// type (cloudflare/cloudflare provider, v5 names). Anything not named here is
// never read: not a Worker's source (`content`), not a binding's `text` /
// `json` / key material, not a tunnel secret. `pickPublic` then drops any
// named attribute the document itself marks sensitive.
//
// Ids (account, zone, namespace, database) are kept only as JOIN KEYS, under
// `ids`, so the report can resolve "namespace 0000… is the KV namespace titled
// sessions". The report prints names and leaves ids out unless asked.

import { isMarkedSensitive, makeFact, pickPublic } from "./facts.mjs";

const SOURCE = "terraform:cloudflare";

/**
 * Binding fields that identify WHAT a Worker is bound to. Value-carrying
 * fields (`text`, `json`, `key_base64`, `key_jwk`, `secret_name`, `outbound`,
 * `certificate_id`, …) are deliberately absent.
 */
const BINDING_TARGET_FIELDS = Object.freeze([
  "service", "environment", "script_name", "class_name", "namespace_id", "id",
  "bucket_name", "queue_name", "namespace", "dataset", "index_name", "workflow_name",
]);

/** Binding types whose target is another workload: the observed relations. */
const WORKLOAD_BINDING_TYPES = new Set(["service", "durable_object_namespace", "dispatch_namespace"]);

function workersScript(resource) {
  const { values, sensitive } = resource;
  const attrs = pickPublic(values, sensitive, ["script_name", "compatibility_date", "main_module"]);
  const bindings = [];
  let bindingsWithheld = false;
  if (Array.isArray(values.bindings)) {
    if (sensitive.bindings === true) {
      bindingsWithheld = true; // the whole list is marked sensitive: report only that it exists
    } else {
      values.bindings.forEach((binding, index) => {
        if (!binding || typeof binding !== "object") return;
        const marker = Array.isArray(sensitive.bindings) ? sensitive.bindings[index] : undefined;
        const picked = pickPublic(binding, marker, ["name", "type", ...BINDING_TARGET_FIELDS]);
        if (typeof picked.name !== "string" || typeof picked.type !== "string") return;
        bindings.push(picked);
      });
    }
  }
  return makeFact({
    source: SOURCE,
    address: resource.address,
    type: resource.type,
    name: attrs.script_name ?? resource.name,
    attrs: {
      ...attrs,
      bindings,
      bindingsWithheld,
      ids: pickPublic(values, sensitive, ["account_id"]),
    },
  });
}

function simple(nameKey, publicKeys, idKeys = []) {
  return (resource) => {
    const attrs = pickPublic(resource.values, resource.sensitive, publicKeys);
    return makeFact({
      source: SOURCE,
      address: resource.address,
      type: resource.type,
      name: typeof attrs[nameKey] === "string" ? attrs[nameKey] : resource.name,
      attrs: { ...attrs, ids: pickPublic(resource.values, resource.sensitive, idKeys) },
    });
  };
}

function tunnelConfig(resource) {
  const { values, sensitive } = resource;
  const ingress = [];
  const rules = values.config?.ingress;
  const markers = sensitive.config?.ingress;
  if (Array.isArray(rules) && markers !== true) {
    rules.forEach((rule, index) => {
      if (!rule || typeof rule !== "object") return;
      const marker = Array.isArray(markers) ? markers[index] : undefined;
      const picked = pickPublic(rule, marker, ["hostname", "path", "service"]);
      if (Object.keys(picked).length > 0) ingress.push(picked);
    });
  }
  return makeFact({
    source: SOURCE,
    address: resource.address,
    type: resource.type,
    name: resource.name,
    attrs: { ingress, ids: pickPublic(values, sensitive, ["tunnel_id", "account_id"]) },
  });
}

function accessApplication(resource) {
  const { values, sensitive } = resource;
  const attrs = pickPublic(values, sensitive, ["name", "domain", "type"]);
  const policies = [];
  if (Array.isArray(values.policies) && !isMarkedSensitive(sensitive.policies)) {
    for (const policy of values.policies) {
      if (!policy || typeof policy !== "object") continue;
      // Who a policy admits (include/require/exclude) is identity data and is not read.
      const picked = pickPublic(policy, undefined, ["name", "decision", "precedence"]);
      if (Object.keys(picked).length > 0) policies.push(picked);
    }
  }
  return makeFact({
    source: SOURCE,
    address: resource.address,
    type: resource.type,
    name: attrs.name ?? resource.name,
    attrs: { ...attrs, policies, ids: pickPublic(values, sensitive, ["id", "account_id", "zone_id"]) },
  });
}

/** Resource type → adapter. A type not listed here produces no fact. */
export const CLOUDFLARE_ADAPTERS = Object.freeze({
  cloudflare_workers_script: workersScript,
  cloudflare_workers_route: simple("pattern", ["pattern", "script"], ["zone_id"]),
  cloudflare_workers_kv_namespace: simple("title", ["title"], ["id", "account_id"]),
  cloudflare_d1_database: simple("name", ["name"], ["id", "uuid", "account_id"]),
  cloudflare_zero_trust_tunnel_cloudflared: simple("name", ["name"], ["id", "account_id"]),
  cloudflare_zero_trust_tunnel_cloudflared_config: tunnelConfig,
  cloudflare_zero_trust_access_application: accessApplication,
  // `content` (an address or target) is not read: only that the name exists and whether it is proxied.
  cloudflare_dns_record: simple("name", ["name", "type", "proxied"], ["zone_id"]),
});

/** True when a binding names another workload (as opposed to storage or config). */
export function isWorkloadBinding(binding) {
  return WORKLOAD_BINDING_TYPES.has(binding?.type);
}

/** The workload a workload-binding names, or "" when the document does not say. */
export function bindingTarget(binding) {
  if (binding.type === "service") return binding.service ?? "";
  if (binding.type === "durable_object_namespace") return binding.script_name ?? "";
  if (binding.type === "dispatch_namespace") return binding.namespace ?? "";
  return "";
}
