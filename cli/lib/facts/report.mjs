// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The inspect report: imported facts set beside cloister's declared graph
// (ADR-0073). It reads both and changes neither.
//
// Three kinds of finding, and what each one does NOT mean:
//   evidenced   a declared wire has a matching binding in the inputs.
//   unknown     a declared wire has none here. That is absence of evidence in
//               THESE inputs, not proof the edge is unenforced.
//   undeclared  the inputs bind one workload to another and cluster.toml
//               declares no such wire. It is reported. It is never adopted:
//               only a declaration grants (ADR-0070 §2).
//
// Every join here is exact equality on a mapped attribute. Nothing is matched
// by guessing at a resource's name.

import { checkableBundle, placementName, portsFor, secretBorne } from "../cluster/connections.mjs";
import { addressesIn } from "../cluster/manifest-addresses.mjs";
import { bindingTarget, isWorkloadBinding, mappedEntries, mappedType, resolveBinding, resolveRelations } from "./cloudflare.mjs";

const SCRIPT = "cloudflare_workers_script";
const WRANGLER = "wrangler_worker";
const WORKER = "cloudflare_worker";
const VERSION = "cloudflare_worker_version";

/**
 * The sections a mapping declares, built from data alone. No resource type,
 * role or provider is named in this file: a type with a `report` block is
 * listed under its section with the attributes it says to show, and a type
 * with an `access` block contributes rows ("who may do what") to the resource
 * its relation resolves to. Adding a type, or a cloud, is a mapping entry.
 *
 * Access rows are read from the document and are NOT authoritative: a row
 * elsewhere (another module, the console) is invisible here. So a resource
 * with no row for a label says "unknown", never "none".
 */
/** The host a resource's address attribute names, or null. */
function hostOf(value) {
  if (typeof value !== "string") return null;
  return addressesIn(value).find((a) => a.hostPosition)?.host ?? null;
}

/**
 * What a resource's own strings say it calls: the edges of the graph that
 * nobody declared and the document implies.
 *
 * Two sources, both exact, and the report says which:
 *
 * - `address`: a string the resource starts with (an env value, an argument)
 *   holds the host of another reported resource's address. In a state
 *   document the address is concrete, so this is the usual source there.
 * - `configuration`: in a PLAN, the address is often unknown until apply, but
 *   the configuration records that the value is taken from another resource.
 *
 * A host that is the address of two resources resolves to neither. Values are
 * never returned: only the target, and where the string was (an env var's
 * name, or "args").
 */
/**
 * The resource a named one stands for.
 *
 * Some resources are an address for something else. A Kubernetes Service is
 * dialled by name, and what answers is the workload whose pods its selector
 * matches. A mapping says so with `standsFor`: the selector map on this
 * resource, the label map on the candidates, and the attributes both must
 * agree on (the namespace).
 *
 * Exactly one candidate must match. None, or several, resolves to nothing:
 * an edge is never guessed. A resource with no `standsFor` is itself.
 */
function standsFor(fact, facts) {
  const rule = mappedType(fact.type)?.report?.standsFor;
  if (!rule) return fact;
  const selector = Object.entries(fact.attrs.maps?.[rule.selector] ?? {});
  if (selector.length === 0) return null;
  const matches = facts.filter((candidate) => {
    if (!rule.toTypes.includes(candidate.type)) return false;
    if (!rule.scope.every((attr) => candidate.attrs[attr] !== undefined && candidate.attrs[attr] === fact.attrs[attr])) return false;
    const labels = candidate.attrs.maps?.[rule.labels] ?? {};
    return selector.every(([key, value]) => Object.hasOwn(labels, key) && labels[key] === value);
  });
  return matches.length === 1 ? matches[0] : null;
}

/** A `hosts` template with each `{attribute}` filled in, or null if one is missing. */
function fillHost(template, fact) {
  let missing = false;
  const host = template.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = key === "name" ? fact.name : fact.attrs[key];
    if (typeof value !== "string" || value === "") { missing = true; return ""; }
    return value;
  });
  return missing ? null : host;
}

function dialsOf(fact, entry, facts, kind, addressed) {
  const out = [];
  const add = (named, by, where) => {
    // What was named may stand for the workload that answers there.
    const target = named ? standsFor(named, facts) : null;
    if (!target || target.address === fact.address) return;
    const existing = out.find((d) => d.address === target.address);
    // The value itself is better evidence than the reference it was built from.
    if (existing) { if (existing.by === "configuration" && by === "address") Object.assign(existing, { by, where }); return; }
    out.push({ address: target.address, to: target.name, section: mappedType(target.type)?.report?.section ?? "", by, where });
  };
  for (const dial of entry.report.dials ?? []) {
    for (const row of fact.attrs[dial.list] ?? []) {
      const strings = dial.strings ? (row[dial.strings] ?? []) : [row[dial.value]];
      const where = dial.label && typeof row[dial.label] === "string" ? `${dial.prefix} ${row[dial.label]}` : dial.prefix;
      for (const value of strings) {
        if (typeof value !== "string") continue;
        for (const { host } of addressesIn(value)) {
          const targets = addressed.get(host) ?? [];
          if (targets.length === 1) add(targets[0], "address", where);
        }
      }
    }
  }
  if (kind === "plan") {
    for (const attr of entry.report.references ?? []) {
      for (const address of fact.attrs.references?.[attr] ?? []) {
        const target = facts.find((f) => f.address === address);
        // Where in the block the reference is written, when the configuration says.
        const site = (fact.attrs.referenceSites?.[attr] ?? []).find((s) => s.address === address);
        if (target && mappedType(target.type)?.report) add(target, "configuration", site?.where ?? attr);
      }
    }
  }
  return out.map(({ address: _address, ...dial }) => dial);
}

