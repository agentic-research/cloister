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
//
// A checkout may supply a CRD of its own, projected when `cloister inspect`
// runs (ADR-0073, amendment of 2026-11-24, proposed). That needs ObjectMeta's
// schema with no Kubernetes document at hand, so cloister ships it, as the
// document defines it, and `--object-meta` writes it:
//
//   node gen/facts-spec.mjs --api kubernetes --version 1.37.0 --object-meta \
//     --out cli/lib/facts/spec/kubernetes-object-meta.schema.json api__v1_openapi.json
//
// The object projection itself is cli/lib/facts/object-spec.mjs, so the CLI
// and this generator project with the same code.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expandMapping, objectKind } from "../cli/lib/facts/mapping.mjs";
import { mappedPaths, projectObjectMeta, projectObjectSpec, readCrds, renderSpec, sortKeys } from "../cli/lib/facts/object-spec.mjs";

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = {};
  const positional = [];
  const BOOLEAN = new Set(["object-meta"]);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) positional.push(args[i]);
    else if (BOOLEAN.has(args[i].slice(2))) flags[args[i].slice(2)] = true;
    else flags[args[i].slice(2)] = args[++i];
  }
  const [input] = positional;
  const usable = flags.api ? positional.length > 0 : input && flags.provider;
  if (flags["object-meta"] && usable && flags.version && flags.out) {
    const documents = positional.map((file) => JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(flags.out, renderSpec(projectObjectMeta(documents, { api: flags.api, version: flags.version })));
    console.log(`wrote ${flags.out}`);
    process.exit(0);
  }
  if (!usable || !flags.version || !flags.mapping || !flags.out) {
    console.error(
      "usage: gen/facts-spec.mjs <providers-schema.json> --provider <registry suffix, e.g. hashicorp/google> " +
        "--version <provider version> --mapping <mapping.json> --out <spec.json>\n" +
        "       gen/facts-spec.mjs --api <name> --version <API version> --mapping <mapping.json> --out <spec.json> " +
        "[--metadata <kubernetes-openapi-v3.json> --metadata-version <kubernetes version>] <openapi-v3.json | crd.yaml>...\n" +
        "       gen/facts-spec.mjs --api <name> --version <API version> --object-meta --out <spec.json> <openapi-v3.json>...",
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
