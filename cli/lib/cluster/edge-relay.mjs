// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/edge-relay.mjs — `expose = "edge"` for microvm placements in
// `cloister cluster up` (ADR-0069 §2, cloister-991e65).
//
// A port declared `expose = "edge"` is published on the HOST as TCP at
// 127.0.0.1:<port> — loopback only, never 0.0.0.0 — and every connection is
// relayed to that bundle's bind socket, the same §6 channel a declared
// connection reaches. `cluster` stays socket-only, `none` stays unreachable.
// On a developer machine "edge" means exactly this: any local user or process
// on the host can reach the port, and `up` prints so.
//
// Boundary (ADR-0035): this is a small DATA-PLANE piece living in cloister's
// Node CLI, because `up` is a foreground convenience that already owns the
// channel directory and the runs' lifecycle (ADR-0071 §1). It carries bytes and
// makes no policy decision. It is interim; replaced by LLO's publish channel
// (ley-line-open-797917, cloister-79bdeb): LLO will carry host publishing as a
// connections/v1 `publish` channel beside the run it fronts, this module is
// deleted, and `up` passes the declaration through instead.
//
// Lifecycle (ADR-0071 §1, `up`'s foreground rules):
//   - every edge port is RESERVED before anything is started. Each port is
//     first probed on every address (0.0.0.0 and [::], exclusive), because on
//     macOS a loopback bind succeeds even while the same user listens on a
//     wildcard address, and would silently take the port from that holder.
//     Then it is bound on loopback. A busy port is refused by name. A holder
//     that appears on a wildcard address between the probe and the bind is NOT
//     detected. Nothing has been started at that point, so nothing needs
//     stopping.
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

function busyError(edge) {
  return new Error(
    `host port ${EDGE_HOST}:${edge.port} is already in use, and bundle "${edge.bundle}" ` +
      `port "${edge.name}" (expose = "edge") publishes on it. Nothing was started. ` +
      `Find what holds it: lsof -nP -iTCP:${edge.port} -sTCP:LISTEN`,
  );
}

/** Bind-and-release one probe. Resolves null if free, else the error. */
function probeBind(createServer, listenOptions) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error) => resolve(error));
    probe.listen({ ...listenOptions, exclusive: true }, () => probe.close(() => resolve(null)));
  });
}

/**
 * Refuse a port some other listener holds on a wildcard address. Loopback bind
 * alone cannot see those on macOS (SO_REUSEADDR).
 */
async function assertNotHeld(edge, createServer) {
  const v4 = await probeBind(createServer, { host: "0.0.0.0", port: edge.port });
  if (v4) {
    if (v4.code === "EADDRINUSE") throw busyError(edge);
    throw new Error(`could not probe ${describeEdge(edge)} on 0.0.0.0 (${v4.code ?? "error"}): ${v4.message}`);
  }
  const v6 = await probeBind(createServer, { host: "::", port: edge.port, ipv6Only: true });
  if (v6) {
    if (v6.code === "EADDRINUSE") throw busyError(edge);
    if (v6.code === "EADDRNOTAVAIL" || v6.code === "EAFNOSUPPORT") return; // no IPv6 on this host
    throw new Error(`could not probe ${describeEdge(edge)} on :: (${v6.code ?? "error"}): ${v6.message}`);
  }
}

async function listen(edge, { createServer, connect, errLog }) {
  await assertNotHeld(edge, createServer);
  let active = false;
  let failures = 0; // upstream-connect failures not yet summarised
  let lastLogged = 0;
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
      const now = Date.now();
      if (lastLogged === 0) {
        errLog(`cloister cluster up: ${describeEdge(edge)}: ${error.message}`);
        lastLogged = now;
      } else {
        failures += 1;
        if (now - lastLogged >= 5_000) {
          errLog(`cloister cluster up: ${describeEdge(edge)}: ${failures} more upstream connect failures`);
          failures = 0;
          lastLogged = now;
        }
      }
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
        reject(busyError(edge));
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
