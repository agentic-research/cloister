// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lower a rendered plan to a second placement: the same workloads, written as
// Kubernetes manifests for a local cluster (ADR-0074 §5.3).
//
// A plan describes one deployment. Most of what a workload is carries over to
// another placement unchanged: its image, its arguments, the constants in its
// environment. Some of it is different in every placement: the address of
// each workload it calls. And some of it is not in the plan at all: a value
// taken from a variable, or the contents of a secret.
//
// This writes the first, rewrites the second, and NAMES the third. A manifest
// that silently dropped an env var would start a service that fails later for
// a reason nobody wrote down, so every variable that is not written is listed
// at the top of the file it is missing from, with where it comes from.
//
// The output is files for the operator to read, fix and apply. Cloister
// applies nothing. The manifests are then ordinary input to `cluster k8s`,
// which holds the addresses in them to the declared connections like any
// other manifest: what this module writes is checked by the same rule as what
// an operator writes.
//
// Nothing here names a provider. What a workload is started with, and what
// kind of thing it is, come from the mapping (`report.bundle`).

import { stringify as stringifyYaml } from "yaml";

import { draftCluster } from "./draft.mjs";

/** The schemes an app_protocol label is dialled with. Others are left to the operator. */
const SCHEMES = Object.freeze({ "art.http": "http", "art.http2": "http", "art.grpc": "http", "art.mcp-jsonrpc": "http" });

/** A Kubernetes Secret name: a DNS subdomain. Anything else is not guessed at. */
const isSecretName = (name) => /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name) && name.length <= 253;
/** A key inside a Secret. */
const isSecretKey = (key) => /^[-._a-zA-Z0-9]+$/.test(key);

const LABEL = "app.kubernetes.io/name";

/** `<service>.<namespace>.svc.cluster.local`: one namespace per bundle, named after it. */
const clusterHost = (bundle) => `${bundle}.${bundle}.svc.cluster.local`;

/**
 * @param {{facts: Array, skipped: Record<string, number>, kind: string|null}} imported a PLAN
 * @param {{from: string, to: string, name?: string}} options `from` is the
 *   environment the plan describes; `to` is the one the manifests are for.
 * @returns {{files: Record<string, string>, notes: string[], bundles: number, connections: number}}
 */
