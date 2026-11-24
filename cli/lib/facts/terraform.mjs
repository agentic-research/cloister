// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reader for the documented `terraform show -json` / `tofu show -json`
// document (state or plan). Cloister runs neither tool: the operator renders
// the document and hands over the file (ADR-0070 §2, rendered output only).
//
// The raw `.tfstate` file is a different, undocumented format and is refused.

/** The only document major version this reader understands. */
export const SUPPORTED_FORMAT_MAJOR = 1;

/**
 * Validate the document and return its managed resources, flattened across
 * modules, each as `{address, type, name, provider, values, sensitive}`.
 *
 * A plan document is read from `planned_values`; a state document from
 * `values`. Data sources are skipped: they describe lookups, not resources
 * this configuration owns.
 */
export function readShowJson(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("the Terraform document is not a JSON object");
  }
  if (typeof document.format_version !== "string") {
    if ("lineage" in document || "serial" in document) {
      throw new Error(
        "this looks like a raw .tfstate file, which is not a documented format. " +
          "Render it first: `terraform show -json > state.json` (or `tofu show -json`)",
      );
    }
    throw new Error("the Terraform document has no format_version; expected `terraform show -json` output");
  }
  const major = Number.parseInt(document.format_version.split(".")[0], 10);
  if (major !== SUPPORTED_FORMAT_MAJOR) {
    throw new Error(
      `Terraform document format_version ${JSON.stringify(document.format_version)} is not supported ` +
        `(this reader understands major version ${SUPPORTED_FORMAT_MAJOR})`,
    );
  }
  const root = document.planned_values?.root_module ?? document.values?.root_module;
  const kind = document.planned_values ? "plan" : "state";
  const resources = [];
  if (root) collect(root, resources);
  return {
    kind,
    formatVersion: document.format_version,
    resources,
    references: document.configuration ? readReferences(document.configuration) : new Map(),
    expressions: document.configuration ? readExpressions(document.configuration) : new Map(),
  };
}

/** Root-module resource address → its configuration expressions, as written. */
function readExpressions(configuration) {
  const out = new Map();
  for (const resource of configuration.root_module?.resources ?? []) {
    if (typeof resource?.address === "string" && resource.expressions && typeof resource.expressions === "object") {
      out.set(resource.address, resource.expressions);
    }
  }
  return out;
}

const CONSTANTS = new Set(["string", "number", "boolean"]);

/**
 * What the configuration says about one field of a row: a constant written in
 * the source, or what the value is taken from. Never a planned value: this is
 * how a row is read when the provider marks the whole list sensitive because
 * one element of it is.
 *
 *   { constant }                  a literal in the configuration
 *   { references, unresolved }    managed resources it is taken from, and
 *                                 anything else it names (a variable, a local)
 */
function configuredField(expression) {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) return undefined;
  if (Object.hasOwn(expression, "constant_value")) {
    return CONSTANTS.has(typeof expression.constant_value) ? { constant: expression.constant_value } : undefined;
  }
  if (!Array.isArray(expression.references)) return undefined;
  return sourcesOf(expression.references);
}

/**
 * Sort what an expression names into managed resource addresses and
 * everything else: a variable, a local, a data source, or a name this reader
 * cannot classify. Total: every string named is an address kept, a path into
 * one (`google_x.y.uri` beside `google_x.y`, which that address stands for),
 * or "unresolved". Nothing named is dropped, so "names nothing" follows only
 * from an expression that names nothing.
 */
function sourcesOf(named) {
  const strings = (Array.isArray(named) ? named : []).filter((r) => typeof r === "string");
  const references = resourceReferences(strings);
  const within = (r) => references.some((a) => r === a || r.startsWith(`${a}.`) || r.startsWith(`${a}[`));
  return { references, unresolved: [...new Set(strings.filter((r) => !within(r)))].sort() };
}

/**
 * What one attribute's whole expression takes its value from: the managed
 * resources it references, and anything else it names (a variable, a local,
 * a data source). Both empty means the value is written in the source: its
 * literals, and files read from the module. Undefined when the configuration
 * has no expression for it, so nothing is known.
 */
export function expressionSources(expression) {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) return undefined;
  return sourcesOf(expression.references);
}

/**
 * The rows of the nested block list at `path` in a resource's configuration,
 * each reduced to the named `fields`. A field is a dotted path through single
 * nested blocks (`value_source.secret_key_ref.secret`).
 */
