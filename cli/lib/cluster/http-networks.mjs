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
 * The bundle whose network namespace a bundle's container joins, or "".
 *
 * One bundle does today, by name: mache runs inside the gateway's namespace
 * and is reached at 127.0.0.1. This is the rule `emit-compose` has always
 * applied, stated in one place so the graph can read it. It is a special case
 * by name and is not a model for others; a bundle cannot ask for it.
 */
export function namespaceHost(bundle) {
  return bundle?.name === "mache" ? "cloister-router" : "";
}

/**
 * How a wire to an HTTP port is carried.
 *
 *   network      its own network, joining the two ends
 *   namespace    the target is inside its caller's namespace: 127.0.0.1
 *   unaddressed  compose hands the source a name no container answers to
 */
function httpEdge(wire, bundles, services) {
  const source = bundles.get(wire.from);
  const target = bundles.get(wire.to);
  const port = external(target)?.httpPort ?? 0;
  if (!external(source) || !external(target) || socketOf(target) || !(port > 0)) return null;
  const base = { from: wire.from, to: wire.to, binding: wire.binding, port };
  if (namespaceHost(target) === wire.from) {
    return { ...base, kind: "namespace", address: `http://127.0.0.1:${port}` };
  }
  const address = `http://${wire.to}:${port}`;
  if (namespaceHost(target)) {
    return { ...base, kind: "unaddressed", address, reason: `"${wire.to}" runs inside "${namespaceHost(target)}"'s network namespace and has no name of its own on any network` };
  }
  if (services.get(wire.to).length !== 1 || services.get(wire.to)[0] !== wire.to) {
    return { ...base, kind: "unaddressed", address, reason: `"${wire.to}" runs as one container per tenant, and none of them answers to the bundle's name` };
  }
  return { ...base, kind: "network", address };
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
export function networkPlan(cluster) {
  const bundles = new Map((cluster.bundles ?? []).map((b) => [b.name, b]));
  const services = bundleServices(cluster);
  const sharing = new Map();
  for (const [name, own] of services) {
    const host = namespaceHost(bundles.get(name));
    if (host) for (const service of own) sharing.set(service, host);
  }
  // The services whose namespace a bundle's containers are really in.
  const attachPoints = (name) => [...new Set(services.get(name).map((service) => sharing.get(service) ?? service))];

  const edges = [];
  const pairs = new Map();
  for (const wire of cluster.wires ?? []) {
    const edge = httpEdge(wire, bundles, services);
    if (!edge) continue;
    edges.push(edge);
    if (edge.kind !== "network") continue;
    const key = JSON.stringify([wire.from, wire.to]);
    if (!pairs.has(key)) pairs.set(key, { from: wire.from, to: wire.to, members: [...new Set([...attachPoints(wire.from), wire.to])] });
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
  return { networks, edges, sharing };
}

/** The networks one service is attached to, in name order. */
export function networksFor(service, plan) {
  return plan.networks.filter((n) => n.members.includes(service)).map((n) => n.name);
}

/** How the wire is carried over HTTP, or null when it is not an HTTP wire. */
export function httpEdgeOf(wire, plan) {
  return plan.edges.find((e) => e.from === wire.from && e.to === wire.to && e.binding === wire.binding) ?? null;
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
