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
//   knative      <scheme>://<bundle>.<bundle>.svc.cluster.local   (port 80)
//
// One namespace per bundle, named after it. `cluster k8s` reads the same form
// back and holds it to the connection. The port is the one DIALLED in the
// placement (`portsFor`), which a placement row may set apart from the number
// the workload listens on: a Knative Service is dialled on 80 whatever its
// container binds.
//
// The output is a file for the operator to read and apply. Nothing is applied.

import { stringify as stringifyYaml } from "yaml";

import { URL_SCHEMES as SCHEMES, envSource, isExposed, joinable, placementFor, portsFor } from "./connections.mjs";
import { KNATIVE_CLUSTER_LOCAL, KNATIVE_VISIBILITY_LABEL, KNATIVE_WIRES } from "./emit-k8s.mjs";
import { parseImageRef, pinnedImage } from "../oci-artifact.mjs";


/** A Kubernetes Secret name is a DNS subdomain; a key is a short identifier. */
const isSecretName = (name) => name.length <= 253 && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name);
const isSecretKey = (key) => /^[-._a-zA-Z0-9]+$/.test(key);

const LABEL = "app.kubernetes.io/name";
/** The key used when a secret row names none. */
const DEFAULT_SECRET_KEY = "latest";

/** The placement kinds this module writes a workload for. */
export const LOWERED_KINDS = Object.freeze(["kubernetes", "knative"]);

/** The port a URL scheme implies, so it is left out of the address. */
const IMPLIED = Object.freeze({ http: 80 });

/**
 * The address of connection `c` in `env`, from a bundle placed `fromKind`.
 * The target must be on the same cluster network (kubernetes or knative): an
 * address into any other placement is not one an emitter here can write.
 * Throws by name.
 */
function clusterAddress(c, env, byName, fromKind, where) {
  const target = c.targets.find((t) => t.env === env);
  if (!target) throw new Error(`${where}: connection "${c.name}" has no target for env "${env}"`);
  const bundle = byName.get(target.bundle);
  const kind = placementFor(bundle, env);
  // kubernetes and knative share a cluster network and one address form.
  if (!LOWERED_KINDS.includes(kind) || !joinable(fromKind, kind)) {
    throw new Error(
      `${where}: connection "${c.name}" reaches "${target.bundle}", which is placed "${kind}" for env "${env}". ` +
        `An address across placements needs LLO's broker, which nothing lowers yet`,
    );
  }
  const port = portsFor(bundle, env).find((p) => p.name === target.port);
  const scheme = SCHEMES[c.appProtocol];
  if (!scheme) {
    throw new Error(
      `${where}: connection "${c.name}" speaks "${c.appProtocol}", which has no URL form here. ` +
        `Set the variable with a literal value for this placement`,
    );
  }
  const host = `${target.bundle}.${target.bundle}.svc.cluster.local`;
  return IMPLIED[scheme] === port.port ? `${scheme}://${host}` : `${scheme}://${host}:${port.port}`;
}

/**
 * A bundle's env rows as Kubernetes `env` entries, with what each one is.
 * Shared by every emitter that writes a pod spec.
 */
