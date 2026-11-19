// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which compose container holds which socket directory (ADR-0075 §4.1).
//
// A bundle that declares `ipcSocket` binds a socket at that path. Under
// compose the socket is reachable by any container that mounts the directory
// it is in, and by no other. So the directory is the grant: `emit-compose`
// gives each socket directory its own volume and mounts it into
//
//   - every bundle that binds a socket in it, and
//   - every bundle with a wire to one of those bundles.
//
// Nothing else gets the mount. `graph.mjs` reads the same answer to say what
// holds a wire, so the emitter and the graph cannot disagree: there is one
// function, and both call it.
//
// What this does NOT settle, and the graph says so:
//
//   - Two bundles that bind in the SAME directory each hold the other's
//     socket. A wire to either is held only if every other holder is one of
//     its declared callers. Give a bundle a directory of its own to hold it.
//   - A declared caller that relays requests (the companion opens sockets for
//     the gateway) extends its reach to whoever can reach IT. That is the
//     relay's own edge, and it has its own row in the graph.

import { posix } from "node:path";

const external = (bundle) => (bundle?.kind && "external" in bundle.kind ? bundle.kind.external : null);

/** The socket a bundle binds, or "" when it binds none. */
export function socketOf(bundle) {
  return external(bundle)?.ipcSocket || "";
}

/**
 * The directory a socket path lives in.
 *
 * Refuses a path that names no directory to mount: a relative path (compose
 * would read it against a working directory this file does not know) and a
 * socket directly under `/` (the mount would replace the container's root).
 * Refuses a directory compose's mount syntax would misread.
 */
export function socketDir(socketPath, bundleName) {
  if (!posix.isAbsolute(socketPath)) {
    throw new Error(`bundle "${bundleName}": ipcSocket "${socketPath}" is not an absolute path, so there is no directory to mount for it`);
  }
  const dir = posix.dirname(posix.normalize(socketPath));
  if (dir === "/") {
    throw new Error(`bundle "${bundleName}": ipcSocket "${socketPath}" is directly under /, and a socket volume cannot be mounted over the container's root. Put it in a directory`);
  }
  // The directory goes into compose's `volume:path` mount line as written.
  // A colon, a space or a `#` there would be read as syntax.
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) {
    throw new Error(`bundle "${bundleName}": the directory of ipcSocket "${socketPath}" has a character a compose mount line cannot carry. Use letters, digits, ".", "_", "-" and "/"`);
  }
  return dir;
}

/** A compose volume name for a directory: readable, and unique per directory. */
function volumeNames(dirs) {
  const names = new Map();
  const taken = new Map();
  for (const dir of [...dirs].sort()) {
    const base = `uds${dir.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "")}`;
    const n = (taken.get(base) ?? 0) + 1;
    taken.set(base, n);
    names.set(dir, n === 1 ? base : `${base}-${n}`);
  }
  return names;
}

/**
 * Every socket directory in a cluster, with who binds in it and who holds it.
 *
 * @param {object} cluster a parsed cluster
 * @returns {Array<{dir: string, volume: string, binders: string[], holders: string[]}>}
 *   in directory order. `holders` is binders first, then callers, each in the
 *   order cluster.toml declares them.
 */
export function socketDirs(cluster) {
  const byDir = new Map();
  for (const b of cluster.bundles ?? []) {
    const socket = socketOf(b);
    if (!socket) continue;
    const dir = socketDir(socket, b.name);
    if (!byDir.has(dir)) byDir.set(dir, { dir, binders: [], callers: [] });
    byDir.get(dir).binders.push(b.name);
  }
  const containers = new Set((cluster.bundles ?? []).filter((b) => external(b)).map((b) => b.name));
  for (const entry of byDir.values()) {
    for (const w of cluster.wires ?? []) {
      // A source with no container of its own runs inside the gateway's
      // process: there is nothing to mount the directory into.
      if (!entry.binders.includes(w.to) || !containers.has(w.from)) continue;
      if (!entry.binders.includes(w.from) && !entry.callers.includes(w.from)) entry.callers.push(w.from);
    }
  }
  const volumes = volumeNames(byDir.keys());
  return [...byDir.values()]
    .sort((a, b) => (a.dir < b.dir ? -1 : 1))
    .map(({ dir, binders, callers }) => ({ dir, volume: volumes.get(dir), binders, holders: [...binders, ...callers] }));
}

/** The socket directories one bundle's container mounts, in directory order. */
export function socketMountsFor(bundleName, dirs) {
  return dirs.filter((d) => d.holders.includes(bundleName));
}

/**
 * Who can open a bundle's socket without a wire to it.
 *
 * @returns {{dir: string, callers: string[], undeclared: string[]} | null}
 *   null when the bundle binds no socket. `undeclared` is every holder of the
 *   directory that is neither the bundle itself nor one of its callers.
 */
export function socketExposure(cluster, bundleName, dirs = socketDirs(cluster)) {
  const entry = dirs.find((d) => d.binders.includes(bundleName));
  if (!entry) return null;
  const callers = [...new Set((cluster.wires ?? []).filter((w) => w.to === bundleName).map((w) => w.from))];
  const undeclared = entry.holders.filter((name) => name !== bundleName && !callers.includes(name));
  return { dir: entry.dir, callers: callers.filter((name) => entry.holders.includes(name)), undeclared };
}
