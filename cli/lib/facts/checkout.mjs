// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a checkout adds to what `cloister inspect` reads with (ADR-0073,
// amendment of 2026-11-24): the CRDs of kinds cloister does not ship, or the
// cluster's own version of one it does, and the entries that say what each
// kind means. cluster.toml names the files ([inspect]); `--crd` and
// `--mapping` add files for one run.
//
// Every definition of a kind comes from one place, and a declaration wins
// only where it says it does:
//
//   cloister's projections          the kinds cloister ships a schema for
//   a row for every environment     may replace one of those, listed in `replaces`
//   a row for this environment      may replace either, listed in `replaces`,
//                                   in this environment only
//   a file a flag adds              may only add kinds
//
// An overlap a row does not list is refused, and so is a listed kind with
// nothing to replace. The entries cloister ships, and the checkout's, are then
// validated against the schemas that apply, together: an entry of cloister's
// for a kind a checkout replaced is checked against the replacement, and a
// path the replacement lacks refuses the run.

import { environmentsOf } from "../cluster/connections.mjs";
import {
  CLOUDFLARE_MAPPING,
  GOOGLE_MAPPING,
  KNATIVE_SERVING_SPEC,
  KUBERNETES_API_SPEC,
  KUBERNETES_MAPPING,
  KUBERNETES_OBJECT_META,
  KUBERNETES_SPEC,
  SHIPPED,
  makeRegistry,
} from "./cloudflare.mjs";
import { deepFreeze } from "./facts.mjs";
import { expandMapping, expandPodTemplates, objectKind } from "./mapping.mjs";
import { crdKinds, objectMetaDocument, projectObjectSpec, readCrds } from "./object-spec.mjs";
import { validateMapping } from "./validate.mjs";

/** The mapping that reads the objects a checkout's entries read: the one with `objects`. */
const HOLDING = KUBERNETES_MAPPING;
/** The entry whose pod template a `podTemplate` reads like. */
const DEPLOYMENT = HOLDING.types["kubernetes_manifest apps/v1 Deployment"];
/** cloister's projections of the kinds objects may be, as they ship. */
const SHIPPED_SPECS = [KUBERNETES_API_SPEC, KNATIVE_SERVING_SPEC];

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const KIND = /^\S+ \S+$/;
const shippedLabel = (spec) => `cloister's ${spec.api} ${spec.version} projection`;

/**
 * The rows of cluster.toml's [inspect], with each file resolved by `resolve`
 * (relative to the directory holding cluster.toml). A file the checkout
 * names must be in the checkout: an absolute path, or one that leaves the
 * directory, is refused, since the checkout would not carry it.
 */
export function checkoutRows(inspect, resolve) {
  const named = (file, where) => {
    if (typeof file !== "string" || file === "") throw new Error(`cluster.toml's ${where} needs a "file"`);
    if (file.startsWith("/") || file.split(/[\\/]/).includes("..")) {
      throw new Error(`cluster.toml's ${where} names ${JSON.stringify(file)}: a file the checkout names is a path inside the checkout, relative to cluster.toml`);
    }
    return { file, path: resolve(file) };
  };
  return {
    mappings: (inspect?.mappings ?? []).map((file) => ({ ...named(file, "[inspect] mappings"), from: "cluster.toml" })),
    crds: (inspect?.crds ?? []).map((row) => ({
      ...named(row.file, "[[inspect.crds]] row"),
      env: row.env ?? "",
      replaces: [...(row.replaces ?? [])],
      from: "cluster.toml",
    })),
  };
}

/**
 * The registry `inspect` reads with, and where each kind's schema and entry
 * came from. With no checkout files this is cloister's own registry.
 *
 * @param {object} input
 * @param {{file, path, env, replaces, from}[]} input.crds    CRD files: cluster.toml rows, then `--crd` files
 * @param {{file, path, from}[]} input.mappings              mapping files: cluster.toml's, then `--mapping` files
 * @param {(path: string) => string} input.read               reads a file
 * @param {string} [input.env]                                the environment the plan describes (--env)
 * @param {object} [input.cluster]                            the parsed cluster.toml, for the environments it names
 */
