// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister inspect --json`: the report, as manifest/cli.capnp declares it
// (InspectReport, ADR-0077).
//
// buildReport (report.mjs) builds what the text report and `--draft` need,
// and that is free to change. This is the public projection of it, chosen
// field by field, the way Terraform's JSON output is a projection of its
// state rather than its internals: nothing passes through from a provider's
// document unchosen, and nothing internal (a resource's draft, whether it
// dials) leaks out. cli/lib/output-format.mjs then checks the result against
// the generated schema before it is printed, so a field this file forgets,
// or adds, fails there rather than reaching a consumer.

/** A finding as the declaration has it: its kind, what it is about, and what it rests on. */
export function declaredFinding(f) {
  const kind = f.kind;
  if (f.unchecked !== undefined) return { kind, subject: { unchecked: null }, basis: { reason: f.reason } };
  if (f.wire) {
    const { from, to, binding } = f.wire;
    return { kind, subject: { wire: { from, to, binding } }, basis: f.binding ? { boundAs: { type: f.binding.type, target: f.binding.target ?? "" } } : { reason: f.reason } };
  }
  if (f.connection) {
    const { from, to, name, env } = f.connection;
    const basis = f.dial
      ? { dial: { section: f.dial.section, by: f.dial.by, where: f.dial.where } }
      : f.declaredIn
        ? { secret: { secret: f.declaredIn.secret, variable: f.declaredIn.env } }
        : { reason: f.reason };
    return { kind, subject: { connection: { from, to, name, env } }, basis };
  }
  if (f.access) {
    const { from, to, label } = f.access;
    const basis = f.principal !== undefined ? { principal: f.principal } : { reason: f.reason };
    // A row for a workload with no declared connection names no connection.
    if (f.access.name === undefined) return { kind, subject: { accessRow: { from, to, label } }, basis };
    return { kind, subject: { access: { from, to, name: f.access.name, env: f.access.env, label } }, basis };
  }
  if (f.exposure) {
    const { bundle, port, expose, section } = f.exposure;
    return { kind, subject: { exposure: { bundle, port, expose, section } }, basis: f.setting !== undefined ? { setting: f.setting } : { reason: f.reason } };
  }
  if (f.kind === "undeclared" && f.dial) {
    const { to, section, by, where } = f.dial;
    return { kind, subject: { dial: { from: f.from, to, section, by, where } }, basis: { reason: f.reason } };
  }
  if (f.kind === "undeclared" && f.binding) {
    const { name, type, target } = f.binding;
    return { kind, subject: { binding: { from: f.from, name, type, target: target ?? "" } }, basis: { reason: "declares no such wire" } };
  }
  // Every finding report.mjs builds has a place above. One that does not is a
  // new kind of finding, and needs a variant in manifest/cli.capnp first.
  throw new Error(`report-json: a finding with no declared form: ${JSON.stringify(Object.keys(f))}`);
}

/**
 * Attributes as dotted key → string value. The mapping reads nested blocks
 * (`metadata.namespace`), so the path is the key.
 */
function attributesOf(attrs, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) out.push(...attributesOf(value, path));
    else out.push({ key: path, value: Array.isArray(value) ? value.join(", ") : String(value) });
  }
  return out;
}

/** The InspectReport for `report`, without its formatVersion. */
export function declaredReport(report) {
  return {
    document: { kind: report.document.kind ?? "", terraformFormatVersion: report.document.formatVersion ?? "" },
    workloads: report.workloads.map((w) => ({
      name: w.name,
      bundle: w.bundle,
      source: w.source,
      bindingsWithheld: w.bindingsWithheld,
      bindings: w.bindings.map((b) => ({ name: b.name, type: b.type, target: b.target, workload: b.workload })),
    })),
    referencedByConfiguration: report.referencedByConfiguration.map(({ workload, type, name }) => ({ workload, type, name })),
    routes: report.routes.map(({ pattern, script, resolved }) => ({ pattern, script, resolved })),
    requestPaths: report.requestPaths.map(({ host, script, tunnel, service }) => ({ host, script, tunnel, service })),
    tunnels: [...report.tunnels],
    ingress: report.ingress.map((r) => ({ hostname: r.hostname ?? "", path: r.path ?? "", service: r.service ?? "" })),
    privateServices: report.privateServices.map((s) => ({ name: s.name, type: s.type, httpPort: Number(s.httpPort ?? 0), httpsPort: Number(s.httpsPort ?? 0) })),
    accessApplications: report.access.map((a) => ({
      name: a.name,
      domain: a.domain,
      type: a.type,
      policies: (a.policies ?? []).map((p) => ({ name: p.name ?? "", decision: p.decision ?? "", precedence: Number(p.precedence ?? 0) })),
    })),
    storage: report.storage.map(({ kind, name }) => ({ kind, name })),
    sections: report.sections.map((s) => ({
      title: s.title,
      resources: s.resources.map((r) => ({
        name: r.name,
        attributes: attributesOf(r.attrs),
        identity: r.identity ?? "",
        access: (r.access ?? []).map(({ label, principal, public: open }) => ({ label, principal, public: open === true })),
        accessLabels: [...(r.accessLabels ?? [])],
        withheld: [...(r.withheld ?? [])],
        dials: (r.dials ?? []).map(({ to, section, by, where }) => ({ from: r.name, to, section, by, where })),
      })),
    })),
    dns: report.dns.map(({ name, type, proxied }) => ({ name, type, proxied })),
    declaredWires: report.declared.map(({ from, to, binding }) => ({ from, to, binding })),
    declaredConnections: report.declaredConnections.map(({ from, to, name, env }) => ({ from, to, name, env })),
    unlisted: report.unlisted.map(({ name, section }) => ({ name, section })),
    findings: report.findings.map(declaredFinding),
    skipped: Object.entries(report.skipped ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count })),
  };
}
