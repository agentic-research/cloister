// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The published schema of an object a resource holds whole, projected to what
// a mapping reads (ADR-0073, amendments of 2026-11-23 and 2026-11-24).
//
// Two callers project with this code, and they must agree byte for byte:
//
//   gen/facts-spec.mjs   writes the projections cloister ships, from
//                        Kubernetes' OpenAPI v3 documents and Knative's CRD;
//   cloister inspect     projects a CRD a checkout supplies, when it runs.
//
// A CRD may not describe `metadata`: every object's is the API server's
// ObjectMeta. The generator takes it from a Kubernetes OpenAPI document. At
// run time there is none, so cloister ships ObjectMeta's schema, and the
// schemas it refers to, as they are in that document
// (spec/kubernetes-object-meta.schema.json, written by projectObjectMeta and
// rebuilt in CI from the release it records).

import { parseAllDocuments } from "yaml";

import { objectKind } from "./mapping.mjs";

/**
 * Every dotted path a mapping entry names, each as its segments. A type that
 * reads a held object names its reference attribute on the resource that
 * holds the object, not inside it, so it is left out there.
 */
export function mappedPaths(entry, { held = false } = {}) {
  const paths = [entry.name, ...(entry.read ?? []), ...(entry.ids ?? []), ...(entry.strings ?? []), ...(entry.present ?? []), ...(held ? [] : entry.referenceAttrs ?? [])];
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

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function renderSpec(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

const SCHEMAS = "#/components/schemas/";

/** A schema with `$ref` and a lone `allOf` wrapper (how OpenAPI v3 adds a description to a ref) followed. */
function resolveSchema(node, document) {
  let at = node;
  for (let hops = 0; hops < 64; hops++) {
    if (at?.$ref) {
      if (!at.$ref.startsWith(SCHEMAS)) throw new Error(`unsupported $ref ${JSON.stringify(at.$ref)}`);
      const target = document.components?.schemas?.[at.$ref.slice(SCHEMAS.length)];
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
 * path walks through it, as a provider's blocks are.
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
export const OBJECT_META = "io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta";

/**
 * The kinds a CRD serves: each served version is one, `<group>/<version>
 * <kind>`, described by its `openAPIV3Schema`, with `metadata` as ObjectMeta.
 */
export function crdKinds(crd) {
  const { group, names, versions } = crd?.spec ?? {};
  if (crd?.kind !== "CustomResourceDefinition" || !group || !names?.kind || !Array.isArray(versions)) {
    throw new Error("a CRD input is not a CustomResourceDefinition with a group, a kind and versions");
  }
  return versions.filter((v) => v.served === true).map((served) => {
    const schema = served.schema?.openAPIV3Schema;
    if (!schema?.properties) throw new Error(`${group}/${served.name} ${names.kind} has no openAPIV3Schema to project`);
    // A CRD may not describe metadata: every object's is the API server's ObjectMeta.
    const withMeta = { ...schema, properties: { ...schema.properties, metadata: { $ref: `${SCHEMAS}${OBJECT_META}` } } };
    return { kind: `${group}/${served.name} ${names.kind}`, schema: withMeta };
  });
}

/**
 * Project an API's published schema to the kinds of object a mapping reads
 * from the resources that hold them.
 *
 * `documents` are OpenAPI v3 documents: a kind is found by the group, version
 * and kind each schema declares (`x-kubernetes-group-version-kind`), never by
 * its name. `crds` are CustomResourceDefinitions (see crdKinds), with
 * `metadata` taken from ObjectMeta in the `metadata` document.
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
    for (const { kind, schema } of crdKinds(crd)) add(kind, { schema, document: metadata, crd: true });
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

/** A schema as projectObjectMeta keeps it: everything but `description`, which no projection reads. */
function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description").map(([key, inner]) => [key, withoutDescriptions(inner)]));
  }
  return value;
}

/** Every schema name a schema refers to by `$ref`, at any depth. */
function referencedSchemas(value, out = new Set()) {
  if (Array.isArray(value)) for (const inner of value) referencedSchemas(inner, out);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "$ref" && typeof inner === "string") {
        if (!inner.startsWith(SCHEMAS)) throw new Error(`unsupported $ref ${JSON.stringify(inner)}`);
        out.add(inner.slice(SCHEMAS.length));
      } else {
        referencedSchemas(inner, out);
      }
    }
  }
  return out;
}

/**
 * ObjectMeta's schema and every schema it refers to, as Kubernetes' OpenAPI
 * documents define them, without their descriptions: what a CRD's kinds need
 * for `metadata` when they are projected. Every document that defines
 * ObjectMeta must define it, and what it refers to, the same way.
 */
export function projectObjectMeta(documents, { api, version }) {
  const closures = new Set();
  for (const document of documents) {
    const defined = document.components?.schemas ?? {};
    if (!Object.hasOwn(defined, OBJECT_META)) continue;
    const schemas = {};
    const pending = [OBJECT_META];
    while (pending.length) {
      const name = pending.pop();
      if (Object.hasOwn(schemas, name)) continue;
      if (!Object.hasOwn(defined, name)) throw new Error(`unresolved $ref ${JSON.stringify(`${SCHEMAS}${name}`)}`);
      schemas[name] = withoutDescriptions(defined[name]);
      for (const inner of referencedSchemas(schemas[name])) pending.push(inner);
    }
    closures.add(JSON.stringify(sortKeys(schemas)));
  }
  if (closures.size === 0) throw new Error(`the ${api} documents define no ${OBJECT_META}`);
  if (closures.size > 1) throw new Error(`the ${api} documents define ${OBJECT_META} more than one way`);
  return sortKeys({ api, version, schemas: JSON.parse([...closures][0]) });
}

/** A document holding the schemas projectObjectMeta kept, for projectObjectSpec's `metadata`. */
export const objectMetaDocument = (objectMeta) => ({ components: { schemas: objectMeta.schemas } });