export function readWithCheckout({ crds = [], mappings = [], read, env, cluster }) {
  if (crds.length === 0 && mappings.length === 0) return { registry: SHIPPED, checkout: null };
  const environments = environmentsOf(cluster);

  // ── Which rows apply ─────────────────────────────────────────────────────
  for (const row of crds) {
    if (row.from !== "cluster.toml" && (row.env !== "" || row.replaces.length > 0)) {
      throw new Error(`${row.file}: a file a flag adds may only add kinds. A replacement is declared in cluster.toml, where the checkout carries it`);
    }
    if (row.env !== "" && !environments.has(row.env)) {
      throw new Error(`cluster.toml's [[inspect.crds]] row for ${row.file} names environment "${row.env}", which no placement or connection in cluster.toml names`);
    }
    const seen = new Set();
    for (const kind of row.replaces) {
      if (typeof kind !== "string" || !KIND.test(kind)) throw new Error(`${row.file}: replaces lists ${JSON.stringify(kind)}, which is not a kind, "<apiVersion> <kind>"`);
      if (seen.has(kind)) throw new Error(`${row.file}: replaces lists ${kind} twice`);
      seen.add(kind);
    }
  }
  if (env === undefined && crds.some((row) => row.env !== "")) {
    throw new Error("cluster.toml declares CRDs for particular environments ([[inspect.crds]] env): say which environment this plan describes with --env");
  }
  // Every file is read, and must hold a CRD, whichever environment it is for:
  // a broken file is found in any run, not only in its environment's.
  const crdsOf = new Map(crds.map((row) => [row, rowCrds(row, read)]));
  const applicable = crds.filter((row) => row.env === "" || row.env === env);

  // ── The checkout's entries ───────────────────────────────────────────────
  const added = {};
  const entryFile = new Map();
  for (const { file, path } of mappings) {
    const types = readEntries(file, read(path));
    for (const [type, entry] of Object.entries(types)) {
      if (Object.hasOwn(HOLDING.types, type)) throw new Error(`${file}: cloister reads ${type} already, and a checkout may not replace an entry cloister ships`);
      if (Object.hasOwn(added, type)) throw new Error(`${file} and ${entryFile.get(type)} both describe ${type}`);
      added[type] = entry;
      entryFile.set(type, file);
    }
  }
  const merged = { ...HOLDING, types: { ...HOLDING.types, ...added } };
  // Every kind an entry reads, cloister's or the checkout's.
  const readKinds = new Set(Object.keys(merged.types).map((type) => objectKind(merged, type)?.kind).filter(Boolean));

  // ── Every definition of a kind, level by level ───────────────────────────
  // kind → { label, spec | row, replaced: label | null }
  const effective = new Map();
  for (const spec of SHIPPED_SPECS) for (const kind of Object.keys(spec.objects)) effective.set(kind, { label: shippedLabel(spec), spec, replaced: null });
  const projected = new Map(); // row → the kinds it serves that an entry reads, projected
  const servedBy = (row) => {
    const served = new Set();
    for (const crd of crdsOf.get(row)) {
      for (const { kind } of crdKinds(crd)) {
        if (served.has(kind)) throw new Error(`${row.file} defines ${kind} twice`);
        served.add(kind);
      }
    }
    return served;
  };
  const level = (rows, place) => {
    const defined = new Map(); // kind → row, at this level
    for (const row of rows) {
      const served = servedBy(row);
      const kinds = [...served].filter((kind) => readKinds.has(kind));
      if (kinds.length === 0) throw new Error(`${row.file} defines no kind an entry reads (it serves ${[...served].join(", ") || "none"})`);
      for (const kind of kinds) {
        if (defined.has(kind)) throw new Error(`${row.file} and ${defined.get(kind).file} both define ${kind}, ${place}`);
        defined.set(kind, row);
      }
      for (const kind of row.replaces) {
        if (!served.has(kind)) throw new Error(`${row.file} lists ${kind} in replaces, and does not define it`);
        if (!readKinds.has(kind)) throw new Error(`${row.file} lists ${kind} in replaces, and no entry reads ${kind}`);
        if (!effective.has(kind)) throw new Error(`${row.file} lists ${kind} in replaces, and nothing above it defines ${kind}: a replacement that replaces nothing is a mistake`);
      }
      projected.set(row, kinds);
    }
    for (const [kind, row] of defined) {
      const above = effective.get(kind);
      if (above && !row.replaces.includes(kind)) {
        throw new Error(`${row.file} defines ${kind}, which ${above.label} defines already: list it in replaces to check ${kind} against ${row.file} instead`);
      }
      effective.set(kind, { label: row.file, row, replaced: above?.label ?? null });
    }
  };
  level(applicable.filter((row) => row.from === "cluster.toml" && row.env === ""), "for every environment");
  if (env !== undefined) level(applicable.filter((row) => row.from === "cluster.toml" && row.env === env), `for ${env}`);
  for (const row of applicable.filter((r) => r.from !== "cluster.toml")) {
    for (const kind of [...servedBy(row)].filter((k) => readKinds.has(k))) {
      const above = effective.get(kind);
      if (above) throw new Error(`${row.file} defines ${kind}, which ${above.label} defines already. A file a flag adds may only add kinds`);
    }
    level([row], "");
  }

  // ── The schemas that apply, and every entry validated against them ───────
  const specs = [];
  for (const spec of SHIPPED_SPECS) {
    const kept = Object.fromEntries(Object.entries(spec.objects).filter(([kind]) => effective.get(kind)?.spec === spec));
    if (Object.keys(kept).length > 0) specs.push({ ...spec, objects: kept });
  }
  for (const [row, kinds] of projected) {
    const mine = kinds.filter((kind) => effective.get(kind)?.row === row);
    if (mine.length === 0) continue;
    const spec = projectObjectSpec([], {
      api: row.file,
      version: "checkout",
      crds: crdsOf.get(row),
      metadata: objectMetaDocument(KUBERNETES_OBJECT_META),
      metadataVersion: KUBERNETES_OBJECT_META.version,
    }, merged);
    specs.push({ ...spec, objects: Object.fromEntries(Object.entries(spec.objects).filter(([kind]) => mine.includes(kind))) });
  }
  try {
    validateMapping(merged, KUBERNETES_SPEC, specs);
  } catch (error) {
    throw new Error(`with the checkout's files, ${error.message}`);
  }
  deepFreeze(merged);

  // ── What checked each kind ───────────────────────────────────────────────
  const touched = new Set([...entryFile.keys()].map((type) => objectKind(merged, type).kind));
  for (const [kind, at] of effective) if (at.row) touched.add(kind);
  const kinds = [...touched].sort().map((kind) => {
    const at = effective.get(kind);
    const type = Object.keys(merged.types).find((t) => objectKind(merged, t)?.kind === kind);
    return { kind, schema: at.label, replaced: at.replaced ?? "", entry: entryFile.get(type) ?? "cloister" };
  });
  const files = [
    ...crds.map((row) => ({ file: row.file, holds: "crd", from: row.from, env: row.env, applies: applicable.includes(row) })),
    ...mappings.map((m) => ({ file: m.file, holds: "mapping", from: m.from, env: "", applies: true })),
  ];
  return {
    registry: makeRegistry([CLOUDFLARE_MAPPING, GOOGLE_MAPPING, merged]),
    checkout: deepFreeze({ files, kinds }),
  };
}