function podEnv(bundle, { byName, connections, env, kind }) {
  const name = bundle.name;
  const where = `bundle "${name}"`;
  const rows = [];
  const literal = [];
  const bound = [];
  const secrets = [];
  for (const row of bundle.kind.external.env ?? []) {
    const source = envSource(row);
    if (source === "connection") {
      const c = connections.find((x) => x.from === name && x.name === row.connection);
      rows.push({ name: row.name, value: `${clusterAddress(c, env, byName, kind, `${where} env "${row.name}"`)}${row.path ?? ""}` });
      bound.push(`env ${row.name}: the address of connection "${row.connection}"${row.path ? `, with "${row.path}" appended` : ""}`);
    } else if (source === "secret") {
      const key = row.secretKey || DEFAULT_SECRET_KEY;
      if (!isSecretName(row.secret) || !isSecretKey(key)) {
        throw new Error(`${where} env "${row.name}": secret "${row.secret}" key "${key}" cannot name a Kubernetes Secret and key`);
      }
      rows.push({ name: row.name, valueFrom: { secretKeyRef: { name: row.secret, key } } });
      secrets.push(
        `env ${row.name}: create Secret "${row.secret}" with key "${key}" in namespace "${name}". Its value is not in cluster.toml` +
          (row.connection ? `. cluster.toml says it holds the address of connection "${row.connection}": write the address for this placement into it` : ""),
      );
    } else {
      rows.push({ name: row.name, value: row.value });
      literal.push(`env ${row.name}`);
    }
  }
  return { rows, literal, bound, secrets };
}

/** The header every lowered manifest starts with: where each part came from. */
function headerOf({ name, env, what, external, literal, bound, secrets, tail, pinnedBy }) {
  const section = (title, items) => (items.length ? [`# ${title}`, ...items.map((i) => `#   - ${i}`)] : []);
  return [
    `# LOWERED. Written by \`cloister cluster lower\` from cluster.toml, for env "${env}".`,
    `# "${name}" as ${what}. Read it before you apply it.`,
    "#",
    ...(pinnedBy
      ? [`# Its image runs by the digest ${pinnedBy} (ADR-0083).`]
      : [
        `# Its image ${external.image} is not pinned by digest: it runs whatever its tag names`,
        "# when the pod starts. `cloister cluster resolve` pins one that names a registry (ADR-0083).",
      ]),
    "#",
    ...section("As cluster.toml declares it:", ["image", ...(external.entryPoint ? ["command"] : []), ...(external.args?.length ? ["args"] : []), ...literal]),
    ...section("Written for this placement:", bound),
    ...section("For you to provide:", secrets),
    "#",
    ...tail.map((line) => `# ${line}`),
    "",
  ].join("\n");
}

function requireWorkload(bundle) {
  const external = bundle.kind?.external;
  const where = `bundle "${bundle.name}"`;
  if (!external) throw new Error(`${where} is not an external bundle; only an external bundle has a workload to write`);
  if (!external.image) throw new Error(`${where} has no [bundles.external] image; a workload cannot be written without one`);
  return external;
}

/**
 * The image a workload runs (ADR-0083 §1), and which file pins its digest:
 * cluster.toml when the declaration writes it, otherwise the lock.
 */
function workloadImage(external, images) {
  const pinned = pinnedImage(external.image, images);
  if (pinned === null) return { image: external.image, pinnedBy: null };
  return { image: pinned, pinnedBy: parseImageRef(external.image).digest ? "cluster.toml writes" : "cluster.lock.toml pins" };
}

/**
 * One kubernetes-placed bundle as a manifest: a Deployment and a Service, or
 * a Job when the bundle runs to completion.
 *
 * @param {object} bundle a validated bundle (the zod shape)
 * @param {{bundles: Array, connections: Array, env: string, images?: Map<string, string>}} cluster the
 *   checkable bundles (see `checkableBundle`), normalized connections, and the
 *   lock's image pins (`lockedImages`)
 * @returns {string} YAML, with a header saying where each part came from
 */