export function lowerCluster(imported, { from, to, name }) {
  if (imported.kind !== "plan") {
    throw new Error(
      "lowering needs a rendered PLAN (`terraform show -json <planfile>`). A state document does not say " +
        "where a value is taken from, and that is how an address is told apart from a constant",
    );
  }
  if (from === to) throw new Error(`--from and --to are both "${from}"; lowering writes a second placement`);
  const manifestOf = (bundle) => `${bundle}.yaml`;
  const draft = draftCluster(imported, { env: from, name, local: { env: to, kind: "kubernetes", manifestOf } });
  const bundles = new Map(draft.cluster.bundles.map((b) => [b.name, b]));
  const connections = draft.cluster.connections ?? [];
  const files = {};
  const notes = [...draft.notes];

  for (const [bundleName, workload] of draft.drafted) {
    const bundle = bundles.get(bundleName);
    const { run, runs } = workload.bundle;
    const carried = [];
    const rewritten = [];
    const missing = [];

    const env = [];
    for (const entry of run.env ?? []) {
      if (entry.kind === "constant") {
        env.push({ name: entry.name, value: entry.value });
        carried.push(`env ${entry.name} (a constant in the configuration)`);
      } else if (entry.kind === "workload") {
        const target = bundles.get(entry.to);
        const edge = connections.find((c) => c.from === bundleName && c.name === entry.to);
        const port = target?.ports?.find((p) => p.name === edge?.targets[0]?.port);
        const scheme = port ? SCHEMES[port.appProtocol] : undefined;
        if (!edge || !port || !scheme) {
          missing.push(`env ${entry.name}: the address of "${entry.to}" (${entry.section}), which has no drafted connection to rewrite it to`);
          continue;
        }
        env.push({ name: entry.name, value: `${scheme}://${clusterHost(entry.to)}:${port.port}` });
        rewritten.push(`env ${entry.name}: the address of "${entry.to}". If the plan appends a path to it, add the path back`);
      } else if (entry.kind === "secret") {
        const key = entry.version === "" ? "latest" : entry.version;
        if (!isSecretName(entry.secret) || !isSecretKey(key)) {
          missing.push(`env ${entry.name}: secret "${entry.secret}", whose name cannot be a Kubernetes Secret's`);
          continue;
        }
        env.push({ name: entry.name, valueFrom: { secretKeyRef: { name: entry.secret, key } } });
        missing.push(`the VALUE of env ${entry.name}: create Secret "${entry.secret}" with key "${key}" in namespace "${bundleName}". The reference is written; the value is never in a plan`);
      } else {
        missing.push(`env ${entry.name}: taken from ${entry.from.length ? entry.from.join(", ") : "something the configuration does not name"}, which this plan does not resolve`);
      }
    }

    if (bundle.external?.image) carried.push("image");
    else missing.push("image");
    if (run.command.length) carried.push("command");
    if (run.args.length) carried.push("args");

    const container = {
      name: bundleName,
      ...(bundle.external?.image ? { image: bundle.external.image } : {}),
      ...(run.command.length ? { command: run.command } : {}),
      ...(run.args.length ? { args: run.args } : {}),
      ...(bundle.ports?.length ? { ports: bundle.ports.map((p) => ({ name: p.name, containerPort: p.port })) } : {}),
      ...(env.length ? { env } : {}),
    };
    const labels = { [LABEL]: bundleName };
    const pod = { metadata: { labels }, spec: { containers: [container] } };
    const objects = [];
    if (runs === "job") {
      objects.push({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: bundleName, namespace: bundleName, labels },
        spec: { template: { ...pod, spec: { ...pod.spec, restartPolicy: "Never" } } },
      });
    } else {
      objects.push({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: bundleName, namespace: bundleName, labels },
        spec: { replicas: 1, selector: { matchLabels: labels }, template: pod },
      });
    }
    if (bundle.ports?.length) {
      objects.push({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: bundleName, namespace: bundleName, labels },
        spec: {
          selector: labels,
          ports: bundle.ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.port, appProtocol: p.appProtocol })),
        },
      });
    }

    // Who may call it. In the plan that is an access row; here it is a
    // declared connection, which `cluster k8s` turns into a NetworkPolicy.
    const callers = connections.filter((c) => c.targets.some((t) => t.env === to && t.bundle === bundleName)).map((c) => c.from);
    const granted = workload.access.map((a) => `${a.label} ${a.principal}`);
    const access = granted.length
      ? [`In the plan, these may call it: ${granted.join("; ")}.`, `Here, \`cluster k8s\` admits only its declared callers: ${callers.length ? callers.join(", ") : "none"}.`]
      : callers.length ? [`Here, \`cluster k8s\` admits only its declared callers: ${callers.join(", ")}.`] : [];

    const section = (title, items) => (items.length ? [`# ${title}`, ...items.map((i) => `#   - ${i}`)] : []);
    const header = [
      `# LOWERED. Written by \`cloister cluster lower\` from a rendered plan, for env "${to}".`,
      `# "${bundleName}" as a ${runs === "job" ? "Job" : "Deployment"}${bundle.ports?.length ? " and a Service" : ""}. Read it before you apply it.`,
      "#",
      ...section("Carried over as the plan has it:", carried),
      ...section("Rewritten for this cluster:", rewritten),
      ...section("NOT in this file, because the plan does not hold it:", missing),
      ...(access.length ? ["#", ...access.map((line) => `# ${line}`)] : []),
      "",
    ];
    files[manifestOf(bundleName)] = `${header.join("\n")}\n${objects.map((o) => stringifyYaml(o, { aliasDuplicateObjects: false })).join("---\n")}`;
    for (const item of missing) notes.push(`"${bundleName}": not written: ${item}`);
  }

  files["cluster.toml"] = draft.toml;
  return { files, notes, bundles: draft.bundles, connections: draft.connections };
}
