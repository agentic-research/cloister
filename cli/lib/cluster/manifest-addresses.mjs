// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/manifest-addresses.mjs — the in-cluster addresses a
// forwarded manifest's containers are told to dial (ADR-0070 §2, issue #311).
//
// A workload learns where its peers are from strings the operator wrote: an
// env var, a command-line argument. Those strings are the manifest's own claim
// about the graph, and `cluster.toml` is the declared one. This module finds
// the addresses; emit-k8s.mjs holds them to the declarations.
//
// It reads addresses, not URLs. `http://orders.shop.svc`, a bare
// `dolt.dolt.svc.cluster.local:3306` and a DSN such as
// `root@tcp(dolt.dolt.svc:3306)/shop` all name a host, and the scheme is not
// what makes an edge. A value is never printed or returned whole: it may hold
// a password. Only the host and port that were recognised leave this module.

/**
 * A Kubernetes object is identified by its API GROUP and kind, never by kind
 * alone: `Service` is a core object and also a Knative one, and the two share
 * nothing but the word. The version is not part of identity.
 */
export const groupOf = (apiVersion) => {
  const slash = apiVersion.lastIndexOf("/");
  return slash === -1 ? "" : apiVersion.slice(0, slash);
};
export const isObject = (obj, id) => obj.kind === id.kind && groupOf(obj.apiVersion) === id.group;

const POD_TEMPLATE = Object.freeze(["spec", "template", "spec"]);

/**
 * The objects that carry a pod spec, and where it is. Data, so a workload
 * kind this does not know is an entry to add, and an unknown one is simply
 * not read: its addresses are not checked, and nothing is assumed about them.
 */
export const WORKLOADS = Object.freeze([
  { group: "", kind: "Pod", path: ["spec"] },
  { group: "apps", kind: "Deployment", path: POD_TEMPLATE },
  { group: "apps", kind: "StatefulSet", path: POD_TEMPLATE },
  { group: "apps", kind: "DaemonSet", path: POD_TEMPLATE },
  { group: "apps", kind: "ReplicaSet", path: POD_TEMPLATE },
  { group: "batch", kind: "Job", path: POD_TEMPLATE },
  { group: "batch", kind: "CronJob", path: ["spec", "jobTemplate", "spec", "template", "spec"] },
  { group: "serving.knative.dev", kind: "Service", path: POD_TEMPLATE },
]);

const at = (obj, path) => path.reduce((o, key) => (o && typeof o === "object" ? o[key] : undefined), obj);
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Every literal string a container is started with: env values, args and
 * command, for containers and initContainers. An env entry with `valueFrom`
 * (a Secret, a ConfigMap, a field) has no literal here and is not read; nor
 * is `envFrom`.
 *
 * @returns {Array<{container: string, where: string, value: string}>}
 */
export function containerStrings(objects) {
  const out = [];
  for (const obj of objects) {
    const workload = WORKLOADS.find((id) => isObject(obj, id));
    if (!workload) continue;
    const pod = at(obj, workload.path);
    for (const c of [...list(pod?.initContainers), ...list(pod?.containers)]) {
      if (!c || typeof c !== "object") continue;
      const container = typeof c.name === "string" ? c.name : "";
      for (const e of list(c.env)) {
        if (e && typeof e.name === "string" && typeof e.value === "string") out.push({ container, where: `env ${e.name}`, value: e.value });
      }
      for (const key of ["command", "args"]) {
        for (const value of list(c[key])) if (typeof value === "string") out.push({ container, where: key, value });
      }
    }
  }
  return out;
}

/** The port a scheme means when the address states none. Others have no default here. */
const SCHEME_PORTS = Object.freeze({ http: 80, ws: 80, https: 443, wss: 443 });

const HOST = /[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/g;
const PORT_AFTER = /^:(\d{1,5})(?![\d@])/;
const USERINFO_AFTER = /^(?::[^/\s@]*)?@/;
const SCHEME_BEFORE = /([a-z][a-z0-9+.-]*):\/\/(?:[^/\s@]*@)?$/;

/**
 * Every host-shaped token in `value`, with the port it is given.
 *
 * `hostPosition` is true when the text around the token says it is a host: a
 * scheme before it (`scheme://`, with or without userinfo), an `@` before it
 * (unless a `(` follows, as in a `user@tcp(host)` DSN), or a `:port` after it. A short name such as `orders` is only treated as an
 * address in host position, because the same word may be a database or a user.
 * A token followed by `@`, with or without a `:password`, is a user and is
 * skipped.
 *
 * @returns {Array<{host: string, port: number | null, hostPosition: boolean}>}
 */
export function addressesIn(value) {
  const text = value.toLowerCase();
  const out = [];
  for (const match of text.matchAll(HOST)) {
    const host = match[0];
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + host.length);
    // `user@host` or `user:password@host`: this token is the user.
    if (USERINFO_AFTER.test(after)) continue;
    const stated = PORT_AFTER.exec(after);
    const scheme = SCHEME_BEFORE.exec(before);
    const schemePort = scheme && Object.hasOwn(SCHEME_PORTS, scheme[1]) ? SCHEME_PORTS[scheme[1]] : null;
    out.push({
      host,
      port: stated ? Number(stated[1]) : schemePort,
      // `user@tcp(host:3306)`: the word before "(" is a transport, not a host.
      hostPosition: Boolean(stated || scheme || (before.endsWith("@") && !after.startsWith("("))),
    });
  }
  return out;
}

const CLUSTER_SUFFIXES = Object.freeze([".svc.cluster.local", ".svc"]);

/**
 * `{service, namespace}` when `host` is a cluster DNS name for a Service
 * (`<service>.<namespace>.svc[.cluster.local]`), else null.
 */
export function clusterService(host) {
  const suffix = CLUSTER_SUFFIXES.find((s) => host.endsWith(s));
  if (!suffix) return null;
  const labels = host.slice(0, -suffix.length).split(".");
  return labels.length === 2 && labels.every((l) => l !== "") ? { service: labels[0], namespace: labels[1] } : null;
}
