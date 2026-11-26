// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Draft a cluster.toml from what a rendered plan or state describes
// (ADR-0074 §3, §5.2, §7).
//
// A workload becomes a bundle and an implied edge becomes a connection. The
// draft is text for the operator to read and commit: committing is what turns
// an observation into a declaration. Nothing here is adopted on its own, and
// nothing is written to disk.
//
// cluster.toml is the one description every placement is lowered from, so the
// draft carries everything a workload is started with that the inputs hold:
// its image, arguments, run mode, and environment. An env value is drafted as
// what it IS, not as text:
//
//   a constant in the configuration   → a literal `value`
//   taken from another workload       → a `connection` binding. The address
//                                       differs in every placement, so each
//                                       emitter writes it.
//   a secret reference                → a `secret` reference. Never a value.
//   anything else (a variable)        → not drafted, and named at the top.
//
// What the inputs did not show is said, at the top of the draft. A draft that
// stayed quiet about an unresolved variable or an unread resource type would
// pass for the whole system when it is part of one.
//
// Nothing here names a provider. Which resource types are workloads, where
// their image, ports and env are, and which placement kind they satisfy all
// come from the mapping (`report.bundle`).

import { stringify as stringifyToml } from "smol-toml";

import { dnsLabelProblem } from "../cluster/connections.mjs";
import { sectionsOf } from "./report.mjs";

/**
 * @param {{facts: Array, skipped: Record<string, number>, kind: string|null}} imported
 * @param {{env: string, name?: string, local?: string, localKind?: string}} options `env` names
 *   the environment the inputs describe. `local` names a second environment:
 *   each bundle also gets a placement there (`localKind`: "kubernetes", the
 *   default, or "knative"), with a manifest path that `cloister cluster lower`
 *   writes, and each connection a target there.
 * @returns {{toml: string, bundles: number, connections: number, notes: string[]}}
 */
