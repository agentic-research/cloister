#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Project a Terraform provider schema (`tofu providers schema -json`) down to
// the resource types the facts mapping names (ADR-0073 §3), so the importer
// can validate its mapping against the provider's own published schema without
// vendoring the whole 2.5 MB document. Generated, never hand-edited:
//
//   node gen/facts-spec.mjs <providers-schema.json> \
//     --provider cloudflare/cloudflare --version 5.29.0 \
//     --mapping cli/lib/facts/mappings/cloudflare.json \
//     --out cli/lib/facts/spec/cloudflare.schema.json
//
// A resource that holds an object of another API whole (`objects` in a
// mapping) is checked against that API's own published schema. With `--api`,
// the inputs are the API's OpenAPI v3 documents, and the projection holds the
// kinds of object the mapping reads (ADR-0073, amendment of 2026-11-23):
//
//   node gen/facts-spec.mjs --api kubernetes --version 1.37.0 \
//     --mapping cli/lib/facts/mappings/kubernetes.json \
//     --out cli/lib/facts/spec/kubernetes-api.schema.json \
//     api__v1_openapi.json apis__apps__v1_openapi.json apis__batch__v1_openapi.json
//
// (Kubernetes publishes them in its repository at api/openapi-spec/v3/, at
// each release tag.)
//
// A custom resource is described by its CustomResourceDefinition instead: a
// YAML input is read as one, and its schema (`openAPIV3Schema`) is projected.
// A CRD cannot describe `metadata`, which every Kubernetes object has as the
// API server's ObjectMeta, so `--metadata` names a Kubernetes OpenAPI v3
// document that defines ObjectMeta, and that is what is projected for it:
//
//   node gen/facts-spec.mjs --api knative-serving --version 1.24.0 \
//     --mapping cli/lib/facts/mappings/kubernetes.json \
//     --out cli/lib/facts/spec/knative-serving.schema.json \
//     --metadata api__v1_openapi.json --metadata-version 1.37.0 service.yaml
//
// Kubernetes' documents state no version of their own ("unversioned"), so the
// release ObjectMeta came from is given, and recorded as `objectMeta`.
//
// (Knative publishes the Service CRD at config/core/300-resources/service.yaml
// in knative/serving, at each release tag.)
//
// Each projection holds the kinds of the mapping its inputs define. Every kind
// the mapping reads must be in exactly one projection: the validator checks
// that when the mapping is loaded.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

import { expandMapping, objectKind } from "../cli/lib/facts/mapping.mjs";

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

/**
 * Every dotted path a mapping entry names, each as its segments. A type that
 * reads a held object names its reference attribute on the resource that
 * holds the object, not inside it, so it is left out there.
 */
function mappedPaths(entry, { held = false } = {}) {
  const paths = [entry.name, ...(entry.read ?? []), ...(entry.ids ?? []), ...(held ? [] : entry.referenceAttrs ?? [])];
  for (const list of entry.lists ?? []) {
    paths.push(list.path);
    // A row's field may be a path through nested objects (`valueFrom.secretKeyRef.name`).
    for (const field of list.read ?? []) paths.push(`${list.path}.${field}`);
  }
  // A configured field is a path through nested blocks below the list.
  for (const list of entry.configLists ?? []) for (const field of list.fields ?? []) paths.push(`${list.path}.${field}`);
  for (const relation of entry.relations ?? []) paths.push(relation.attr);
  // A map attribute read whole (a selector, a pod template's labels).
  for (const map of entry.maps ?? []) paths.push(map);
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
  const resourceSchema = (type) => {
    const schema = provider.resource_schemas?.[type];
    if (!schema) throw new Error(`provider schema has no resource type "${type}"`);
    return schema;
  };
  for (const [type, entry] of Object.entries(mapping.types)) {
    // A kind of held object is checked against its API's schema (projectObjectSpec).
    if (objectKind(mapping, type)) continue;
    resources[type] = { attributes: projectBlock(resourceSchema(type).block, mappedPaths(entry)) };
  }
  // A resource that holds an object: the attribute that holds it is what the
  // provider must describe (and leave untyped).
  for (const [type, object] of Object.entries(mapping.objects ?? {})) {
    resources[type] = { attributes: projectBlock(resourceSchema(type).block, [[object.attr]]) };
  }
  return sortKeys({ provider: mapping.provider, version, resources });
}

// ── An API's own schema, for the objects a resource holds ──────────────────

