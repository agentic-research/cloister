// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which compose container is on which network (ADR-0075 §6).
//
// A wire to a bundle with no socket is carried over HTTP, to the target's
// service name. Under compose that name resolves, and the port answers, for
// any container on a network the target is on. So the network is the grant:
// `emit-compose` gives each such wire a network of its own, attaches its two
// ends, and attaches nothing else. No container is left on compose's
// `default` network, which every service otherwise shares.
//
// `graph.mjs` reads the same plan to say what holds the wire, so the emitter
// and the graph cannot describe different files.
//
// What this does NOT settle, and the graph says so:
//
//   - A network joins its two ends BOTH ways. The target can reach its
//     caller's ports as well.
//   - A container that shares another's network namespace is on every
//     network that one is on. It can reach what its host can.
//   - A target inside its caller's namespace is reached at 127.0.0.1. Who
//     else reaches it depends on the address it listens on, which compose
//     does not constrain.
//
// Published ports are the other half. A port published on every interface is
// reachable from every container through the host's address, whatever
// network it is on, so the emitter publishes on 127.0.0.1 only.

import { COMPOSE_ENV, URL_SCHEMES, checkableBundle, normalizeConnections, portsFor } from "./connections.mjs";
import { namespaceHosts } from "./compose-placement.mjs";
import { bundleServices, socketOf } from "./socket-dirs.mjs";

/** The host address every published port is bound to. */
export const PUBLISH_ADDRESS = "127.0.0.1";

/**
 * One entry of a compose `ports:` list: a container port published on the
 * host's loopback. `init --port` rewrites the host half, so it builds the
 * text to look for from this and cannot drift from what the emitter writes.
 */
export function publishedPort(hostPort, containerPort) {
  return `"${PUBLISH_ADDRESS}:${hostPort}:${containerPort}"`;
}

/**
 * The ports of a bundle that compose publishes on the host: those it
 * declares with `expose = "edge"`, the one value that means "also from
 * outside" (ADR-0069 §2). `httpPort` alone publishes nothing: it is where a
 * wire reaches the bundle, and says nothing about the host.
 */
export function edgePortsOf(bundle) {
  return (bundle?.ports ?? []).filter((p) => p.expose === "edge").map((p) => ({ name: p.name, port: p.port }));
}

const external = (bundle) => (bundle?.kind && "external" in bundle.kind ? bundle.kind.external : null);

/**
 * How a wire to an HTTP port is carried.
 *
 *   network      its own network, joining the two ends
 *   namespace    the target is inside its caller's namespace: 127.0.0.1
 *   unaddressed  compose hands the source a name no container answers to
 */
function httpEdge(wire, bundles, services, hosts) {
  const source = bundles.get(wire.from);
  const target = bundles.get(wire.to);
  const port = external(target)?.httpPort ?? 0;
  if (!external(source) || !external(target) || socketOf(target) || !(port > 0)) return null;
  const base = { from: wire.from, to: wire.to, binding: wire.binding, port };
  if ((hosts.get(wire.to) ?? "") === wire.from) {
    return { ...base, kind: "namespace", address: `http://127.0.0.1:${port}` };
  }
  const address = `http://${wire.to}:${port}`;
  if (hosts.has(wire.to)) {
    return { ...base, kind: "unaddressed", address, reason: `"${wire.to}" runs inside "${hosts.get(wire.to)}"'s network namespace and has no name of its own on any network` };
  }
  if (services.get(wire.to).length !== 1 || services.get(wire.to)[0] !== wire.to) {
    return { ...base, kind: "unaddressed", address, reason: `"${wire.to}" runs as one container per tenant, and none of them answers to the bundle's name` };
  }
  return { ...base, kind: "network", address };
}

/**
 * How a `[[connections]]` row is carried between two compose bundles
 * (ADR-0075 §7): the same network of two ends a wire over HTTP gets, to the
 * target's service name and the number of the port the connection names.
 *
 *   network      its own network, joining the two ends
 *   unjoined     an end is not a compose service, so there is nothing to join
 *   unaddressed  the target has no name of its own on any network
 *
 * Null when the connection has no target in the compose env: it is another
 * placement's to lower.
 */
function connectionEdge(c, env, bundles, services, hosts) {
  const target = c.targets.find((t) => t.env === env);
  if (!target) return null;
  const base = { from: c.from, to: target.bundle, connection: c.name, declaredAs: "connection", appProtocol: c.appProtocol, minStrength: c.minStrength, portName: target.port };
  const missing = [c.from, target.bundle].find((name) => !services.has(name));
  if (missing) return { ...base, kind: "unjoined", missing, reason: `"${missing}" is not a compose service` };
  const port = portsFor(checkableBundle(bundles.get(target.bundle)), env).find((p) => p.name === target.port)?.port;
  const scheme = URL_SCHEMES[c.appProtocol] ?? "";
  const edge = { ...base, port, hostPort: `${target.bundle}:${port}`, address: scheme ? `${scheme}://${target.bundle}:${port}` : "" };
  if (hosts.has(target.bundle)) {
    return { ...edge, kind: "unaddressed", reason: `"${target.bundle}" runs inside "${hosts.get(target.bundle)}"'s network namespace and has no name of its own on any network` };
  }
  if (services.get(target.bundle).length !== 1 || services.get(target.bundle)[0] !== target.bundle) {
    return { ...edge, kind: "unaddressed", reason: `"${target.bundle}" runs as one container per tenant, and none of them answers to the bundle's name` };
  }
  return { ...edge, kind: "network" };
}

