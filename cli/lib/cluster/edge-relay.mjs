// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/edge-relay.mjs — `expose = "edge"` for microvm placements in
// `cloister cluster up` (ADR-0069 §1, cloister-991e65).
//
// A port declared `expose = "edge"` is published on the HOST as TCP at
// 127.0.0.1:<port> — loopback only, never 0.0.0.0 — and every connection is
// relayed to that bundle's bind socket, the same §6 channel a declared
// connection reaches. `cluster` stays socket-only, `none` stays unreachable.
// On a developer machine "edge" means exactly this: anything on the host can
// reach the port, and `up` prints so.
//
// Boundary (ADR-0035): this is a small DATA-PLANE piece living in cloister's
// Node CLI, because `up` is a foreground convenience that already owns the
// channel directory and the runs' lifecycle (ADR-0071 §1). It carries bytes and
// makes no policy decision. LLO may absorb host publishing later (a published
// port beside the run it fronts); if it does, this module is deleted and `up`
// passes the declaration through instead.
//
// Lifecycle (ADR-0071 §1, `up`'s foreground rules):
//   - every edge port is RESERVED (bound and listening) before anything is
//     started. Binding is the check: a busy port fails with EADDRINUSE and is
//     refused by name, with no gap between "checked" and "bound". Nothing has
//     been started at that point, so nothing needs stopping.
//   - a connection that arrives before its bundle is bound is closed at once:
//     there is nothing to relay to yet.
//   - after the bundle is bound, `activate()` starts relaying.
//   - teardown closes every listener and live connection BEFORE the runs are
//     stopped. If `up` is killed, the OS closes its sockets.

import { createServer as netCreateServer, connect as netConnect } from "node:net";
import { join } from "node:path";

import { isExposed } from "./connections.mjs";

/** Host address of every edge listener. Loopback only, never all interfaces. */
export const EDGE_HOST = "127.0.0.1";

/** True when the port is published on the host by `up`. */
export function isEdge(port) {
  return port?.expose === "edge";
}

/**
 * The edge ports of the bundles `up` starts, with the bind socket each relays
 * to. Refuses two bundles publishing the same host port, by name.
 *
 * @param {object} cluster parsed cluster
 * @param {string[]} order bundles `up` starts
 * @param {string} channelDir
 * @returns {Array<{bundle: string, name: string, port: number, appProtocol: string, socketPath: string}>}
 */
export function edgePorts(cluster, order, channelDir) {
  const edges = [];
  const byPort = new Map();
  for (const bundle of order) {
    const ports = cluster.bundles.find((b) => b.name === bundle)?.ports ?? [];
    for (const p of ports.filter((x) => isExposed(x) && isEdge(x))) {
      const prior = byPort.get(p.port);
      if (prior) {
        throw new Error(
          `host port ${EDGE_HOST}:${p.port} is wanted by both ${prior.bundle}.${prior.name} and ` +
            `${bundle}.${p.name} (expose = "edge"); one host port can publish one bundle port`,
        );
      }
      const edge = {
        bundle,
        name: p.name,
        port: p.port,
        appProtocol: p.appProtocol,
        // The bundle's bind grant for this port (runtime-plan's naming).
        socketPath: join(channelDir, `${bundle}.${p.name}.sock`),
      };
      byPort.set(p.port, edge);
      edges.push(edge);
    }
  }
  return edges;
}

/** `edge: 127.0.0.1:3306 → dolt.mysql (art.mysql)` */
export function describeEdge(edge) {
  return `edge: ${EDGE_HOST}:${edge.port} → ${edge.bundle}.${edge.name} (${edge.appProtocol})`;
}

/**
 * Reserve every edge port, then return one controller per edge. If any port
 * cannot be bound, every listener already bound is closed and the refusal
 * names the port and the bundle that wanted it.
 *
 * @param {ReturnType<typeof edgePorts>} edges
 * @param {{createServer?: Function, connect?: Function, errLog?: (m: string) => void}} [deps]
 */
export async function openEdgeListeners(edges, deps = {}) {
  const createServer = deps.createServer ?? netCreateServer;
  const connect = deps.connect ?? netConnect;
  const errLog = deps.errLog ?? console.error;
  const listeners = [];
  try {
    for (const edge of edges) listeners.push(await listen(edge, { createServer, connect, errLog }));
  } catch (error) {
    await Promise.all(listeners.map((l) => l.close()));
    throw error;
  }
  return listeners;
}

async function listen(edge, { createServer, connect, errLog }) {
  let active = false;
  const live = new Set();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    live.add(client);
    client.on("close", () => live.delete(client));
    client.on("error", () => client.destroy()); // lint-allow-silent: a client reset ends only its own relay
    if (!active) {
      // Not bound yet: nothing to relay to. Close rather than hold.
      client.destroy();
      return;
    }
    const upstream = connect({ path: edge.socketPath, allowHalfOpen: true });
    live.add(upstream);
    upstream.on("close", () => { live.delete(upstream); client.destroy(); });
    upstream.on("error", (error) => {
      errLog(`cloister cluster up: ${describeEdge(edge)}: ${error.message}`);
      upstream.destroy();
    });
    client.on("close", () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        reject(new Error(
          `host port ${EDGE_HOST}:${edge.port} is already in use, and bundle "${edge.bundle}" ` +
            `port "${edge.name}" (expose = "edge") publishes on it. Nothing was started. ` +
            `Find what holds it: lsof -nP -iTCP:${edge.port} -sTCP:LISTEN`,
        ));
      } else {
        reject(new Error(`could not publish ${describeEdge(edge)}: ${error.message}`));
      }
    };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: EDGE_HOST, port: edge.port, exclusive: true });
  });
  server.on("error", (error) => errLog(`cloister cluster up: ${describeEdge(edge)}: ${error.message}`));
  return {
    edge,
    address: () => server.address(),
    activate: () => { active = true; },
    close: () => new Promise((resolve) => {
      active = false;
      for (const s of live) s.destroy();
      server.close(() => resolve());
    }),
  };
}