/** A schema with `$ref` and a lone `allOf` wrapper (how OpenAPI v3 adds a description to a ref) followed. */
function resolveSchema(node, document) {
  let at = node;
  for (let hops = 0; hops < 64; hops++) {
    if (at?.$ref) {
      const prefix = "#/components/schemas/";
      if (!at.$ref.startsWith(prefix)) throw new Error(`unsupported $ref ${JSON.stringify(at.$ref)}`);
      const target = document.components?.schemas?.[at.$ref.slice(prefix.length)];
      if (!target) throw new Error(`unresolved $ref ${JSON.stringify(at.$ref)}`);
      at = target;
    } else if (Array.isArray(at?.allOf) && at.type === undefined && at.properties === undefined) {
      if (at.allOf.length !== 1) throw new Error("an allOf of more than one schema is not projected");
      at = at.allOf[0];
    } else {
      return at;
    }
  }
  throw new Error("a $ref chain does not end");
}

/** The projection's scalar type for a schema: "string", "number", "bool", or "dynamic". */
function scalarOf(schema) {
  if (schema?.["x-kubernetes-int-or-string"] === true) return "dynamic";
  if (schema?.type === "string") return "string";
  if (schema?.type === "integer" || schema?.type === "number") return "number";
  if (schema?.type === "boolean") return "bool";
  return "dynamic";
}

/** An object with named fields, or a list of them: what a mapped path may walk into. */
function nestedObject(schema, document) {
  const at = resolveSchema(schema, document);
  if (at?.type === "array") {
    const item = resolveSchema(at.items, document);
    return item?.properties ? { mode: "list", schema: item } : undefined;
  }
  return at?.properties ? { mode: "single", schema: at } : undefined;
}

/**
 * An object schema's fields in the projection's shape (the shape a provider
 * projection has, so one validator walks both). Every field that holds a
 * value is projected; a nested object, or a list of them, only where a mapped
 * path walks through it, as projectBlock does for a provider's blocks.
 */
function projectObject(schema, document, paths) {
  const out = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const through = paths.filter((p) => p[0] === name);
    const nested = nestedObject(field, document);
    if (nested) {
      if (through.length === 0) continue;
      out[name] = {
        sensitive: false,
        nesting_mode: nested.mode,
        attributes: projectObject(nested.schema, document, through.map((p) => p.slice(1)).filter((p) => p.length > 0)),
      };
      continue;
    }
    const at = resolveSchema(field, document);
    let type = scalarOf(at);
    if (at?.type === "array") type = ["list", scalarOf(resolveSchema(at.items, document))];
    else if (at?.type === "object" && at.additionalProperties && typeof at.additionalProperties === "object") {
      type = ["map", scalarOf(resolveSchema(at.additionalProperties, document))];
    }
    // An API schema marks nothing sensitive: a document's own markers still apply when read.
    out[name] = { sensitive: false, type };
  }
  return out;
}

/** `apiVersion` as an object states it: `<group>/<version>`, or `<version>` for the core group. */
const apiVersionOf = ({ group, version }) => (group ? `${group}/${version}` : version);

/** Where Kubernetes' OpenAPI documents define every object's metadata. */
const OBJECT_META = "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta";

/**
 * Project an API's published schema to the kinds of object a mapping reads
 * from the resources that hold them.
 *
 * `documents` are OpenAPI v3 documents: a kind is found by the group, version
 * and kind each schema declares (`x-kubernetes-group-version-kind`), never by
 * its name. `crds` are CustomResourceDefinitions: each served version of one
 * is a kind, `<group>/<version> <kind>`, described by its `openAPIV3Schema`,
 * with `metadata` taken from ObjectMeta in the `metadata` document.
 *
 * Only the kinds these inputs define are projected, and they must define at
 * least one. A kind defined two different ways stops it.
 */