/**
 * Every network a compose cluster needs, and who is on each.
 *
 * @param {object} cluster a parsed cluster
 * @returns {{
 *   networks: Array<{name: string, members: string[], for: string}>,
 *   edges: Array<object>,
 *   sharing: Map<string, string>,
 * }}
 *   `networks` is in name order. `sharing` maps a service to the service
 *   whose namespace it joins. A service that shares a namespace is a member
 *   of no network: it is on its host's.
 */
export function networkPlan(cluster, env = COMPOSE_ENV) {
  const bundles = new Map((cluster.bundles ?? []).map((b) => [b.name, b]));
  const services = bundleServices(cluster);
  // Which bundle's namespace each bundle joins: declared on its compose
  // placement (ADR-0075 section 8). A name that is not a service here joins
  // nothing: `assertNamespaces` refuses that cluster before it gets this far.
  const hosts = new Map([...namespaceHosts(cluster, env)].filter(([name, host]) => services.has(name) && services.has(host)));
  const sharing = new Map();
  for (const [name, host] of hosts) {
    for (const service of services.get(name)) sharing.set(service, host);
  }
  // The services whose namespace a bundle's containers are really in.
  const attachPoints = (name) => [...new Set(services.get(name).map((service) => sharing.get(service) ?? service))];

  const edges = [];
  const pairs = new Map();
  for (const wire of cluster.wires ?? []) {
    const edge = httpEdge(wire, bundles, services, hosts);
    if (!edge) continue;
    edges.push(edge);
    if (edge.kind !== "network") continue;
    const key = JSON.stringify([wire.from, wire.to]);
    if (!pairs.has(key)) pairs.set(key, { from: wire.from, to: wire.to, members: [...new Set([...attachPoints(wire.from), wire.to])] });
  }
  // A connection between two compose bundles is the same statement as a wire
  // over HTTP, so it is carried the same way, and a wire and a connection
  // between one pair of bundles share the one network.
  for (const c of normalizeConnections(cluster.connections ?? [])) {
    const edge = connectionEdge(c, env, bundles, services, hosts);
    if (!edge) continue;
    edges.push(edge);
    if (edge.kind !== "network") continue;
    const key = JSON.stringify([edge.from, edge.to]);
    if (!pairs.has(key)) pairs.set(key, { from: edge.from, to: edge.to, members: [...new Set([...attachPoints(edge.from), edge.to])] });
  }

  // Readable names, unique per pair: "a-b" + "c" and "a" + "b-c" would
  // otherwise both be "wire-a-b-c".
  const taken = new Map();
  const networks = [];
  for (const key of [...pairs.keys()].sort()) {
    const pair = pairs.get(key);
    const base = `wire-${pair.from}-${pair.to}`;
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    pair.name = n === 1 ? base : `${base}-${n}`;
    networks.push({ name: pair.name, members: pair.members, for: `${pair.from} → ${pair.to}` });
  }
  for (const edge of edges) {
    if (edge.kind === "network") edge.network = pairs.get(JSON.stringify([edge.from, edge.to])).name;
  }

  // A service on no wire network still needs one, or compose puts it on
  // `default` with every other such service.
  const attached = new Set(networks.flatMap((n) => n.members));
  for (const own of services.values()) {
    for (const service of own) {
      if (sharing.has(service) || attached.has(service)) continue;
      networks.push({ name: `solo-${service}`, members: [service], for: `${service} alone` });
    }
  }
  networks.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { env, networks, edges, sharing, hosts };
}

/** The networks one service is attached to, in name order. */
export function networksFor(service, plan) {
  return plan.networks.filter((n) => n.members.includes(service)).map((n) => n.name);
}

/** How the wire is carried over HTTP, or null when it is not an HTTP wire. */
export function httpEdgeOf(wire, plan) {
  return plan.edges.find((e) => e.declaredAs !== "connection" && e.from === wire.from && e.to === wire.to && e.binding === wire.binding) ?? null;
}

/** How a bundle's connection is carried in the compose env, or null when it has no target there. */
export function connectionEdgeOf(from, name, plan) {
  return plan.edges.find((e) => e.declaredAs === "connection" && e.from === from && e.connection === name) ?? null;
}

/**
 * Who is on a wire's network besides its two ends: every service that shares
 * the namespace of a member and is not itself an end.
 */
export function networkExposure(edge, plan, services) {
  const network = plan.networks.find((n) => n.name === edge.network);
  const ends = new Set([...(services.get(edge.from) ?? []), ...(services.get(edge.to) ?? [])]);
  const undeclared = [...plan.sharing].filter(([service, host]) => network.members.includes(host) && !ends.has(service)).map(([service]) => service);
  return { network: network.name, members: network.members, undeclared };
}
