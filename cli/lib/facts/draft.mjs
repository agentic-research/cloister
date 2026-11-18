// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Draft a cluster.toml from what a rendered plan or state describes
// (ADR-0074 §3, §5.2).
//
// A workload becomes a bundle and an implied edge becomes a connection. The
// draft is text for the operator to read and commit: committing is what turns
// an observation into a declaration. Nothing here is adopted on its own, and
// nothing is written to disk.
//
// What the inputs did not show is said, at the top of the draft. A draft that
// stayed quiet about a sensitive env block or an unread resource type would
// pass for the whole graph when it is part of one.
//
// Nothing here names a provider. Which resource types are workloads, where
// their image and ports are, and which placement kind they satisfy all come
// from the mapping (`report.bundle`).

import { stringify as stringifyToml } from "smol-toml";

import { dnsLabelProblem } from "../cluster/connections.mjs";
import { sectionsOf } from "./report.mjs";

/**
 * @param {{facts: Array, skipped: Record<string, number>, kind: string|null}} imported
 * @param {{env: string, name?: string, local?: {env: string, kind: string, manifestOf: (bundle: string) => string}}} options
 *   `env` names the environment the placement rows and connection targets are
 *   written for. `local` adds a second placement and target for another
 *   environment, whose manifests the caller is about to write (lowering).
 * @returns {{toml: string, bundles: number, connections: number, notes: string[], drafted: Map, cluster: object}}
 */
export function draftCluster(imported, { env, name = "drafted", local }) {
  const notes = [];
  const workloads = sectionsOf(imported.facts, imported.kind, { withRun: Boolean(local) })
    .flatMap((section) => section.resources.map((r) => ({ ...r, section: section.title })))
    .filter((r) => r.bundle);

  // The same name is the same thing (ADR-0074 §4). Two workloads with one
  // name resolve to neither, so neither is drafted.
  const byName = new Map();
  for (const w of workloads) byName.set(w.name, [...(byName.get(w.name) ?? []), w]);
  const drafted = new Map();
  for (const [workloadName, same] of byName) {
    if (same.length > 1) {
      notes.push(`"${workloadName}" is the name of ${same.length} workloads (${same.map((w) => w.section).join(", ")}); none is drafted, because a bundle name must mean one thing`);
      continue;
    }
    const problem = dnsLabelProblem(workloadName);
    if (problem) {
      notes.push(`"${workloadName}" (${same[0].section}) is not drafted: a bundle name must be a DNS label, and it ${problem}`);
      continue;
    }
    drafted.set(workloadName, same[0]);
  }

  const bundles = [];
  for (const w of drafted.values()) {
    const bundle = { name: w.name, kind: "external", tier: "cluster" };
    if (w.bundle.image) bundle.external = { image: w.bundle.image };
    else notes.push(`"${w.name}": no image was read; add [bundles.external] image by hand`);
    const ports = [];
    for (const p of w.bundle.ports) {
      if (p.appProtocol === "") {
        notes.push(`"${w.name}": port ${p.port} is served as "${p.name}", which has no appProtocol here; it is not drafted`);
        continue;
      }
      if (ports.some((q) => q.name === p.name || q.port === p.port)) {
        notes.push(`"${w.name}": port ${p.port} ("${p.name}") repeats a name or number already drafted; it is not drafted`);
        continue;
      }
      if (p.assumed) notes.push(`"${w.name}": declares no port; ${p.port} ("${p.name}") is this provider's default and was assumed, not read`);
      ports.push({ name: p.name, port: p.port, appProtocol: p.appProtocol, expose: "cluster" });
    }
    if (ports.length) bundle.ports = ports;
    bundle.placements = [{ env, kind: w.bundle.placement }];
    if (local) bundle.placements.push({ env: local.env, kind: local.kind, manifest: local.manifestOf(w.name) });
    // Lowering reads env from the configuration, so a withheld planned list
    // hides nothing there and each variable is accounted for by name.
    if (w.withheld.length && !local) {
      notes.push(`"${w.name}": its ${w.withheld.join(" and ")} ${w.withheld.length === 1 ? "is" : "are"} marked sensitive and ${w.withheld.length === 1 ? "was" : "were"} not read; an edge that is only in ${w.withheld.length === 1 ? "it" : "them"} is missing below`);
    }
    bundles.push(bundle);
  }

  const connections = [];
  for (const w of drafted.values()) {
    for (const dial of w.dials) {
      const how = dial.by === "address" ? dial.where : `referenced by configuration in ${dial.where}`;
      const edge = `${w.name} → ${dial.to} (${how})`;
      const target = drafted.get(dial.to);
      if (!target || target.section !== dial.section) {
        notes.push(`${edge} is not drafted: "${dial.to}" (${dial.section}) is not a drafted bundle, and a connection's target must be one`);
        continue;
      }
      const port = bundles.find((b) => b.name === target.name).ports?.[0];
      if (!port) {
        notes.push(`${edge} is not drafted: "${dial.to}" has no drafted port for it to reach`);
        continue;
      }
      connections.push({
        from: w.name,
        name: dial.to,
        appProtocol: port.appProtocol,
        targets: [{ env, bundle: dial.to, port: port.name }, ...(local ? [{ env: local.env, bundle: dial.to, port: port.name }] : [])],
      });
    }
  }

  for (const [type, count] of Object.entries(imported.skipped ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    notes.push(`${count} ${type} ${count === 1 ? "resource was" : "resources were"} not read: no mapping describes that type`);
  }

  const cluster = {
    metadata: { name, version: "0.0.0" },
    storage: {},
    bundles,
    ...(connections.length ? { connections } : {}),
  };
  const body = stringifyToml(cluster);
  const header = [
    `# DRAFT. Written by \`cloister ${local ? "cluster lower" : "inspect --draft"}\` from a rendered ${imported.kind ?? "document"}.`,
    "# Read it before you commit it. Committing it is what makes it a declaration:",
    "# until then it is only what the inputs imply.",
    "#",
    `# ${bundles.length} ${bundles.length === 1 ? "bundle" : "bundles"}, ${connections.length} ${connections.length === 1 ? "connection" : "connections"}, for env "${env}"${local ? ` and env "${local.env}"` : ""}.`,
    "# A connection has no minStrength: add one where an edge must be enforced.",
    ...(notes.length ? ["#", "# Read these first:", ...notes.map((n) => `#   - ${n}`)] : ["#", "# Nothing in the inputs was left out."]),
    "",
  ];
  return { toml: `${header.join("\n")}\n${body}`, bundles: bundles.length, connections: connections.length, notes, drafted, cluster };
}