export function projectObjectSpec(documents, { api, version, crds = [], metadata, metadataVersion }, mapping) {
  const kinds = new Map();
  const add = (key, found) => kinds.set(key, [...(kinds.get(key) ?? []), found]);
  for (const document of documents) {
    for (const schema of Object.values(document.components?.schemas ?? {})) {
      for (const gvk of schema["x-kubernetes-group-version-kind"] ?? []) add(`${apiVersionOf(gvk)} ${gvk.kind}`, { schema, document });
    }
  }
  for (const crd of crds) {
    const { group, names, versions } = crd?.spec ?? {};
    if (crd?.kind !== "CustomResourceDefinition" || !group || !names?.kind || !Array.isArray(versions)) {
      throw new Error("a CRD input is not a CustomResourceDefinition with a group, a kind and versions");
    }
    for (const served of versions.filter((v) => v.served === true)) {
      const schema = served.schema?.openAPIV3Schema;
      if (!schema?.properties) throw new Error(`${group}/${served.name} ${names.kind} has no openAPIV3Schema to project`);
      // A CRD may not describe metadata: every object's is the API server's ObjectMeta.
      const withMeta = { ...schema, properties: { ...schema.properties, metadata: { $ref: `#/components/schemas/${OBJECT_META}` } } };
      add(`${group}/${served.name} ${names.kind}`, { schema: withMeta, document: metadata, crd: true });
    }
  }
  const objects = {};
  for (const [type, entry] of Object.entries(mapping.types)) {
    const held = objectKind(mapping, type);
    if (!held) continue;
    if (!held.object) throw new Error(`mapping type "${type}" names no resource the mapping declares under "objects"`);
    const found = kinds.get(held.kind) ?? [];
    // A kind another projection holds is not this one's.
    if (found.length === 0) continue;
    if (found.some((f) => f.crd) && !metadata?.components?.schemas?.[OBJECT_META]) {
      throw new Error(`${held.kind} is a custom resource, whose metadata is Kubernetes' ObjectMeta: give a Kubernetes OpenAPI v3 document that defines it (--metadata)`);
    }
    const projections = new Set(found.map(({ schema, document }) => {
      const projected = projectObject(resolveSchema(schema, document), document, mappedPaths(entry, { held: true }));
      return JSON.stringify(sortKeys(projected));
    }));
    // A document carries a copy of every kind it refers to. The copies must agree.
    if (projections.size !== 1) throw new Error(`the ${api} documents define ${held.kind} more than one way`);
    objects[held.kind] = { attributes: JSON.parse([...projections][0]) };
  }
  if (Object.keys(objects).length === 0) throw new Error(`the ${api} inputs define no kind the mapping reads`);
  if (crds.length > 0 && !metadataVersion) throw new Error("a custom resource's metadata comes from a Kubernetes release: say which (--metadata-version)");
  // Where every custom resource's metadata was projected from.
  const objectMeta = crds.length > 0 ? { objectMeta: { api: "kubernetes", version: metadataVersion } } : {};
  return sortKeys({ api, version, ...objectMeta, objects });
}

/** The CustomResourceDefinitions in a YAML file (one or several documents). */
export function readCrds(text) {
  return parseAllDocuments(text).map((doc) => doc.toJS()).filter((doc) => doc?.kind === "CustomResourceDefinition");
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
  const usable = flags.api ? positional.length > 0 : input && flags.provider;
  if (!usable || !flags.version || !flags.mapping || !flags.out) {
    console.error(
      "usage: gen/facts-spec.mjs <providers-schema.json> --provider <registry suffix, e.g. hashicorp/google> " +
        "--version <provider version> --mapping <mapping.json> --out <spec.json>\n" +
        "       gen/facts-spec.mjs --api <name> --version <API version> --mapping <mapping.json> --out <spec.json> " +
        "[--metadata <kubernetes-openapi-v3.json> --metadata-version <kubernetes version>] <openapi-v3.json | crd.yaml>...",
    );
    process.exit(2);
  }
  // Every `like` is resolved first, so a type that is like another is
  // projected, and later validated, against its own schema.
  const mapping = expandMapping(JSON.parse(readFileSync(flags.mapping, "utf8")));
  const isYaml = (file) => /\.ya?ml$/.test(file);
  const spec = flags.api
    ? projectObjectSpec(
        positional.filter((file) => !isYaml(file)).map((file) => JSON.parse(readFileSync(file, "utf8"))),
        {
          api: flags.api,
          version: flags.version,
          crds: positional.filter(isYaml).flatMap((file) => readCrds(readFileSync(file, "utf8"))),
          metadata: flags.metadata ? JSON.parse(readFileSync(flags.metadata, "utf8")) : undefined,
          metadataVersion: flags["metadata-version"],
        },
        mapping,
      )
    : projectSpec(JSON.parse(readFileSync(input, "utf8")), flags.version, mapping, flags.provider);
  writeFileSync(flags.out, renderSpec(spec));
  console.log(`wrote ${flags.out}`);
}