/** A workload's own principal, as an access row would write it, or "". */
function principalOf(fact, rule) {
  if (!rule) return "";
  const value = fact.attrs[rule.attr];
  return typeof value === "string" && value !== "" ? rule.principal.replace("{}", value) : "";
}

/**
 * The bundle a workload would be drafted as: its placement kind, image and
 * ports, as the mapping says to read them. A port carries the app_protocol
 * label its wire maps to. A workload that declares no port is given the
 * provider's default when the mapping states one, and that is recorded, so a
 * draft can say the port was assumed and not read.
 */
function bundleOf(fact, rule, facts, withRun, addressed) {
  const image = rule.image ? (fact.attrs[rule.image.list] ?? []).map((row) => row[rule.image.value]).find((v) => typeof v === "string" && v !== "") ?? "" : "";
  const ports = [];
  if (rule.ports) {
    for (const row of fact.attrs[rule.ports.list] ?? []) {
      const port = row[rule.ports.port];
      if (!Number.isInteger(port)) continue;
      // An unnamed port is served the provider's default way.
      const wire = typeof row[rule.ports.name] === "string" && row[rule.ports.name] !== "" ? row[rule.ports.name] : rule.ports.default?.name ?? "";
      const appProtocol = Object.hasOwn(rule.wires ?? {}, wire) ? rule.wires[wire] : "";
      // Where a port's name is free text, a protocol read from it is a
      // convention, and the draft says it was not declared.
      ports.push({ name: wire, port, appProtocol, assumed: false, byConvention: rule.ports.byConvention === true && appProtocol !== "" });
    }
    if (ports.length === 0 && rule.ports.default) {
      const { name, port } = rule.ports.default;
      ports.push({ name, port, appProtocol: rule.wires[name], assumed: true });
    }
  }
  const strings = (ref) => (ref ? (fact.attrs[ref.list] ?? []).flatMap((row) => row[ref.strings] ?? []) : []);
  const bundle = { placement: rule.placement, runs: rule.runs ?? "service", image, ports, exposure: exposureOf(fact, rule.exposure) };
  // What it is started with is read only when a caller is going to write a
  // manifest from it. The report never carries it: an argument or an env value
  // may hold an address or worse, and the report is printed.
  if (withRun) {
    bundle.run = { args: strings(rule.args), command: strings(rule.command), env: envOf(fact, rule.env, facts, addressed) };
    // Read from the values, a list the document withholds is missing here.
    if (rule.env?.list !== undefined) bundle.run.envFromValues = true;
  }
  return bundle;
}

/**
 * Whether the inputs say the workload can be reached from outside its network.
 *
 * `expose` is "cluster" or "edge", the word a port's `expose` uses, when the
 * provider's setting is one the mapping sorts. It is "" when the setting is
 * not in the document, or holds a value the mapping does not list: that is
 * unknown, never a default. Null when the mapping names no such setting.
 */
function exposureOf(fact, rule) {
  if (!rule) return null;
  // With a key, the setting is one entry of a map the entry reads (a label).
  const value = rule.key === undefined ? fact.attrs[rule.attr] : fact.attrs.maps?.[rule.attr]?.[rule.key];
  const setting = typeof value === "string" ? value : "";
  const expose = rule.cluster.includes(setting) ? "cluster" : rule.edge.includes(setting) ? "edge" : "";
  return { attr: rule.key === undefined ? rule.attr : `${rule.attr}["${rule.key}"]`, setting, expose };
}

/**
 * Each environment variable the configuration declares, sorted into what can
 * be carried to another placement and what cannot (ADR-0074 §5.3):
 *
 *   constant   a literal in the configuration. Carried as written.
 *   workload   taken from another workload: an address, which is different in
 *              every placement and is what lowering rewrites.
 *   secret     a reference to a named secret. The reference is carried; the
 *              value is never in the document.
 *   unknown    taken from something this document does not resolve (a
 *              variable, a resource that is not a workload). Named, not guessed.
 *
 * Null when the mapping does not say where env is configured, or the document
 * is not a plan: there is then nothing to sort.
 */
/**
 * The workload a literal value is the address of, and what follows the
 * address, when the WHOLE value is one URL whose host is the address of
 * exactly one workload. Anything else is not an address this can carry.
 */
function addressedBy(value, fact, facts, addressed) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const targets = addressed.get(url.hostname) ?? [];
  if (targets.length !== 1) return null;
  const target = standsFor(targets[0], facts);
  if (!target || target.address === fact.address || !mappedType(target.type)?.report?.bundle) return null;
  if (url.username || url.password) return null;
  const path = `${url.pathname === "/" && !value.endsWith("/") ? "" : url.pathname}${url.search}`;
  return { target, path };
}

