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

import { bindingTarget, isWorkloadBinding, resolveBinding, resolveRelations } from "./cloudflare.mjs";

const SCRIPT = "cloudflare_workers_script";
const WRANGLER = "wrangler_worker";

/** A route pattern's host: the text before the first "/". Null when it holds a wildcard. */
function routeHost(pattern) {
  const host = pattern.split("/")[0];
  return host === "" || host.includes("*") ? null : host;
}

export function buildReport({ facts, skipped, kind, formatVersion }, cluster) {
  const byType = (type) => facts.filter((f) => f.type === type);

  // Workers: Terraform scripts plus wrangler configs. One name is listed once.
  const workerMap = new Map();
  for (const fact of [...byType(SCRIPT), ...byType(WRANGLER)]) {
    const w = workerMap.get(fact.name) ?? { name: fact.name, terraform: false, wrangler: false, bindings: [], seen: new Set(), withheld: false };
    const isTf = fact.type === SCRIPT;
    w[isTf ? "terraform" : "wrangler"] = true;
    if (isTf && fact.attrs.bindingsWithheld) w.withheld = true;
    for (const b of fact.attrs.bindings ?? []) {
      if (w.seen.has(b.name)) continue;
      w.seen.add(b.name);
      w.bindings.push(b);
    }
    workerMap.set(fact.name, w);
  }
  const workers = [...workerMap.values()].map(({ seen: _seen, ...w }) => ({ ...w, withheld: w.withheld && !w.wrangler }));

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

  const workerNames = new Set(workers.map((w) => w.name));
  const routes = byType("cloudflare_workers_route").map((f) => {
    const script = f.attrs.script ?? "";
    return { pattern: f.attrs.pattern ?? "", script, resolved: script === "" || workerNames.has(script) };
  });

  // Request paths: a route and a tunnel ingress rule that name the same host, by exact string equality.
  const requestPaths = [];
  for (const config of byType("cloudflare_zero_trust_tunnel_cloudflared_config")) {
    const [tunnelRelation] = resolveRelations(config, facts);
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
    ],
    dns: byType("cloudflare_dns_record").map((f) => ({ name: f.name, type: f.attrs.type ?? "", proxied: f.attrs.proxied === true })),
    declared: wires.map((w) => ({ from: w.from, to: w.to, binding: w.binding })),
    findings,
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
  if (binding.type === "r2_bucket") return binding.bucket_name ?? "(not stated)";
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
  list("DNS names:", report.dns.map((d) => `${d.name}  ${d.type}${d.proxied ? "  proxied" : ""}`));

  section("Declared wires (cluster.toml):");
  if (report.declared.length === 0) lines.push("  (none, or no cluster.toml given)");
  for (const d of report.declared) lines.push(`  ${d.from} → ${d.to}  as ${d.binding}`);

  section("Findings:");
  if (report.findings.length === 0) lines.push("  (none)");
  for (const f of report.findings) {
    if (f.kind === "evidenced") {
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
