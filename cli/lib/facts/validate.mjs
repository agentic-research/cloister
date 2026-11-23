// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Validate a facts mapping against the published spec it claims to follow
// (ADR-0073 §3). The attribute set is data; the spec is what keeps that data
// honest: a typo'd attribute, a secret, or a non-scalar cannot be mapped.

import { validateAppProtocol } from "../app-protocol.mjs";
import { FORWARDED_KINDS } from "../cluster/connections.mjs";
import { objectKind } from "./mapping.mjs";

const SCALARS = new Set(["string", "number", "bool"]);

/** Walk a dotted attribute path through a spec attribute map; returns the leaf entry. */
function lookup(attributes, path, label) {
  let level = attributes;
  let entry;
  const segments = path.split(".");
  for (const [i, segment] of segments.entries()) {
    entry = level?.[segment];
    if (!entry) throw new Error(`mapping: unknown attribute "${label}${path}" (not in the published schema)`);
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

/**
 * Throws by name on the first violation.
 *
 * `objectSpec` is the projection of the published schema of the objects a
 * resource holds whole (a mapping's `objects`; ADR-0073, amendment of
 * 2026-11-23). A type that reads such an object is checked against it, and
 * the declaration itself against the provider's schema: the attribute that
 * holds the object must be one the provider leaves untyped.
 */
export function validateMapping(mapping, spec, objectSpec) {
  const resources = spec?.resources ?? {};
  const objects = mapping.objects ?? {};
  if (!isTable(objects)) throw new Error("mapping: \"objects\" must be a table");
  for (const [type, object] of Object.entries(objects)) {
    const where = `objects.${type}`;
    if (!isTable(object)) throw new Error(`mapping: ${where} must be a table`);
    onlyKeys(object, ["attr", "by"], where);
    if (!isText(object.attr) || object.attr.includes(".")) throw new Error(`mapping: ${where} needs an "attr": the attribute that holds the object`);
    if (!Array.isArray(object.by) || object.by.length === 0 || !object.by.every((f) => isText(f) && !/[\s.]/.test(f)) || new Set(object.by).size !== object.by.length) {
      throw new Error(`mapping: ${where} "by" must list the object's fields that say what it is, each once`);
    }
    if (Object.hasOwn(mapping.types ?? {}, type)) throw new Error(`mapping: ${type} is read as the objects it holds, and cannot also be a type`);
    if (!resources[type]) throw new Error(`mapping: unknown resource type "${type}" (${where}, not in the provider spec)`);
    const held = lookup(resources[type].attributes, object.attr, `${type}.`);
    if (held.type !== "dynamic") throw new Error(`mapping: ${type}.${object.attr} is typed by the provider; map its paths, not an object`);
  }
  const attrsOf = (type, where) => {
    const held = objectKind(mapping, type);
    if (held) {
      if (!held.object) throw new Error(`mapping: type "${type}" names "${held.resourceType}", which the mapping does not declare under "objects"`);
      if (held.values.length !== held.object.by.length || held.values.some((v) => v === "")) {
        throw new Error(`mapping: type "${type}" must name ${held.resourceType} and its ${held.object.by.join(" and ")}, one space apart`);
      }
      const found = objectSpec?.objects?.[held.kind];
      if (!found) throw new Error(`mapping: type "${type}" reads a kind, ${held.kind}, that the ${objectSpec?.api ?? "object"} spec does not define`);
      return found.attributes;
    }
    if (!resources[type]) throw new Error(`mapping: unknown resource type "${type}" (${where})`);
    return resources[type].attributes;
  };
  for (const [type, entry] of Object.entries(mapping.types ?? {})) {
    const attributes = attrsOf(type, "not in the provider spec");
    const held = objectKind(mapping, type);
    const here = `${type}.`;
    if (entry.name !== undefined) scalar(attributes, entry.name, here);
    for (const path of [...(entry.read ?? []), ...(entry.ids ?? [])]) scalar(attributes, path, here);
    // A reference attribute only has to exist (and not be sensitive): it is
    // whatever the configuration wires into it, and only its references are read.
    // An object held whole is one expression in the configuration. Where in
    // it a reference sits, and which row a value came from, is not written,
    // so neither its references nor its rows are read from there.
    if (held) {
      if (entry.referenceAttrs !== undefined) {
        throw new Error(`mapping: ${here}referenceAttrs: an object held whole is one expression, and where a reference sits in it is not written`);
      }
      if (entry.configLists !== undefined) {
        throw new Error(`mapping: ${here}configLists: an object held whole has no rows in the configuration; read its rows with "lists"`);
      }
    } else {
      for (const path of entry.referenceAttrs ?? []) lookup(attributes, path, `${here}referenceAttrs.`);
    }
    // A configured list is read from the plan's configuration: the same
    // block, as the source wrote it. Every field must be a scalar the
    // provider does not mark sensitive, so a constant copied from it is one
    // the provider itself treats as public.
    for (const list of entry.configLists ?? []) {
      if (!isTable(list) || !isText(list.path) || !Array.isArray(list.fields) || list.fields.length === 0) {
        throw new Error(`mapping: ${here}configLists needs a "path" and a non-empty "fields" list`);
      }
      onlyKeys(list, ["path", "fields"], `${here}configLists`);
      const nested = lookup(attributes, list.path, here);
      if (!nested.attributes) throw new Error(`mapping: configured list "${here}${list.path}" is not a nested attribute`);
      for (const field of list.fields) scalar(nested.attributes, field, `${here}${list.path}.`);
    }
    for (const list of entry.lists ?? []) {
      const nested = lookup(attributes, list.path, here);
      if (!nested.attributes) throw new Error(`mapping: list "${here}${list.path}" is not a nested attribute`);
      for (const path of list.read ?? []) scalar(nested.attributes, path, `${here}${list.path}.`);
      // `strings` names attributes of a row that are themselves lists of
      // strings (a container's `args`), read whole.
      for (const path of list.strings ?? []) {
        const leaf = lookup(nested.attributes, path, `${here}${list.path}.`);
        const [collection, element] = Array.isArray(leaf.type) ? leaf.type : [];
        if (!["list", "set"].includes(collection) || element !== "string") {
          throw new Error(`mapping: "${here}${list.path}.${path}" is not a list of strings`);
        }
      }
    }
    // A map read whole: it must be a map of strings the provider does not
    // mark sensitive. Nothing else can be read as a set of pairs.
    for (const path of entry.maps ?? []) {
      const leaf = lookup(attributes, path, here);
      const [collection, element] = Array.isArray(leaf.type) ? leaf.type : [];
      if (collection !== "map" || element !== "string") throw new Error(`mapping: "${here}${path}" is not a map of strings`);
    }
    for (const rel of entry.relations ?? []) {
      scalar(attributes, rel.attr, here);
      checkTarget(rel, attrsOf, `${here}${rel.attr}`);
      checkScope(rel, attributes, attrsOf(rel.toType, "relation target"), `${here}${rel.attr}`);
    }
    checkReport(type, entry, mapping.types);
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

/**
 * `scope` attributes are compared on BOTH resources, so each must be a
 * non-sensitive scalar on both types, or the join would compare against
 * something the mapping never reads. `stripPrefix` is one literal string.
 */
function checkScope(rel, attributes, targetAttributes, from) {
  if (rel.scope !== undefined) {
    if (!Array.isArray(rel.scope) || rel.scope.length === 0) throw new Error(`mapping: relation ${from} "scope" must be a non-empty list of attributes`);
    for (const attr of rel.scope) {
      if (typeof attr !== "string") throw new Error(`mapping: relation ${from} "scope" must be a non-empty list of attributes`);
      scalar(attributes, attr, `${from} scope `);
      scalar(targetAttributes, attr, `${rel.toType} scope `);
    }
  }
  if (rel.stripPrefix !== undefined && (typeof rel.stripPrefix !== "string" || rel.stripPrefix === "")) {
    throw new Error(`mapping: relation ${from} "stripPrefix" must be a non-empty string`);
  }
}

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";
function onlyKeys(table, allowed, where) {
  for (const key of Object.keys(table)) {
    if (!allowed.includes(key)) throw new Error(`mapping: ${where} has unknown key "${key}"`);
  }
}

/**
 * `report` and `access` say how a type appears in the inspect report. They may
 * only name attributes the entry already lists under `read`, which the checks
 * above hold to the provider spec: the report cannot show, or decide on,
 * anything the importer was not allowed to read.
 */
function checkReport(type, entry, types = {}) {
  const read = entry.read ?? [];
  if (entry.report !== undefined) {
    const { report } = entry;
    if (!isTable(report) || !isText(report.section) || !Array.isArray(report.show)) {
      throw new Error(`mapping: ${type}.report needs a "section" title and a "show" list`);
    }
    onlyKeys(report, ["section", "show", "address", "hosts", "standsFor", "dials", "references", "bundle"], `${type}.report`);
    // `hosts`: names this resource answers to that are built from what it
    // reads. Every `{attribute}` must be one the entry reads, or `{name}`.
    if (report.hosts !== undefined) {
      if (!Array.isArray(report.hosts) || report.hosts.length === 0 || !report.hosts.every(isText)) {
        throw new Error(`mapping: ${type}.report hosts must be a non-empty list of templates`);
      }
      for (const template of report.hosts) {
        const keys = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
        if (keys.length === 0) throw new Error(`mapping: ${type}.report hosts "${template}" names no attribute: a fixed host is not a resource's address`);
        for (const key of keys) {
          if (key !== "name" && !read.includes(key)) throw new Error(`mapping: ${type}.report hosts uses "{${key}}", which is not in its "read" list`);
        }
        if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""))) throw new Error(`mapping: ${type}.report hosts "${template}" has an unclosed brace`);
      }
    }
    // `standsFor`: this resource is an address for another one, found by a
    // selector map here matching a label map there. Both maps must be read,
    // and the scope attributes must be read on both sides.
    if (report.standsFor !== undefined) {
      const rule = report.standsFor;
      const where = `${type}.report standsFor`;
      if (!isTable(rule)) throw new Error(`mapping: ${where} must be a table`);
      onlyKeys(rule, ["selector", "labels", "toTypes", "scope"], where);
      if (!isText(rule.selector) || !(entry.maps ?? []).includes(rule.selector)) throw new Error(`mapping: ${where} selector must be one of the entry's "maps"`);
      if (!Array.isArray(rule.toTypes) || rule.toTypes.length === 0) throw new Error(`mapping: ${where} needs a non-empty "toTypes" list`);
      if (!Array.isArray(rule.scope) || !rule.scope.every(isText)) throw new Error(`mapping: ${where} "scope" must be a list of attributes`);
      for (const attr of rule.scope) if (!read.includes(attr)) throw new Error(`mapping: ${where} scope "${attr}" is not in its "read" list`);
      for (const toType of rule.toTypes) {
        const target = typeof toType === "string" && Object.hasOwn(types, toType) ? types[toType] : undefined;
        if (!target) throw new Error(`mapping: ${where} names "${toType}", which this mapping does not describe`);
        if (!isText(rule.labels) || !(target.maps ?? []).includes(rule.labels)) throw new Error(`mapping: ${where} labels "${rule.labels}" is not one of ${toType}'s "maps"`);
        for (const attr of rule.scope) if (!(target.read ?? []).includes(attr)) throw new Error(`mapping: ${where} scope "${attr}" is not read by ${toType}`);
      }
    }
    for (const attr of report.show) {
      if (!read.includes(attr)) throw new Error(`mapping: ${type}.report shows "${attr}", which is not in its "read" list`);
    }
    // `address`: the attribute holding where this resource is reached.
    if (report.address !== undefined && !read.includes(report.address)) {
      throw new Error(`mapping: ${type}.report address "${report.address}" is not in its "read" list`);
    }
    // `dials`: where this resource's own strings may name another resource's
    // address. Each names one of the entry's lists and a field that list reads.
    const lists = new Map((entry.lists ?? []).map((list) => [list.path.split(".").pop(), list]));
    for (const dial of report.dials ?? []) {
      if (!isTable(dial) || !isText(dial.prefix) || !lists.has(dial.list)) {
        throw new Error(`mapping: ${type}.report dials needs a "prefix" and a "list" the entry reads`);
      }
      onlyKeys(dial, ["list", "value", "label", "strings", "prefix"], `${type}.report dials`);
      const list = lists.get(dial.list);
      for (const key of ["value", "label"]) {
        if (dial[key] !== undefined && !(list.read ?? []).includes(dial[key])) {
          throw new Error(`mapping: ${type}.report dials ${key} "${dial[key]}" is not read from list "${dial.list}"`);
        }
      }
      if (dial.strings !== undefined && !(list.strings ?? []).includes(dial.strings)) {
        throw new Error(`mapping: ${type}.report dials strings "${dial.strings}" is not read from list "${dial.list}"`);
      }
      if ((dial.value === undefined) === (dial.strings === undefined)) {
        throw new Error(`mapping: ${type}.report dials on list "${dial.list}" needs exactly one of "value" or "strings"`);
      }
    }
    for (const attr of report.references ?? []) {
      if (!(entry.referenceAttrs ?? []).includes(attr)) {
        throw new Error(`mapping: ${type}.report references "${attr}", which is not in its "referenceAttrs"`);
      }
    }
    // `bundle`: this type is a workload, and how one is drafted as a bundle
    // (ADR-0074 §3, §6). The mapping names the placement kind its workloads
    // satisfy, so a provider is added here and not in cloister's code. Only a
    // forwarded kind may be named: cloister does not build these.
    if (report.bundle !== undefined) {
      const { bundle } = report;
      const where = `${type}.report bundle`;
      if (!isTable(bundle) || !FORWARDED_KINDS.includes(bundle.placement)) {
        throw new Error(`mapping: ${where} needs a "placement" that is one of ${FORWARDED_KINDS.join(", ")}`);
      }
      onlyKeys(bundle, ["placement", "runs", "image", "args", "command", "env", "ports", "wires", "exposure", "identity"], where);
      // `identity`: who the workload runs as, and how an access row names
      // that principal. The attribute must be one the entry reads; the
      // template holds exactly one `{}`, where the attribute's value goes.
      if (bundle.identity !== undefined) {
        const { identity } = bundle;
        if (!isTable(identity)) throw new Error(`mapping: ${where} identity must be a table`);
        onlyKeys(identity, ["attr", "principal"], `${where} identity`);
        if (!read.includes(identity.attr)) throw new Error(`mapping: ${where} identity attr "${identity.attr}" is not in its "read" list`);
        if (!isText(identity.principal) || identity.principal.split("{}").length !== 2) {
          throw new Error(`mapping: ${where} identity principal must hold exactly one "{}", where the attribute's value goes`);
        }
      }
      // `exposure`: the attribute that says whether the workload can be
      // reached from outside its network, and which of its values mean which.
      // It is what a port's `expose` is compared with (ADR-0074).
      if (bundle.exposure !== undefined) {
        const { exposure } = bundle;
        onlyKeys(exposure, ["attr", "cluster", "edge"], `${where} exposure`);
        if (!isTable(exposure) || !read.includes(exposure.attr)) {
          throw new Error(`mapping: ${where} exposure needs an "attr" that is in the entry's "read" list`);
        }
        const values = [];
        for (const key of ["cluster", "edge"]) {
          if (!Array.isArray(exposure[key]) || exposure[key].length === 0 || !exposure[key].every(isText)) {
            throw new Error(`mapping: ${where} exposure needs a non-empty "${key}" list of values`);
          }
          values.push(...exposure[key]);
        }
        if (new Set(values).size !== values.length) {
          throw new Error(`mapping: ${where} exposure lists one value as both "cluster" and "edge"`);
        }
      }
      // How the workload runs: until it is stopped, or to completion.
      if (bundle.runs !== undefined && !["service", "job"].includes(bundle.runs)) {
        throw new Error(`mapping: ${where} "runs" must be "service" or "job"`);
      }
      for (const key of ["args", "command"]) {
        if (bundle[key] === undefined) continue;
        onlyKeys(bundle[key], ["list", "strings"], `${where} ${key}`);
        if (!isTable(bundle[key]) || !lists.has(bundle[key].list) || !(lists.get(bundle[key].list).strings ?? []).includes(bundle[key].strings)) {
          throw new Error(`mapping: ${where} ${key} needs a "list" the entry reads and a "strings" attribute it reads from it`);
        }
      }
      // `env`: where a workload's environment is read. From the
      // configuration (`configured`, a configList) where the source has rows;
      // from the values (`list`, a list the entry reads) where it does not:
      // an object held whole is one expression.
      if (bundle.env !== undefined) {
        const { env } = bundle;
        if (!isTable(env)) throw new Error(`mapping: ${where} env must be a table`);
        onlyKeys(env, ["configured", "list", "name", "value", "secret", "secretVersion"], `${where} env`);
        if ((env.configured === undefined) === (env.list === undefined)) {
          throw new Error(`mapping: ${where} env needs exactly one of "configured" (a configList) or "list" (a list the entry reads)`);
        }
        let fields;
        if (env.configured !== undefined) {
          const configured = (entry.configLists ?? []).find((list) => list.path.split(".").pop() === env.configured);
          if (!configured) throw new Error(`mapping: ${where} env needs a "configured" list the entry declares in configLists`);
          fields = { of: `configured list "${env.configured}"`, names: configured.fields };
        } else {
          if (!lists.has(env.list)) throw new Error(`mapping: ${where} env "list" must be a list the entry reads`);
          fields = { of: `list "${env.list}"`, names: lists.get(env.list).read ?? [] };
        }
        for (const key of ["name", "value", "secret", "secretVersion"]) {
          if (key === "name" || key === "value" ? !isText(env[key]) : env[key] !== undefined && !isText(env[key])) {
            throw new Error(`mapping: ${where} env needs "name" and "value" fields`);
          }
          if (env[key] !== undefined && !fields.names.includes(env[key])) {
            throw new Error(`mapping: ${where} env ${key} "${env[key]}" is not a field of ${fields.of}`);
          }
        }
      }
      const readFrom = (ref, keys, what) => {
        if (!isTable(ref) || !lists.has(ref.list)) throw new Error(`mapping: ${where} ${what} needs a "list" the entry reads`);
        for (const key of keys) {
          if (!(lists.get(ref.list).read ?? []).includes(ref[key])) {
            throw new Error(`mapping: ${where} ${what} ${key} "${ref[key]}" is not read from list "${ref.list}"`);
          }
        }
      };
      if (bundle.image !== undefined) {
        onlyKeys(bundle.image, ["list", "value"], `${where} image`);
        readFrom(bundle.image, ["value"], "image");
      }
      // A wire is the provider's name for how a port is served; its value is
      // the app_protocol label a drafted port carries.
      const wires = bundle.wires ?? {};
      if (!isTable(wires)) throw new Error(`mapping: ${where} wires must be a table`);
      for (const [wire, label] of Object.entries(wires)) {
        const problem = validateAppProtocol(label);
        if (problem) throw new Error(`mapping: ${where} wires "${wire}": appProtocol ${problem}`);
      }
      if (bundle.ports !== undefined) {
        onlyKeys(bundle.ports, ["list", "name", "port", "default", "byConvention"], `${where} ports`);
        // `byConvention`: on this provider a port's name is free text, and
        // reading a protocol from it is a convention. The draft then says so.
        if (bundle.ports.byConvention !== undefined && typeof bundle.ports.byConvention !== "boolean") {
          throw new Error(`mapping: ${where} ports "byConvention" must be true or false`);
        }
        readFrom(bundle.ports, ["name", "port"], "ports");
        const fallback = bundle.ports.default;
        if (fallback !== undefined) {
          onlyKeys(fallback, ["name", "port"], `${where} ports default`);
          if (!Number.isInteger(fallback.port) || fallback.port < 1 || !Object.hasOwn(wires, fallback.name)) {
            throw new Error(`mapping: ${where} ports default needs a "port" number and a "name" that is one of its wires`);
          }
        }
        if (Object.keys(wires).length === 0) throw new Error(`mapping: ${where} declares ports and no "wires"`);
      }
    }
  }
  if (entry.access !== undefined) {
    const { access } = entry;
    if (!isTable(access) || !isTable(access.roles) || Object.keys(access.roles).length === 0) {
      throw new Error(`mapping: ${type}.access needs "role", "principal" and a non-empty "roles" table`);
    }
    onlyKeys(access, ["role", "principal", "roles", "publicPrincipals"], `${type}.access`);
    for (const key of ["role", "principal"]) {
      if (!read.includes(access[key])) throw new Error(`mapping: ${type}.access ${key} "${access[key]}" is not in its "read" list`);
    }
    for (const [role, label] of Object.entries(access.roles)) {
      if (!isText(label)) throw new Error(`mapping: ${type}.access role "${role}" needs a label`);
    }
    if (access.publicPrincipals !== undefined && !(Array.isArray(access.publicPrincipals) && access.publicPrincipals.every(isText))) {
      throw new Error(`mapping: ${type}.access "publicPrincipals" must be a list of strings`);
    }
    if ((entry.relations ?? []).length === 0) {
      throw new Error(`mapping: ${type}.access needs a relation: an access row belongs to the resource its relation resolves to`);
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
    // One attribute, or a list of alternatives tried in order.
    const alternatives = Array.isArray(rel.toAttr) ? rel.toAttr : [rel.toAttr];
    if (alternatives.length === 0) throw new Error("mapping: toAttr lists no attribute");
    for (const toAttr of alternatives) scalar(attributes, toAttr, `${rel.toType}.`);
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