function envOf(fact, rule, facts, addressed = new Map()) {
  if (rule?.list !== undefined) return valueEnvOf(fact, rule, facts, addressed);
  const rows = rule ? fact.attrs.configured?.[rule.configured] : undefined;
  if (!rows) return null;
  const out = [];
  for (const row of rows) {
    const name = row[rule.name]?.constant;
    if (typeof name !== "string" || name === "") continue;
    const secret = rule.secret ? row[rule.secret]?.constant : undefined;
    const value = row[rule.value];
    if (typeof secret === "string" && secret !== "") {
      const version = rule.secretVersion ? row[rule.secretVersion]?.constant : undefined;
      out.push({ name, kind: "secret", secret, version: typeof version === "string" ? version : "" });
    } else if (value && Object.hasOwn(value, "constant")) {
      // Where an address is known when the plan is made (a cluster DNS name),
      // it is written as a literal. It is still an address: different in
      // every placement, so it is carried as a binding and not as text.
      const dialled = addressedBy(String(value.constant), fact, facts, addressed);
      if (dialled) out.push({ name, kind: "workload", to: dialled.target.name, section: mappedType(dialled.target.type).report.section, path: dialled.path });
      else out.push({ name, kind: "constant", value: String(value.constant) });
    } else if (value) {
      const targets = value.references.map((address) => facts.find((f) => f.address === address)).map((f) => (f ? standsFor(f, facts) : f));
      const workloads = targets.filter((f) => f && mappedType(f.type)?.report?.bundle);
      if (workloads.length === 1 && targets.length === 1 && value.unresolved.length === 0) {
        out.push({ name, kind: "workload", to: workloads[0].name, section: mappedType(workloads[0].type).report.section });
      } else {
        out.push({ name, kind: "unknown", from: [...value.references, ...value.unresolved] });
      }
    } else {
      out.push({ name, kind: "unknown", from: [] });
    }
  }
  return out;
}

/**
 * Env rows read from the values, where the configuration has no rows to read:
 * an object held whole is one expression (ADR-0073, amendment of 2026-11-23).
 *
 * A value here is what the document says will be applied. The configuration
 * says what the object's expression takes from, but not which value took
 * what. So a value is drafted as a constant only when the expression takes
 * from nothing: every value in the object is then the source's own text.
 * Otherwise, or when the document has no configuration for it (a state, a
 * child module), the value is unknown, named with everything the expression
 * takes from. A secret reference names a Secret, and a value that is one
 * workload's whole address is that address: each is what it is, wherever
 * the value came from.
 */
function valueEnvOf(fact, rule, facts, addressed) {
  const rows = fact.attrs[rule.list];
  if (!Array.isArray(rows)) return null;
  const takenFrom = fact.attrs.takenFrom;
  const asWritten = takenFrom !== undefined && takenFrom.references.length === 0 && takenFrom.unresolved.length === 0;
  const from = takenFrom ? [...takenFrom.references, ...takenFrom.unresolved] : [];
  const out = [];
  for (const row of rows) {
    const name = row[rule.name];
    if (typeof name !== "string" || name === "") continue;
    const secret = rule.secret ? row[rule.secret] : undefined;
    const value = row[rule.value];
    if (typeof secret === "string" && secret !== "") {
      const version = rule.secretVersion ? row[rule.secretVersion] : undefined;
      out.push({ name, kind: "secret", secret, version: typeof version === "string" ? version : "" });
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const dialled = addressedBy(String(value), fact, facts, addressed);
      if (dialled) {
        out.push({ name, kind: "workload", to: dialled.target.name, section: mappedType(dialled.target.type).report.section, path: dialled.path });
        continue;
      }
      if (asWritten) {
        out.push({ name, kind: "constant", value: String(value) });
        continue;
      }
      // There is a value, and where it came from is not written down.
      out.push({ name, kind: "unknown", from, inObject: true });
      continue;
    }
    out.push({ name, kind: "unknown", from: [] });
  }
  return out;
}

/** The report's declared sections. Exported for the draft, which reads the same resources. */
export const sectionsOf = (facts, kind, options) => declaredSections(facts, kind, options);

