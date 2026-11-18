// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lower a bundle to the workload of one placement (ADR-0074 §7).
//
// cluster.toml is the one description: a bundle's image, arguments, run mode
// and environment are declared there, whoever wrote it. This module turns
// that into the object a placement runs. It reads nothing else: not a plan,
// not a manifest. A second placement is a second function here, over the same
// bundle.
//
// Most of a bundle is the same in every placement. One thing is not: the
// address of each bundle it calls. That is why an env row may be a BINDING to
// a connection and not text. The address is written here, per placement:
//
//   kubernetes   <scheme>://<bundle>.<bundle>.svc.cluster.local:<port>
//                (one namespace per bundle, named after it; `cluster k8s`
//                reads the same form back and holds it to the connection)
//
// The output is a file for the operator to read and apply. Nothing is applied.

import { stringify as stringifyYaml } from "yaml";

import { envSource, isExposed, placementFor } from "./connections.mjs";

/** How an app_protocol label is dialled. A label not listed has no URL form here. */
const SCHEMES = Object.freeze({ "art.http": "http", "art.http2": "http", "art.grpc": "http", "art.mcp-jsonrpc": "http" });

/** A Kubernetes Secret name is a DNS subdomain; a key is a short identifier. */
const isSecretName = (name) => name.length <= 253 && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name);
const isSecretKey = (key) => /^[-._a-zA-Z0-9]+$/.test(key);

const LABEL = "app.kubernetes.io/name";
/** The key used when a secret row names none. */
const DEFAULT_SECRET_KEY = "latest";

/**
 * The address of connection `c` from the Kubernetes side, in `env`.
 * Throws by name when the connection cannot be reached from there.
 */
function kubernetesAddress(c, env, byName, where) {
  const target = c.targets.find((t) => t.env === env);
  if (!target) throw new Error(`${where}: connection "${c.name}" has no target for env "${env}"`);
  const bundle = byName.get(target.bundle);
  const kind = placementFor(bundle, env);
  if (kind !== "kubernetes") {
    throw new Error(
      `${where}: connection "${c.name}" reaches "${target.bundle}", which is placed "${kind}" for env "${env}". ` +
        `An address across placements needs LLO's broker, which nothing lowers yet`,
    );
  }
  const port = (bundle.ports ?? []).find((p) => p.name === target.port);
  const scheme = SCHEMES[c.appProtocol];
  if (!scheme) {
    throw new Error(
      `${where}: connection "${c.name}" speaks "${c.appProtocol}", which has no URL form here. ` +
        `Set the variable with a literal value for this placement`,
    );
  }
  return `${scheme}://${target.bundle}.${target.bundle}.svc.cluster.local:${port.port}`;
}

/**
 * One kubernetes-placed bundle as a manifest: a Deployment and a Service, or
 * a Job when the bundle runs to completion.
 *
 * @param {object} bundle a validated bundle (the zod shape)
 * @param {{bundles: Array, connections: Array, env: string}} cluster the
 *   checkable bundles (see `checkableBundle`) and normalized connections
 * @returns {string} YAML, with a header saying where each part came from
 */
export function kubernetesWorkload(bundle, { bundles, connections, env }) {
  const external = bundle.kind?.external;
  const name = bundle.name;
  const where = `bundle "${name}"`;
  if (!external) throw new Error(`${where} is not an external bundle; only an external bundle has a workload to write`);
  if (!external.image) throw new Error(`${where} has no [bundles.external] image; a workload cannot be written without one`);
  const byName = new Map(bundles.map((b) => [b.name, b]));
  const ports = (bundle.ports ?? []).filter(isExposed);
  const job = external.runs === "job";

  const env_ = [];
  const literal = [];
  const bound = [];
  const secrets = [];
  for (const row of external.env ?? []) {
    const source = envSource(row);
    if (source === "connection") {
      const c = connections.find((x) => x.from === name && x.name === row.connection);
      env_.push({ name: row.name, value: `${kubernetesAddress(c, env, byName, `${where} env "${row.name}"`)}${row.path ?? ""}` });
      bound.push(`env ${row.name}: the address of connection "${row.connection}"${row.path ? `, with "${row.path}" appended` : ""}`);
    } else if (source === "secret") {
      const key = row.secretKey || DEFAULT_SECRET_KEY;
      if (!isSecretName(row.secret) || !isSecretKey(key)) {
        throw new Error(`${where} env "${row.name}": secret "${row.secret}" key "${key}" cannot name a Kubernetes Secret and key`);
      }
      env_.push({ name: row.name, valueFrom: { secretKeyRef: { name: row.secret, key } } });
      secrets.push(`env ${row.name}: create Secret "${row.secret}" with key "${key}" in namespace "${name}". Its value is not in cluster.toml`);
    } else {
      env_.push({ name: row.name, value: row.value });
      literal.push(`env ${row.name}`);
    }
  }

  const container = {
    name,
    image: external.image,
    ...(external.entryPoint ? { command: [external.entryPoint] } : {}),
    ...(external.args?.length ? { args: [...external.args] } : {}),
    ...(ports.length ? { ports: ports.map((p) => ({ name: p.name, containerPort: p.port })) } : {}),
    ...(env_.length ? { env: env_ } : {}),
  };
  const labels = () => ({ [LABEL]: name });
  const metadata = () => ({ name, namespace: name, labels: labels() });
  const objects = [];
  if (job) {
    objects.push({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: metadata(),
      spec: { template: { metadata: { labels: labels() }, spec: { containers: [container], restartPolicy: "Never" } } },
    });
  } else {
    objects.push({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: metadata(),
      spec: { replicas: 1, selector: { matchLabels: labels() }, template: { metadata: { labels: labels() }, spec: { containers: [container] } } },
    });
  }
  if (ports.length) {
    objects.push({
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata(),
      spec: { selector: labels(), ports: ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.port, appProtocol: p.appProtocol })) },
    });
  }

  const callers = connections.filter((c) => c.targets.some((t) => t.env === env && t.bundle === name)).map((c) => c.from);
  const section = (title, items) => (items.length ? [`# ${title}`, ...items.map((i) => `#   - ${i}`)] : []);
  const header = [
    `# LOWERED. Written by \`cloister cluster lower\` from cluster.toml, for env "${env}".`,
    `# "${name}" as a ${job ? "Job" : "Deployment"}${ports.length ? " and a Service" : ""}. Read it before you apply it.`,
    "#",
    ...section("As cluster.toml declares it:", ["image", ...(external.entryPoint ? ["command"] : []), ...(external.args?.length ? ["args"] : []), ...literal]),
    ...section("Written for this placement:", bound),
    ...section("For you to provide:", secrets),
    "#",
    `# \`cloister cluster k8s\` admits only its declared callers: ${callers.length ? callers.join(", ") : "none"}.`,
    "",
  ];
  return `${header.join("\n")}\n${objects.map((o) => stringifyYaml(o)).join("---\n")}`;
}