export function kubernetesWorkload(bundle, { bundles, connections, env, images = new Map() }) {
  const external = requireWorkload(bundle);
  const { image, pinnedBy } = workloadImage(external, images);
  const name = bundle.name;
  const byName = new Map(bundles.map((b) => [b.name, b]));
  const ports = portsFor(byName.get(name), env).filter(isExposed);
  const job = external.runs === "job";
  const { rows, literal, bound, secrets } = podEnv(bundle, { byName, connections, env, kind: "kubernetes" });

  const container = {
    name,
    image,
    ...(external.entryPoint ? { command: [external.entryPoint] } : {}),
    ...(external.args?.length ? { args: [...external.args] } : {}),
    ...(ports.length ? { ports: ports.map((p) => ({ name: p.name, containerPort: p.listen })) } : {}),
    ...(rows.length ? { env: rows } : {}),
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
      // `port` is what a peer dials; `targetPort` is what the workload binds.
      spec: { selector: labels(), ports: ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.listen, appProtocol: p.appProtocol })) },
    });
  }

  const callers = connections.filter((c) => c.targets.some((t) => t.env === env && t.bundle === name)).map((c) => c.from);
  const header = headerOf({
    name, env, external, literal, bound, secrets, pinnedBy,
    what: `a ${job ? "Job" : "Deployment"}${ports.length ? " and a Service" : ""}`,
    tail: [`\`cloister cluster k8s\` admits only its declared callers: ${callers.length ? callers.join(", ") : "none"}.`],
  });
  return `${header}\n${objects.map((o) => stringifyYaml(o)).join("---\n")}`;
}

/**
 * One knative-placed bundle as a Knative Service.
 *
 * Knative serves one HTTP port per Service and dials it on 80, so the bundle
 * must expose exactly one port, dialled on 80 in this placement, speaking a
 * protocol Knative has a wire for. A job is not a Knative Service: it has no
 * requests to scale on.
 */
export function knativeWorkload(bundle, { bundles, connections, env, images = new Map() }) {
  const external = requireWorkload(bundle);
  const { image, pinnedBy } = workloadImage(external, images);
  const name = bundle.name;
  const where = `bundle "${name}"`;
  if (external.runs === "job") {
    throw new Error(`${where} runs = "job", and a Knative Service runs to serve requests. Place it kind = "kubernetes": it is lowered to a Job there`);
  }
  const byName = new Map(bundles.map((b) => [b.name, b]));
  const ports = portsFor(byName.get(name), env).filter(isExposed);
  if (ports.length !== 1) {
    throw new Error(`${where} exposes ${ports.length} ports; a Knative Service serves exactly one`);
  }
  const [port] = ports;
  const wires = Object.hasOwn(KNATIVE_WIRES, port.appProtocol) ? KNATIVE_WIRES[port.appProtocol] : [];
  if (wires.length === 0) {
    throw new Error(`${where} port "${port.name}" speaks "${port.appProtocol}", which Knative has no wire for; a Knative Service serves HTTP only`);
  }
  const { rows, literal, bound, secrets } = podEnv(bundle, { byName, connections, env, kind: "knative" });
  const container = {
    name,
    image,
    ...(external.entryPoint ? { command: [external.entryPoint] } : {}),
    ...(external.args?.length ? { args: [...external.args] } : {}),
    // Knative reads the wire from the port's name, and routes to this number.
    ports: [{ name: wires[0], containerPort: port.listen }],
    ...(rows.length ? { env: rows } : {}),
  };
  const service = {
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    // expose = "cluster" means no route from outside: Knative's own label for it.
    metadata: { name, namespace: name, labels: { [LABEL]: name, ...(port.expose === "edge" ? {} : { [KNATIVE_VISIBILITY_LABEL]: KNATIVE_CLUSTER_LOCAL }) } },
    spec: { template: { metadata: { labels: { [LABEL]: name } }, spec: { containers: [container] } } },
  };
  const header = headerOf({
    name, env, external, literal, bound, secrets, pinnedBy,
    what: "a Knative Service",
    tail: [
      `Peers dial it on port ${port.port}; its container listens on ${port.listen}.`,
      port.expose === "edge"
        ? "It has a route from outside the cluster (expose = \"edge\")."
        : `It has no route from outside the cluster (${KNATIVE_VISIBILITY_LABEL}: ${KNATIVE_CLUSTER_LOCAL}).`,
      "Inside the cluster nothing enforces which caller may reach it: that needs a mesh.",
    ],
  });
  return `${header}\n${stringifyYaml(service)}`;
}