/** The CRDs in a row's file; a file with none is refused, since it checks nothing. */
function rowCrds(row, read) {
  const crds = readCrds(read(row.path));
  if (crds.length === 0) throw new Error(`${row.file} holds no CustomResourceDefinition`);
  return crds;
}

/**
 * A checkout mapping file's entries, with `like` and `podTemplate` resolved.
 * It holds entries only, each for a kind of object a resource holds whole:
 * which resources hold objects, and how their kind is read, are cloister's.
 */
function readEntries(file, text) {
  let mapping;
  try {
    mapping = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`);
  }
  if (!isTable(mapping)) throw new Error(`${file} must hold an object with "types"`);
  for (const key of Object.keys(mapping)) {
    if (key !== "types") {
      throw new Error(`${file} declares "${key}": a checkout mapping holds entries only ("types"). Which resources hold objects, and the provider, are cloister's`);
    }
  }
  if (!isTable(mapping.types) || Object.keys(mapping.types).length === 0) throw new Error(`${file} holds no entries under "types"`);
  for (const type of Object.keys(mapping.types)) {
    if (!objectKind(HOLDING, type)?.object) {
      throw new Error(`${file} describes ${JSON.stringify(type)}: a checkout entry reads an object a resource holds whole, named "<resource type> <apiVersion> <kind>" (for example "kubernetes_manifest example.com/v1 Widget")`);
    }
  }
  return expandPodTemplates(expandMapping(mapping).types, DEPLOYMENT);
}