export function draftCluster(imported, { env, name = "drafted", local, localKind = "kubernetes" }) {
  if (!["kubernetes", "knative"].includes(localKind)) throw new Error(`--local-kind "${localKind}" is not one of kubernetes, knative`);
  if (local !== undefined && local === env) throw new Error(`--local and --env are both "${env}"; a second placement needs a second environment`);
  const notes = [];
  const workloads = sectionsOf(imported.facts, imported.kind, { withRun: true, registry: imported.registry })
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
    // A bundle is one container (ADR-0074, amendment of 2026-11-26). Several,
    // with nothing in the inputs to say which serves, are not one bundle, and
    // two are never merged into one.
    const { containers, container } = same[0].bundle;
    if (container === null && containers.length > 1) {
      notes.push(
        `"${workloadName}" (${same[0].section}) is not drafted: it runs ${containers.length} containers (${containers.map((c) => `"${c}"`).join(", ")}), ` +
          "and these inputs do not say which one serves. A bundle is one container",
      );
      continue;
    }
    drafted.set(workloadName, same[0]);
  }

  const bundles = [];
  for (const w of drafted.values()) {
    const { run } = w.bundle;
    const bundle = { name: w.name, kind: "external", tier: "cluster" };
    const beside = w.bundle.containers.filter((c) => c !== w.bundle.container);
    if (w.bundle.containers.length > 1) {
      notes.push(
        `"${w.name}": drafted from its container "${w.bundle.container}", the one that serves. ${beside.map((c) => `"${c}"`).join(", ")} ` +
          `${beside.length === 1 ? "runs" : "run"} beside it and ${beside.length === 1 ? "is" : "are"} not drafted: a bundle is one container`,
      );
    }
    const external = {};
    if (w.bundle.image) external.image = w.bundle.image;
    else notes.push(`"${w.name}": no image was read; add [bundles.external] image by hand`);
    // The first word of a command is the binary; the rest are its arguments.
    if (run.command.length) external.entryPoint = run.command[0];
    const args = [...run.command.slice(1), ...run.args];
    if (args.length) external.args = args;
    if (w.bundle.runs === "job") external.runs = "job";
    bundle.external = external;

    const ports = [];
    // What the inputs say about reaching it from outside decides `expose`.
    const exposed = w.bundle.exposure?.expose ?? "";
    if (w.bundle.portsWithheld) {
      notes.push(`"${w.name}": a port it declares is marked sensitive and was not read; no port is assumed in its place`);
    }
    for (const p of w.bundle.ports) {
      if (p.nameWithheld) {
        notes.push(`"${w.name}": port ${p.port}'s name, which says how it is served, is marked sensitive and was not read; it is not drafted`);
        continue;
      }
      if (p.appProtocol === "") {
        notes.push(`"${w.name}": port ${p.port} is served as "${p.name}", which has no appProtocol here; it is not drafted`);
        continue;
      }
      if (ports.some((q) => q.name === p.name || q.port === p.port)) {
        notes.push(`"${w.name}": port ${p.port} ("${p.name}") repeats a name or number already drafted; it is not drafted`);
        continue;
      }
      if (p.byConvention) notes.push(`"${w.name}": port ${p.port} is named "${p.name}", and its protocol (${p.appProtocol}) is taken from that name. A port name is free text here, so check it`);
      if (p.assumed) notes.push(`"${w.name}": declares no port; ${p.port} ("${p.name}") is this provider's default and was assumed, not read`);
      ports.push({ name: p.name, port: p.port, appProtocol: p.appProtocol, expose: exposed === "edge" ? "edge" : "cluster" });
    }
    if (ports.length) bundle.ports = ports;
    if (ports.length && w.bundle.exposure) {
      const { attr, setting, why } = w.bundle.exposure;
      if (exposed === "edge") {
        notes.push(`"${w.name}": its ${attr} is ${setting}, so it can be reached from outside and is drafted expose = "edge". If that is not intended, fix the deployment${local ? `. For "${local}" it is drafted expose = "cluster": internal there` : ""}`);
      } else if (exposed === "") {
        const said = setting === "" ? `these inputs do not state its ${attr}` : why ? `its ${attr} is ${setting}: ${why}` : `its ${attr} is ${setting}, which the mapping does not sort`;
        notes.push(`"${w.name}": ${said}, so whether it can be reached from outside is unknown. It is drafted expose = "cluster": check it`);
      }
    }
    bundle.placements = [{ env, kind: w.bundle.placement }];
    if (local) {
      // A job is not a Knative Service: it is a Kubernetes Job wherever it runs.
      const kind = w.bundle.runs === "job" ? "kubernetes" : localKind;
      const row = { env: local, kind, manifest: `${w.name}.yaml` };
      // What differs in the second placement, per port. A Knative Service is
      // dialled on 80 whatever its container listens on. And a service that
      // can be reached from outside where the inputs describe it is internal
      // on a second cluster unless someone says otherwise.
      const rows = ports
        .map((p) => ({
          name: p.name,
          ...(kind === "knative" && p.port !== 80 ? { port: 80 } : {}),
          ...(p.expose === "edge" ? { expose: "cluster" } : {}),
        }))
        .filter((r) => Object.keys(r).length > 1);
      if (rows.length) row.ports = rows;
      bundle.placements.push(row);
      if (kind !== localKind) notes.push(`"${w.name}": runs to completion, so it is placed "kubernetes" for "${local}", not "${localKind}"`);
    }
    // Env rows are read from the configuration when there is one (a plan). A
    // state document has none, and its planned env may be withheld. Rows read
    // from the values (an object held whole) miss whatever is withheld.
    if ((run.env === null || run.envFromValues) && w.withheld.length) {
      const one = w.withheld.length === 1;
      notes.push(`"${w.name}": its ${w.withheld.join(" and ")} ${one ? "is" : "are"} marked sensitive and ${one ? "was" : "were"} not read; an edge that is only in ${one ? "it" : "them"} is missing below`);
    }
    bundles.push(bundle);
  }
  const bundleNamed = (bundleName) => bundles.find((b) => b.name === bundleName);

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
      const port = bundleNamed(target.name).ports?.[0];
      if (!port) {
        notes.push(`${edge} is not drafted: "${dial.to}" has no drafted port for it to reach`);
        continue;
      }
      connections.push({
        from: w.name,
        name: dial.to,
        appProtocol: port.appProtocol,
        targets: [{ env, bundle: dial.to, port: port.name }, ...(local ? [{ env: local, bundle: dial.to, port: port.name }] : [])],
      });
    }
  }

  // Env, once the connections exist: an address is drafted as a binding to one.
  for (const w of drafted.values()) {
    const rows = [];
    for (const entry of w.bundle.run.env ?? []) {
      if (entry.kind === "constant") {
        rows.push({ name: entry.name, value: entry.value });
      } else if (entry.kind === "workload") {
        if (connections.some((c) => c.from === w.name && c.name === entry.to)) {
          // A literal address shows what follows it. One taken from another
          // resource does not: the configuration records the reference, and
          // anything appended to it is not in the row.
          const known = typeof entry.path === "string";
          rows.push({ name: entry.name, connection: entry.to, ...(known && entry.path !== "" ? { path: entry.path } : {}) });
          if (!known) notes.push(`"${w.name}": env ${entry.name} is the address of "${entry.to}". If the inputs append a path to it, add \`path = "..."\` to that row`);
        } else {
          notes.push(`"${w.name}": env ${entry.name} is not drafted: it is the address of "${entry.to}" (${entry.section}), which has no drafted connection to bind it to`);
        }
      } else if (entry.kind === "secret") {
        rows.push({ name: entry.name, secret: entry.secret, ...(entry.version ? { secretKey: entry.version } : {}) });
      } else if (entry.inObject) {
        notes.push(`"${w.name}": env ${entry.name} is not drafted: its value is written in an object that takes values from ${entry.from.length ? entry.from.join(", ") : "something these inputs do not show"}, and the configuration does not say which of them, if any, it came from`);
      } else {
        notes.push(`"${w.name}": env ${entry.name} is not drafted: it is taken from ${entry.from.length ? entry.from.join(", ") : "something the configuration does not name"}, which these inputs do not resolve`);
      }
    }
    if (rows.length) bundleNamed(w.name).external.env = rows;
  }

  for (const [type, count] of Object.entries(imported.skipped ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    notes.push(`${count} ${type} ${count === 1 ? "resource was" : "resources were"} not read: no mapping describes that type`);
  }

  const body = stringifyToml({
    metadata: { name, version: "0.0.0" },
    storage: {},
    bundles,
    ...(connections.length ? { connections } : {}),
  });
  const count = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;
  const header = [
    `# DRAFT. Written by \`cloister inspect --draft\` from a rendered ${imported.kind ?? "document"}.`,
    "# Read it before you commit it. Committing it is what makes it a declaration:",
    "# until then it is only what the inputs imply.",
    "#",
    `# ${count(bundles.length, "bundle")}, ${count(connections.length, "connection")}, for env "${env}"${local ? ` and env "${local}"` : ""}.`,
    "# A connection has no minStrength: add one where an edge must be enforced.",
    ...(local ? [`# Next: \`cloister cluster lower --env ${local}\` writes each bundle's manifest for "${local}".`] : []),
    ...(notes.length ? ["#", "# Read these first:", ...notes.map((n) => `#   - ${n}`)] : ["#", "# Nothing in the inputs was left out."]),
    "",
  ];
  return { toml: `${header.join("\n")}\n${body}`, bundles: bundles.length, connections: connections.length, notes };
}