function declaredSections(facts, kind, { withRun = false } = {}) {
  const byType = (type) => facts.filter((f) => f.type === type);
  const entries = mappedEntries();
  const sections = new Map();
  // host → the resources reached there, for every type that declares an address.
  const addressed = new Map();
  for (const [type, entry] of entries) {
    if (!entry.report?.address && !entry.report?.hosts) continue;
    for (const fact of byType(type)) {
      const hosts = [];
      if (entry.report.address) hosts.push(hostOf(fact.attrs[entry.report.address]));
      // Names a resource answers to that are built, not stored: a cluster
      // DNS name is made of a Service's name and namespace.
      for (const template of entry.report.hosts ?? []) hosts.push(fillHost(template, fact));
      for (const host of new Set(hosts.filter(Boolean))) addressed.set(host, [...(addressed.get(host) ?? []), fact]);
    }
  }
  for (const [type, entry] of entries) {
    if (!entry.report) continue;
    const accessTypes = entries.filter(([, e]) => e.access && (e.relations ?? []).some((r) => r.toType === type));
    const labels = [...new Set(accessTypes.flatMap(([, e]) => Object.values(e.access.roles)))];
    const resources = byType(type).map((fact) => {
      const access = [];
      for (const [accessType, { access: rule }] of accessTypes) {
        for (const row of byType(accessType)) {
          const role = row.attrs[rule.role];
          const principal = row.attrs[rule.principal];
          // Own property only: the role comes from the document.
          if (typeof role !== "string" || !Object.hasOwn(rule.roles, role) || !principal) continue;
          if (!resolveRelations(row, facts, kind).some((r) => r.to?.address === fact.address)) continue;
          const label = rule.roles[role];
          if (access.some((a) => a.label === label && a.principal === principal)) continue;
          access.push({ label, principal, public: (rule.publicPrincipals ?? []).includes(principal) });
        }
      }
      return {
        name: fact.name,
        attrs: Object.fromEntries(entry.report.show.map((attr) => [attr, fact.attrs[attr] ?? ""])),
        access,
        dials: dialsOf(fact, entry, facts, kind, addressed),
        // A type that declares what it dials is a workload: it can be the
        // source of a connection.
        dialer: Boolean(entry.report.dials),
        // Who it runs as, in the form an access row names a principal, when
        // the mapping says where that is and the document states it.
        identity: principalOf(fact, entry.report.bundle?.identity),
        // What a bundle drafted from this resource would hold (ADR-0074 §3),
        // for a type whose mapping says it is a workload.
        bundle: entry.report.bundle ? bundleOf(fact, entry.report.bundle, facts, withRun, addressed) : null,
        // A list the document marks sensitive is not read. Say so: "no edge
        // found" would otherwise read as "no edge".
        withheld: (entry.lists ?? []).map((list) => list.path.split(".").pop()).filter((key) => fact.attrs[`${key}Withheld`] === true),
      };
    });
    if (resources.length === 0) continue;
    const title = entry.report.section;
    const section = sections.get(title) ?? { title, accessLabels: [], resources: [] };
    for (const label of labels) if (!section.accessLabels.includes(label)) section.accessLabels.push(label);
    section.resources.push(...resources.map((r) => ({ ...r, accessLabels: labels })));
    sections.set(title, section);
  }
  return [...sections.values()];
}

/** A route pattern's host: the text before the first "/". Null when it holds a wildcard. */
function routeHost(pattern) {
  const host = pattern.split("/")[0];
  return host === "" || host.includes("*") ? null : host;
}

/**
 * Declared connections beside the edges the inputs imply.
 *
 * A bundle and a resource are the same thing when they have the same name,
 * exactly. Nothing else joins them. Three findings, with the same meanings
 * the wire findings have:
 *
 *   evidenced   a declared connection's source is started with something that
 *               names its target.
 *   unknown     no such thing was found in THESE inputs. That is absence of
 *               evidence: the address may come from a secret, or a file.
 *   undeclared  a declared bundle dials something, and cluster.toml declares
 *               no connection for it. Reported, never adopted.
 *
 * A port's `expose` is compared the same way with what the inputs say about
 * reaching the workload from outside its network, where a mapping names that
 * setting: evidenced, unknown, or `contradicted` when the two disagree.
 *
 * `unlisted` is the workloads in the inputs that cluster.toml has no bundle
 * for: with a hand-written cluster.toml, the services nobody added.
 */
