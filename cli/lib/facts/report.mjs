// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The inspect report: imported facts set beside cloister's declared graph
// (ADR-0073). It reads both and changes neither.
//
// Three kinds of finding, and what each one does NOT mean:
//   evidenced   a declared wire has a matching binding in the document.
//   unknown     a declared wire has none here. That is absence of evidence in
//               THIS document, not proof the edge is unenforced.
//   undeclared  the document binds one workload to another and cluster.toml
//               declares no such wire. It is reported. It is never adopted:
//               only a declaration grants (ADR-0070 §2).

import { bindingTarget, isWorkloadBinding } from "./cloudflare.mjs";

const SCRIPT = "cloudflare_workers_script";

export function buildReport({ facts, skipped, kind, formatVersion }, cluster) {
  const byType = (type) => facts.filter((f) => f.type === type);
  const scripts = byType(SCRIPT);
  const kvById = new Map(byType("cloudflare_workers_kv_namespace").map((f) => [f.attrs.ids.id, f.name]));
  const d1ById = new Map();
  for (const f of byType("cloudflare_d1_database")) {
    for (const id of [f.attrs.ids.id, f.attrs.ids.uuid]) if (id) d1ById.set(id, f.name);
  }

  const bundles = cluster?.bundles ?? [];
  const wires = cluster?.wires ?? [];
  const bundleOfScript = (scriptName) =>
    bundles.find((b) => b.workerdServiceName === scriptName || b.name === scriptName);
  const scriptOfBundle = (bundleName) => {
    const bundle = bundles.find((b) => b.name === bundleName);
    if (!bundle) return undefined;
    return scripts.find((s) => s.name === bundle.workerdServiceName || s.name === bundle.name);
  };

  const workloads = scripts.map((script) => ({
    name: script.name,
    bundle: bundleOfScript(script.name)?.name ?? "",
    bindingsWithheld: script.attrs.bindingsWithheld,
    bindings: script.attrs.bindings.map((b) => ({
      name: b.name,
      type: b.type,
      target: describeTarget(b, kvById, d1ById),
      workload: isWorkloadBinding(b),
    })),
  }));

  const findings = [];
  for (const wire of wires) {
    const script = scriptOfBundle(wire.from);
    if (!script) {
      findings.push({ kind: "unknown", wire, reason: `no Worker for bundle "${wire.from}" in this document` });
      continue;
    }
    if (script.attrs.bindingsWithheld) {
      findings.push({ kind: "unknown", wire, reason: `"${script.name}"'s bindings are marked sensitive and were not read` });
      continue;
    }
    const binding = script.attrs.bindings.find((b) => b.name === wire.binding);
    if (binding) {
      findings.push({ kind: "evidenced", wire, binding: { type: binding.type, target: describeTarget(binding, kvById, d1ById) } });
    } else {
      findings.push({ kind: "unknown", wire, reason: `"${script.name}" has no binding named ${wire.binding} in this document` });
    }
  }
  for (const script of scripts) {
    const bundle = bundleOfScript(script.name);
    if (!bundle) continue;
    const declared = new Set(wires.filter((w) => w.from === bundle.name).map((w) => w.binding));
    for (const binding of script.attrs.bindings) {
      if (!isWorkloadBinding(binding) || declared.has(binding.name)) continue;
      findings.push({
        kind: "undeclared",
        from: bundle.name,
        binding: { name: binding.name, type: binding.type, target: bindingTarget(binding) },
      });
    }
  }

  return {
    document: { kind, formatVersion },
    workloads,
    routes: byType("cloudflare_workers_route").map((f) => ({ pattern: f.attrs.pattern ?? "", script: f.attrs.script ?? "" })),
    tunnels: byType("cloudflare_zero_trust_tunnel_cloudflared").map((f) => f.name),
    ingress: byType("cloudflare_zero_trust_tunnel_cloudflared_config").flatMap((f) => f.attrs.ingress),
    access: byType("cloudflare_zero_trust_access_application").map((f) => ({
      name: f.name, domain: f.attrs.domain ?? "", type: f.attrs.type ?? "", policies: f.attrs.policies,
    })),
    storage: [
      ...byType("cloudflare_workers_kv_namespace").map((f) => ({ kind: "kv", name: f.name })),
      ...byType("cloudflare_d1_database").map((f) => ({ kind: "d1", name: f.name })),
    ],
    dns: byType("cloudflare_dns_record").map((f) => ({ name: f.name, type: f.attrs.type ?? "", proxied: f.attrs.proxied === true })),
    declared: wires.map((w) => ({ from: w.from, to: w.to, binding: w.binding })),
    findings,
    skipped,
  };
}

/** A binding's target by NAME where the document lets us resolve one; never a raw id. */
function describeTarget(binding, kvById, d1ById) {
  if (isWorkloadBinding(binding)) return bindingTarget(binding) || "(not stated)";
  if (binding.type === "kv_namespace") return kvById.get(binding.namespace_id) ?? "(a KV namespace not in this document)";
  if (binding.type === "d1") return d1ById.get(binding.id) ?? "(a D1 database not in this document)";
  if (binding.type === "r2_bucket") return binding.bucket_name ?? "(not stated)";
  if (binding.type === "queue") return binding.queue_name ?? "(not stated)";
  return "";
}

export function renderReport(report) {
  const lines = [];
  const section = (title) => { lines.push("", title); };
  lines.push(`Terraform ${report.document.kind} document (format ${report.document.formatVersion}). Read-only: nothing was run or written.`);

  section("Discovered workloads:");
  if (report.workloads.length === 0) lines.push("  (none)");
  for (const w of report.workloads) {
    lines.push(`  ${w.name}  Worker${w.bundle ? `  → bundle "${w.bundle}"` : "  (not in cluster.toml)"}`);
    if (w.bindingsWithheld) lines.push("    bindings: marked sensitive, not read");
    for (const b of w.bindings) lines.push(`    ${b.name}  ${b.type}${b.target ? `  → ${b.target}` : ""}`);
  }
  const list = (title, rows) => { if (rows.length) { section(title); for (const r of rows) lines.push(`  ${r}`); } };
  list("Routes:", report.routes.map((r) => `${r.pattern}  → ${r.script || "(no script)"}`));
  list("Tunnels:", report.tunnels);
  list("Tunnel ingress:", report.ingress.map((r) => `${r.hostname ?? "(catch-all)"}${r.path ? r.path : ""}  → ${r.service ?? "(not stated)"}`));
  list("Access applications:", report.access.map((a) => `${a.name}  ${a.domain}  (${a.type || "type not stated"}; ${a.policies.length} polic${a.policies.length === 1 ? "y" : "ies"})`));
  list("Storage:", report.storage.map((s) => `${s.kind}  ${s.name}`));
  list("DNS names:", report.dns.map((d) => `${d.name}  ${d.type}${d.proxied ? "  proxied" : ""}`));

  section("Declared wires (cluster.toml):");
  if (report.declared.length === 0) lines.push("  (none, or no cluster.toml given)");
  for (const d of report.declared) lines.push(`  ${d.from} → ${d.to}  as ${d.binding}`);

  section("Findings:");
  if (report.findings.length === 0) lines.push("  (none)");
  for (const f of report.findings) {
    if (f.kind === "evidenced") {
      lines.push(`  evidenced   ${f.wire.from} → ${f.wire.to} (${f.wire.binding}): bound as ${f.binding.type}${f.binding.target ? ` → ${f.binding.target}` : ""}`);
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
    lines.push("", "Not read (no adapter for these resource types):");
    for (const [type, count] of skipped) lines.push(`  ${count}  ${type}`);
  }
  return lines.join("\n");
}