export function configuredRows(expressions, path, fields) {
  let level = [expressions];
  for (const segment of path.split(".")) {
    level = level.flatMap((node) => {
      const inner = node && typeof node === "object" && !Array.isArray(node) ? node[segment] : undefined;
      return Array.isArray(inner) ? inner : [];
    });
  }
  const rows = [];
  for (const node of level) {
    if (!node || typeof node !== "object") continue;
    const row = {};
    for (const field of fields) {
      let at = node;
      const segments = field.split(".");
      for (const segment of segments.slice(0, -1)) {
        const inner = at && typeof at === "object" && !Array.isArray(at) ? at[segment] : undefined;
        at = Array.isArray(inner) ? inner[0] : undefined;
      }
      const value = configuredField(at && typeof at === "object" ? at[segments.at(-1)] : undefined);
      if (value) row[field] = value;
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

/** Prefixes of a `references` entry that is not a managed resource. */
const NOT_A_RESOURCE = ["var.", "local.", "data.", "module.", "each.", "count.", "path.", "terraform."];
// Terraform's identifiers are Unicode identifiers, with `-` allowed after the first character.
const NAME_PART = /^[\p{ID_Start}_][\p{ID_Continue}-]*$/u;

/** Keep only entries that are exactly `<type>.<name>`: a managed resource address. */
export function resourceReferences(references) {
  const out = new Set();
  for (const entry of Array.isArray(references) ? references : []) {
    if (typeof entry !== "string" || NOT_A_RESOURCE.some((p) => entry.startsWith(p))) continue;
    const parts = entry.split(".");
    if (parts.length === 2 && parts.every((p) => NAME_PART.test(p))) out.add(entry);
  }
  return [...out].sort();
}

/**
 * Per managed resource address in the ROOT module: top-level attribute name ->
 * sorted resource addresses its expression references. Child modules are
 * skipped on purpose: their addresses are prefixed `module.<name>.` and their
 * expressions live under `module_calls`, so a reference there would not name
 * an address this reader imports with confidence.
 */
function readReferences(configuration) {
  const out = new Map();
  for (const resource of configuration.root_module?.resources ?? []) {
    // No mode check: a data source's address starts with `data.` and no fact has it.
    if (typeof resource?.address !== "string") continue;
    const byAttr = {};
    const sites = {};
    for (const [attr, expression] of Object.entries(resource.expressions ?? {})) {
      const found = deepReferences(expression, attr);
      const refs = resourceReferences(found.flatMap((site) => site.references));
      if (refs.length === 0) continue;
      byAttr[attr] = refs;
      // Where each one is written, for a reference inside a nested block.
      sites[attr] = found.flatMap((site) => resourceReferences(site.references).map((address) => ({ address, where: site.where })));
    }
    // Not enumerable: `byAttr` stays exactly the attr → addresses table it was.
    Object.defineProperty(byAttr, SITES, { value: sites });
    out.set(resource.address, byAttr);
  }
  return out;
}

/**
 * Every `references` entry under one top-level expression, with where it sits.
 *
 * A plain attribute's expression is `{ references: [...] }`. A nested block's
 * is a list of objects that hold more expressions (a Cloud Run service's
 * `template` holds `containers`, which hold `env`, whose `value` is the
 * expression that references another resource). All of them belong to the
 * top-level attribute they sit under.
 */
function deepReferences(expression, key, out = [], list = key) {
  if (Array.isArray(expression)) {
    // The rows of the list named `key`.
    for (const item of expression) deepReferences(item, key, out, key);
    return out;
  }
  if (!expression || typeof expression !== "object") return out;
  if (Array.isArray(expression.references)) {
    out.push({ references: expression.references, where: key });
    return out;
  }
  // A row that states its own name as a constant (`env { name = "X" }`) lends
  // it to the references in its other fields: "env X", never the value.
  const named = typeof expression.name?.constant_value === "string" ? `${list} ${expression.name.constant_value}` : null;
  for (const [inner, value] of Object.entries(expression)) {
    const before = out.length;
    deepReferences(value, inner, out, inner);
    if (named && value && typeof value === "object" && Array.isArray(value.references)) {
      for (const site of out.slice(before)) site.where = named;
    }
  }
  return out;
}

/** A resource's sensitivity markers: an object, or `true` when they are malformed (fail closed). */
function markersOf(markers) {
  if (markers === undefined) return {};
  return markers !== null && typeof markers === "object" && !Array.isArray(markers) ? markers : true;
}

/** The key under which a resource's reference table carries where each reference is written. */
export const SITES = Symbol("reference sites");

function collect(module, out) {
  for (const resource of module.resources ?? []) {
    if (resource?.mode !== "managed") continue;
    if (typeof resource.type !== "string" || typeof resource.address !== "string") continue;
    out.push({
      address: resource.address,
      type: resource.type,
      name: typeof resource.name === "string" ? resource.name : "",
      provider: typeof resource.provider_name === "string" ? resource.provider_name : "",
      values: resource.values && typeof resource.values === "object" ? resource.values : {},
      // No markers means nothing is marked. Markers that are not an object
      // are malformed, and mark the whole resource: nothing of it is read.
      sensitive: markersOf(resource.sensitive_values),
    });
  }
  for (const child of module.child_modules ?? []) collect(child, out);
}