function compareConnections(sections, cluster, env) {
  // A resource is matched to a bundle by name (ADR-0074 §4). With --env, the
  // name is the one the bundle goes by in that environment: its placement
  // row's `name`, when it has one. Everything below then speaks in bundle
  // names, so a resource called `orders-api-prod` is the bundle `orders`.
  const called = new Map();
  const renamed = [];
  for (const b of cluster?.bundles ?? []) {
    const checkable = checkableBundle(b);
    if (env !== undefined) {
      const name = placementName(checkable, env);
      if (name !== null && name !== b.name) called.set(name, b.name);
    } else if ((checkable.placements ?? []).some((p) => (p.name ?? "") !== "")) {
      renamed.push(b.name);
    }
  }
  const bundleNameOf = (name) => (called.has(name) ? called.get(name) : name);
  const resources = sections.flatMap((s) => s.resources.map((r) => ({
    ...r,
    name: bundleNameOf(r.name),
    dials: (r.dials ?? []).map((d) => ({ ...d, to: bundleNameOf(d.to) })),
    section: s.title,
  })));
  const named = (name) => resources.filter((r) => r.name === name);
  const bundles = new Set((cluster?.bundles ?? []).map((b) => b.name));
  const declared = [];
  for (const c of cluster?.connections ?? []) {
    for (const t of c.targets ?? []) {
      if (env === undefined || t.env === env) declared.push({ from: c.from, name: c.name, to: t.bundle, env: t.env });
    }
  }
  const inSecret = secretBorne(cluster?.bundles);
  const findings = [];
  // Without --env there is no one environment to take a name from.
  if (renamed.length) {
    findings.push({
      kind: "unknown",
      unchecked: true,
      reason: `${renamed.map((n) => `"${n}"`).join(", ")} ${renamed.length === 1 ? "goes" : "go"} by another name in some environment; pass --env <name> so resources are matched by it`,
    });
  }
  for (const connection of declared) {
    const sources = named(connection.from).filter((r) => r.dialer);
    const missing = sources.length === 0 ? connection.from : named(connection.to).length === 0 ? connection.to : null;
    if (missing) {
      findings.push({ kind: "unknown", connection, reason: `no resource named "${missing}" in these inputs` });
      continue;
    }
    if (sources.length > 1) {
      findings.push({ kind: "unknown", connection, reason: `more than one resource named "${connection.from}" in these inputs (${sources.map((r) => r.section).join(", ")})` });
      continue;
    }
    const [source] = sources;
    const dial = source.dials.find((d) => d.to === connection.to);
    if (dial) {
      findings.push({ kind: "evidenced", connection, dial: { section: dial.section, by: dial.by, where: dial.where } });
    } else {
      const withheld = source.withheld.length ? `; its ${source.withheld.join(" and ")} ${source.withheld.length === 1 ? "is" : "are"} marked sensitive and ${source.withheld.length === 1 ? "was" : "were"} not read` : "";
      const declaredIn = inSecret.get(`${connection.from}\u0000${connection.name}`);
      if (declaredIn) {
        // Still unknown: nothing was observed. But the operator has said
        // where the address is, and that is why nothing could be.
        findings.push({ kind: "unknown", connection, declaredIn, reason: `cluster.toml says its address is in secret "${declaredIn.secret}" (env ${declaredIn.env}). A secret's value is never read, so this edge is declared, not observed` });
      } else {
        findings.push({ kind: "unknown", connection, reason: `nothing "${connection.from}" is started with names "${connection.to}" in these inputs${withheld}` });
      }
    }
  }
  for (const resource of resources) {
    if (!resource.dialer || !bundles.has(resource.name)) continue;
    for (const dial of resource.dials) {
      if (declared.some((c) => c.from === resource.name && c.to === dial.to)) continue;
      findings.push({
        kind: "undeclared",
        from: resource.name,
        dial: { to: dial.to, section: dial.section, by: dial.by, where: dial.where },
        reason: bundles.has(dial.to) ? "declares no such connection" : `has no bundle named "${dial.to}"`,
      });
    }
  }
  // Who the inputs let CALL each target, beside the declared connections.
  // An access row is the provider's own enforcement of an edge: it names a
  // principal, and a workload's principal is who it runs as.
  //
  // What a document can show is who IS granted. It cannot show that nobody
  // else is: a grant may be made in another module, at a wider scope, or by
  // hand. So a row is evidence for an edge, a public row contradicts a
  // private one, and the absence of a row is unknown, never "refused".
  for (const target of resources) {
    if (!bundles.has(target.name)) continue;
    for (const label of target.accessLabels ?? []) {
      const rows = (target.access ?? []).filter((a) => a.label === label);
      const callers = declared.filter((c) => c.to === target.name);
      const open = rows.filter((a) => a.public);
      for (const connection of callers) {
        const access = { from: connection.from, to: connection.to, name: connection.name, env: connection.env, label };
        const sources = named(connection.from);
        const identity = sources.length === 1 ? sources[0].identity : "";
        if (open.length) {
          findings.push({ kind: "contradicted", access, reason: `${label} is granted to ${open.map((a) => a.principal).join(", ")}, so it is not only "${connection.from}" that may call it` });
        } else if (identity !== "" && rows.some((a) => a.principal === identity)) {
          findings.push({ kind: "evidenced", access, principal: identity });
        } else if (identity === "") {
          findings.push({ kind: "unknown", access, reason: `these inputs do not state who "${connection.from}" runs as` });
        } else {
          findings.push({ kind: "unknown", access, reason: `no ${label} row in these inputs names ${identity}; a row made elsewhere is not visible here` });
        }
      }
      // A row for a workload that declares no connection to this target.
      for (const row of rows.filter((a) => !a.public)) {
        const holder = resources.filter((r) => r.identity === row.principal);
        if (holder.length !== 1 || holder[0].name === target.name) continue;
        if (callers.some((c) => c.from === holder[0].name)) continue;
        findings.push({ kind: "undeclared", access: { from: holder[0].name, to: target.name, label }, reason: bundles.has(holder[0].name) ? "declares no such connection" : `has no bundle named "${holder[0].name}"` });
      }
    }
  }
  // A port's `expose` beside what the inputs say about reaching the workload
  // from outside. Same name, same thing; same three-way answer.
  for (const b of cluster?.bundles ?? []) {
    const same = named(b.name).filter((r) => r.bundle?.exposure);
    if (same.length !== 1) continue;
    const { attr, setting, expose } = same[0].bundle.exposure;
    // With --env, the port as that environment's placement declares it.
    const ports = env === undefined ? b.ports ?? [] : portsFor(checkableBundle(b), env);
    for (const port of ports.filter((p) => p.expose === "cluster" || p.expose === "edge")) {
      const exposure = { bundle: b.name, port: port.name, expose: port.expose, section: same[0].section };
      if (expose === "") {
        findings.push({ kind: "unknown", exposure, reason: setting === "" ? `these inputs do not state its ${attr}` : `its ${attr} is ${setting}, which the mapping does not sort` });
      } else if (expose === port.expose) {
        findings.push({ kind: "evidenced", exposure, setting: `${attr} ${setting}` });
      } else {
        findings.push({
          kind: "contradicted",
          exposure,
          reason: expose === "edge"
            ? `its ${attr} is ${setting}, so it can be reached from outside`
            : `its ${attr} is ${setting}, so it cannot be reached from outside`,
        });
      }
    }
  }
  const unlisted = cluster ? resources.filter((r) => r.dialer && !bundles.has(r.name)).map((r) => ({ name: r.name, section: r.section })) : [];
  return { declared, findings, unlisted };
}

