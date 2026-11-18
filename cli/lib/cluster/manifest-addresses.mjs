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
// what makes an edge. A value is never printed: it may hold a password, and a
// Secret in the manifest is read here for the address in it. Only the host and
// port that were recognised reach a message.

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

const CONFIG_MAP = Object.freeze({ group: "", kind: "ConfigMap" });
const SECRET = Object.freeze({ group: "", kind: "Secret" });
const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The string entries of a ConfigMap or Secret. A Secret's `stringData` wins over its base64 `data`, as it does in the API. */
function entriesOf(obj) {
  const out = new Map();
  const put = (table, decode) => {
    for (const [key, value] of Object.entries(isTable(table) ? table : {})) {
      if (typeof value === "string") out.set(key, decode(value));
    }
  };
  if (isObject(obj, SECRET)) {
    put(obj.data, (v) => Buffer.from(v, "base64").toString("utf8"));
    put(obj.stringData, (v) => v);
  } else {
    put(obj.data, (v) => v);
  }
  return out;
}

/** A variable reference: a dollar sign, an optional second one (the escape), then a parenthesised name. */
const VARIABLE = /\$(\$?)\(([^)]+)\)/g;

/** A reference expands from the variables defined so far. The escaped form is the literal reference. An unknown name is left as written. */
function expand(text, env) {
  return text.replace(VARIABLE, (whole, escaped, name) => {
    if (escaped) return whole.slice(1);
    return env.has(name) ? env.get(name).value : whole;
  });
}

/**
 * The strings a container actually starts with, resolved the way Kubernetes
 * resolves them. Only the value that wins is one the container can dial, so
 * the order matters:
 *
 *   1. `envFrom`: every key of each ConfigMap or Secret, in order, a later
 *      source overriding an earlier one.
 *   2. `env`: each entry overrides anything before it of the same name. An
 *      entry is a literal `value`, or a `valueFrom` reference to one key of a
 *      ConfigMap or Secret.
 *   3. A variable reference in an env value expands from the variables
 *      defined before it; in `args` and `command` it expands from the whole
 *      result.
 *
 * A ConfigMap or Secret is read only if it is an object in the same manifest.
 * A reference to one that is not there cannot be resolved: it is returned in
 * `unread`, and it still overrides, so an earlier value of that name is
 * dropped, never reported as the one in effect. A `valueFrom` that is not a
 * ConfigMap or Secret key (a field, a resource) holds no address.
 *
 * @returns {{strings: Array<{container: string, where: string, value: string}>,
 *            unread: Array<{container: string, where: string, kind: string, name: string}>}}
 */
export function containerStrings(objects) {
  const strings = [];
  const unread = [];
  const find = (id, name, namespace) =>
    objects.find((o) => isObject(o, id) && o.metadata?.name === name
      && (o.metadata?.namespace === undefined || namespace === undefined || o.metadata.namespace === namespace));

  for (const obj of objects) {
    const workload = WORKLOADS.find((id) => isObject(obj, id));
    if (!workload) continue;
    const pod = at(obj, workload.path);
    const namespace = obj.metadata?.namespace;
    for (const c of [...list(pod?.initContainers), ...list(pod?.containers)]) {
      if (!isTable(c)) continue;
      const container = typeof c.name === "string" ? c.name : "";
      const env = new Map();
      const source = (ref, where) => {
        const id = ref.kind === "Secret" ? SECRET : CONFIG_MAP;
        const found = typeof ref.name === "string" ? find(id, ref.name, namespace) : undefined;
        if (!found) unread.push({ container, where, kind: ref.kind, name: String(ref.name ?? "") });
        return found ? entriesOf(found) : null;
      };

      for (const from of list(c.envFrom)) {
        const ref = isTable(from?.secretRef) ? { kind: "Secret", name: from.secretRef.name }
          : isTable(from?.configMapRef) ? { kind: "ConfigMap", name: from.configMapRef.name } : null;
        if (!ref) continue;
        const prefix = typeof from.prefix === "string" ? from.prefix : "";
        for (const [key, value] of source(ref, "envFrom") ?? []) {
          env.set(prefix + key, { value, where: `env ${prefix + key} (${ref.kind} ${JSON.stringify(ref.name)})` });
        }
      }
      for (const e of list(c.env)) {
        if (!isTable(e) || typeof e.name !== "string") continue;
        // Whatever this entry turns out to be, it replaces an earlier one.
        env.delete(e.name);
        if (typeof e.value === "string") {
          env.set(e.name, { value: expand(e.value, env), where: `env ${e.name}` });
          continue;
        }
        const keyRef = isTable(e.valueFrom?.secretKeyRef) ? { ...e.valueFrom.secretKeyRef, kind: "Secret" }
          : isTable(e.valueFrom?.configMapKeyRef) ? { ...e.valueFrom.configMapKeyRef, kind: "ConfigMap" } : null;
        if (!keyRef) continue;
        const value = source(keyRef, `env ${e.name}`)?.get(keyRef.key);
        if (typeof value === "string") {
          env.set(e.name, { value, where: `env ${e.name} (${keyRef.kind} ${JSON.stringify(keyRef.name)} key ${JSON.stringify(keyRef.key)})` });
        }
      }

      for (const { value, where } of env.values()) strings.push({ container, where, value });
      for (const key of ["command", "args"]) {
        for (const value of list(c[key])) if (typeof value === "string") strings.push({ container, where: key, value: expand(value, env) });
      }
    }
  }
  return { strings, unread };
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