/** How a dialled edge was found, in words. */
const dialHow = (dial) => (dial.by === "address" ? dial.where : `referenced by configuration in ${dial.where}`);

export function buildReport({ facts, skipped, kind, formatVersion }, cluster, { env } = {}) {
  const byType = (type) => facts.filter((f) => f.type === type);

  // Workers: Terraform scripts, Terraform Workers with their versions, and
  // wrangler configs. One name is listed once. A cloudflare_worker and the
  // version whose worker_id resolves to it are ONE workload.
  const workerMap = new Map();
  const versionsOf = (worker) =>
    byType(VERSION).filter((v) => resolveRelations(v, facts, kind)[0]?.to?.address === worker.address);
  for (const fact of [...byType(SCRIPT), ...byType(WORKER), ...byType(WRANGLER)]) {
    const w = workerMap.get(fact.name) ?? { name: fact.name, terraform: false, wrangler: false, bindings: [], seen: new Set(), withheld: false, references: new Set() };
    const isTf = fact.type !== WRANGLER;
    w[isTf ? "terraform" : "wrangler"] = true;
    for (const part of fact.type === WORKER ? [fact, ...versionsOf(fact)] : [fact]) {
      if (isTf && part.attrs.bindingsWithheld) w.withheld = true;
      for (const address of part.attrs.references?.bindings ?? []) w.references.add(address);
      for (const b of part.attrs.bindings ?? []) {
        if (w.seen.has(b.name)) continue;
        w.seen.add(b.name);
        w.bindings.push(b);
      }
    }
    workerMap.set(fact.name, w);
  }
  const workers = [...workerMap.values()].map(({ seen: _seen, ...w }) => ({ ...w, withheld: w.withheld && !w.wrangler }));

  // Observation only: what the configuration wires into a Worker's bindings
  // beyond the targets its bindings already resolve to. No wire, no finding.
  const referencedByConfiguration = workers.flatMap((w) => {
    const resolved = new Set(w.bindings.map((b) => resolveBinding(b, facts).to?.address).filter(Boolean));
    return [...w.references].sort().filter((address) => !resolved.has(address)).map((address) => {
      const [type, tfName] = address.split(".");
      const target = facts.find((f) => f.address === address);
      return { workload: w.name, type, name: target?.name || tfName };
    });
  });

  const bundles = cluster?.bundles ?? [];
  const wires = cluster?.wires ?? [];
  const bundleOfScript = (scriptName) =>
    bundles.find((b) => b.workerdServiceName === scriptName || b.name === scriptName);
  const scriptOfBundle = (bundleName) => {
    const bundle = bundles.find((b) => b.name === bundleName);
    if (!bundle) return undefined;
    return workers.find((s) => s.name === bundle.workerdServiceName || s.name === bundle.name);
  };

  const workloads = workers.map((worker) => ({
    name: worker.name,
    bundle: bundleOfScript(worker.name)?.name ?? "",
    source: worker.terraform && worker.wrangler ? "both" : worker.wrangler ? "wrangler" : "terraform",
    bindingsWithheld: worker.withheld,
    bindings: worker.bindings.map((b) => ({
      name: b.name,
      type: b.type,
      target: describeTarget(b, facts),
      workload: isWorkloadBinding(b),
    })),
  }));

  const findings = [];
  if (workers.length === 0 && wires.length > 0) {
    findings.push({
      kind: "unknown",
      unchecked: wires.length,
      reason: `no Worker in these inputs; ${wires.length} declared wires could not be checked (pass --wrangler <file>)`,
    });
  } else {
    for (const wire of wires) {
      const script = scriptOfBundle(wire.from);
      if (!script) {
        findings.push({ kind: "unknown", wire, reason: `no Worker for bundle "${wire.from}" in these inputs` });
        continue;
      }
      if (script.withheld) {
        findings.push({ kind: "unknown", wire, reason: `"${script.name}"'s bindings are marked sensitive and were not read` });
        continue;
      }
      const binding = script.bindings.find((b) => b.name === wire.binding);
      if (binding) {
        findings.push({ kind: "evidenced", wire, binding: { type: binding.type, target: describeTarget(binding, facts) } });
      } else {
        findings.push({ kind: "unknown", wire, reason: `"${script.name}" has no binding named ${wire.binding} in these inputs` });
      }
    }
  }
  for (const script of workers) {
    const bundle = bundleOfScript(script.name);
    if (!bundle) continue;
    const declared = new Set(wires.filter((w) => w.from === bundle.name).map((w) => w.binding));
    for (const binding of script.bindings) {
      if (!isWorkloadBinding(binding) || declared.has(binding.name)) continue;
      findings.push({
        kind: "undeclared",
        from: bundle.name,
        binding: { name: binding.name, type: binding.type, target: bindingTarget(binding) },
      });
    }
  }

  const sections = declaredSections(facts, kind);
  const connections = compareConnections(sections, cluster, env);

  const workerNames = new Set(workers.map((w) => w.name));
  const routes = byType("cloudflare_workers_route").map((f) => {
    const script = f.attrs.script ?? "";
    return { pattern: f.attrs.pattern ?? "", script, resolved: script === "" || workerNames.has(script) };
  });

  // Request paths: a route and a tunnel ingress rule that name the same host, by exact string equality.
  const requestPaths = [];
  for (const config of byType("cloudflare_zero_trust_tunnel_cloudflared_config")) {
    const [tunnelRelation] = resolveRelations(config, facts, kind);
    const tunnel = tunnelRelation?.to?.name || "(unnamed)";
    for (const rule of config.attrs.ingress ?? []) {
      if (!rule.hostname) continue;
      for (const route of routes) {
        if (routeHost(route.pattern) !== rule.hostname) continue;
        requestPaths.push({ host: rule.hostname, script: route.script || "(no script)", tunnel, service: rule.service ?? "(not stated)" });
      }
    }
  }

  return {
    document: { kind: kind ?? null, formatVersion: formatVersion ?? null },
    workloads,
    referencedByConfiguration,
    routes,
    requestPaths,
    tunnels: byType("cloudflare_zero_trust_tunnel_cloudflared").map((f) => f.name),
    ingress: byType("cloudflare_zero_trust_tunnel_cloudflared_config").flatMap((f) => f.attrs.ingress),
    privateServices: byType("cloudflare_connectivity_directory_service").map((f) => ({
      name: f.name,
      type: f.attrs.type ?? "",
      httpPort: f.attrs.http_port ?? null,
      httpsPort: f.attrs.https_port ?? null,
    })),
    access: byType("cloudflare_zero_trust_access_application").map((f) => ({
      name: f.name, domain: f.attrs.domain ?? "", type: f.attrs.type ?? "", policies: f.attrs.policies,
    })),
    storage: [
      ...byType("cloudflare_workers_kv_namespace").map((f) => ({ kind: "kv", name: f.name })),
      ...byType("cloudflare_d1_database").map((f) => ({ kind: "d1", name: f.name })),
      ...byType("cloudflare_r2_bucket").map((f) => ({ kind: "r2", name: f.name })),
    ],
    sections,
    dns: byType("cloudflare_dns_record").map((f) => ({ name: f.name, type: f.attrs.type ?? "", proxied: f.attrs.proxied === true })),
    declared: wires.map((w) => ({ from: w.from, to: w.to, binding: w.binding })),
    declaredConnections: connections.declared,
    unlisted: connections.unlisted,
    findings: [...findings, ...connections.findings],
    skipped,
  };
}

/** A binding's target by NAME where the mapping's relations resolve one; never a raw id. */
function describeTarget(binding, facts) {
  if (isWorkloadBinding(binding)) {
    const name = bindingTarget(binding);
    // A Durable Object binding with no script named is a class in the SAME
    // Worker: that is what an omitted `script_name` means in both the
    // provider's and wrangler's schema.
    if (!name) return binding.type === "durable_object_namespace" ? `(this Worker${binding.class_name ? `, class ${binding.class_name}` : ""})` : "(not stated)";
    return resolveBinding(binding, facts).to ? name : `${name} (not in this document)`;
  }
  if (binding.type === "kv_namespace" || binding.type === "d1") {
    const { to } = resolveBinding(binding, facts);
    if (to) return to.name;
    return binding.type === "kv_namespace" ? "(a KV namespace not in this document)" : "(a D1 database not in this document)";
  }
  if (binding.type === "r2_bucket") return resolveBinding(binding, facts).to?.name ?? binding.bucket_name ?? "(not stated)";
  if (binding.type === "queue") return binding.queue_name ?? "(not stated)";
  return "";
}

export function renderReport(report) {
  const lines = [];
  const section = (title) => { lines.push("", title); };
  const { kind, formatVersion } = report.document;
  lines.push(
    (kind ? `Terraform ${kind} document (format ${formatVersion}). ` : "No Terraform document given. ") +
      "Read-only: nothing was run or written.",
  );

  section("Discovered workloads:");
  if (report.workloads.length === 0) lines.push("  (none)");
  for (const w of report.workloads) {
    const where = w.source === "both" ? "  (in both)" : w.source === "wrangler" ? "  (wrangler)" : "";
    lines.push(`  ${w.name}  Worker${where}${w.bundle ? `  → bundle "${w.bundle}"` : "  (not in cluster.toml)"}`);
    if (w.bindingsWithheld) lines.push("    bindings: marked sensitive, not read");
    for (const b of w.bindings) lines.push(`    ${b.name}  ${b.type}${b.target ? `  → ${b.target}` : ""}`);
  }
  const list = (title, rows) => { if (rows.length) { section(title); for (const r of rows) lines.push(`  ${r}`); } };
  list("Referenced by configuration:", report.referencedByConfiguration.map((r) =>
    `${r.workload}: bindings reference ${r.type} ${r.name}`));
  list("Routes:", report.routes.map((r) =>
    `${r.pattern}  → ${r.script ? (r.resolved ? r.script : `${r.script} (not in this document)`) : "(no script)"}`));
  list("Request paths:", report.requestPaths.map((p) =>
    `${p.host}: route → ${p.script}; tunnel ${p.tunnel} → ${p.service}`));
  list("Tunnels:", report.tunnels);
  list("Tunnel ingress:", report.ingress.map((r) => `${r.hostname ?? "(catch-all)"}${r.path ? r.path : ""}  → ${r.service ?? "(not stated)"}`));
  list("Private services:", report.privateServices.map((s) => {
    const ports = [s.httpPort != null && `http ${s.httpPort}`, s.httpsPort != null && `https ${s.httpsPort}`].filter(Boolean).join(", ");
    return `${s.name}  ${s.type || "type not stated"}${ports ? `  (${ports})` : ""}`;
  }));
  list("Access applications:", report.access.map((a) => `${a.name}  ${a.domain}  (${a.type || "type not stated"}; ${a.policies.length} polic${a.policies.length === 1 ? "y" : "ies"})`));
  list("Storage:", report.storage.map((s) => `${s.kind}  ${s.name}`));
  for (const declared of report.sections) {
    section(`${declared.title}:`);
    for (const r of declared.resources) {
      lines.push(`  ${[r.name, ...Object.values(r.attrs)].filter((v) => v !== "").join("  ")}`);
      for (const a of r.access) lines.push(`    ${a.label}: ${a.principal}${a.public ? "  (public)" : ""}`);
      for (const key of r.withheld) lines.push(`    ${key}: withheld (the document marks it sensitive, so it was not read)`);
      for (const d of r.dials) lines.push(`    dials: ${d.to}  (${[d.section, dialHow(d)].filter(Boolean).join("; ")})`);
      for (const label of r.accessLabels) {
        if (!r.access.some((a) => a.label === label)) lines.push(`    ${label}: unknown (no access row in this document; access rows are non-authoritative)`);
      }
    }
  }
  list("DNS names:", report.dns.map((d) => `${d.name}  ${d.type}${d.proxied ? "  proxied" : ""}`));

  section("Declared wires (cluster.toml):");
  if (report.declared.length === 0) lines.push("  (none, or no cluster.toml given)");
  for (const d of report.declared) lines.push(`  ${d.from} → ${d.to}  as ${d.binding}`);

  if (report.declaredConnections.length) {
    section("Declared connections (cluster.toml):");
    for (const c of report.declaredConnections) lines.push(`  ${c.from} → ${c.to}  as ${c.name}  (env ${c.env})`);
  }
  if (report.unlisted.length) {
    section("In these inputs, with no bundle in cluster.toml:");
    for (const r of report.unlisted) lines.push(`  ${r.name}  (${r.section})`);
  }

  section("Findings:");
  if (report.findings.length === 0) lines.push("  (none)");
  for (const f of report.findings) {
    if (f.access) {
      const edge = `${f.access.from} → ${f.access.to} (${f.access.label})`;
      if (f.kind === "evidenced") lines.push(`  evidenced   ${edge}: granted to ${f.principal}`);
      else if (f.kind === "undeclared") lines.push(`  undeclared  ${edge}: the inputs grant it, and cluster.toml ${f.reason}`);
      else lines.push(`  ${f.kind.padEnd(11)} ${edge}: ${f.reason}`);
    } else if (f.exposure) {
      const what = `${f.exposure.bundle} port "${f.exposure.port}" expose = "${f.exposure.expose}"`;
      lines.push(f.kind === "evidenced" ? `  evidenced   ${what}: ${f.setting}` : `  ${f.kind.padEnd(11)} ${what}: ${f.reason}`);
    } else if (f.connection) {
      const edge = `${f.connection.from} → ${f.connection.to} (connection "${f.connection.name}", env ${f.connection.env})`;
      lines.push(f.kind === "evidenced" ? `  evidenced   ${edge}: ${dialHow(f.dial)}` : `  unknown     ${edge}: ${f.reason}`);
    } else if (f.kind === "undeclared" && f.dial) {
      lines.push(`  undeclared  ${f.from} dials ${f.dial.to} (${[f.dial.section, dialHow(f.dial)].filter(Boolean).join("; ")}), and cluster.toml ${f.reason}`);
    } else if (f.kind === "evidenced") {
      lines.push(`  evidenced   ${f.wire.from} → ${f.wire.to} (${f.wire.binding}): bound as ${f.binding.type}${f.binding.target ? ` → ${f.binding.target}` : ""}`);
    } else if (f.kind === "unknown" && f.unchecked) {
      lines.push(`  unknown: ${f.reason}`);
    } else if (f.kind === "unknown") {
      lines.push(`  unknown     ${f.wire.from} → ${f.wire.to} (${f.wire.binding}): ${f.reason}`);
    } else {
      lines.push(`  undeclared  ${f.from} binds ${f.binding.name} (${f.binding.type}${f.binding.target ? ` → ${f.binding.target}` : ""}), and cluster.toml declares no such wire`);
    }
  }
  lines.push(
    "",
    "A finding changes nothing. Discovered resources are facts, not grants: only a",
    "declaration in cluster.toml authorizes an edge (ADR-0073).",
  );
  const skipped = Object.entries(report.skipped).sort(([a], [b]) => a.localeCompare(b));
  if (skipped.length) {
    lines.push("", "Not read (no mapping for these resource types):");
    for (const [type, count] of skipped) lines.push(`  ${count}  ${type}`);
  }
  return lines.join("\n");
}
