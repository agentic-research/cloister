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
// A `perTenant` bundle runs one container per tenant. Each binds its socket in
// a directory of that tenant's own, `<dir>/<tenant>/<file>`, so one tenant's
// instance holds no other tenant's socket.
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
 * The tenant instances a `perTenant` bundle fans out to: every
 * `tenantDispatch` row whose binding is the binding of a wire to the bundle,
 * in dispatch-table order. Empty when no row matches, in which case the
 * bundle runs as one container (lint Inv 8 and Inv 9 refuse that cluster
 * before it gets here).
 *
 * One wire whose binding several rows share yields several tenants. So does
 * one wire and one row per tenant.
 */
export function tenantInstances(bundleName, cluster) {
  const incoming = new Set((cluster.wires ?? []).filter((w) => w.to === bundleName).map((w) => w.binding));
  if (incoming.size === 0) return [];
  const rows = [];
  for (const route of cluster.routes ?? []) {
    if (!("tenantDispatch" in route.kind)) continue;
    for (const row of route.kind.tenantDispatch.tenants) {
      if (incoming.has(row.binding)) rows.push(row);
    }
  }
  return rows;
}

/**
 * Where one tenant's instance binds: the bundle's socket file, in a directory
 * named for the tenant inside the bundle's socket directory.
 *
 *   /run/cloister-uds/app/app.sock + "alice" → /run/cloister-uds/app/alice/app.sock
 *
 * A directory per tenant, and not a file name per tenant in one directory,
 * because under compose the directory is what is mounted: tenants that share
 * one can open each other's sockets.
 */
export function tenantSocketPath(baseSocket, tenantName, bundleName) {
  const dir = socketDir(baseSocket, bundleName);
  if (!/^[A-Za-z0-9._-]+$/.test(tenantName) || tenantName === "." || tenantName === "..") {
    throw new Error(`bundle "${bundleName}": tenant "${tenantName}" cannot name a socket directory. Use letters, digits, ".", "_" and "-"`);
  }
  return posix.join(dir, tenantName, posix.basename(baseSocket));
}

/**
 * The one tenant a wire reaches, or null.
 *
 * A wire whose binding is the binding of exactly one dispatch row reaches
 * that tenant. A binding several rows share reaches no one tenant: the source
 * is handed the bundle's declared socket, and what answers there is the
 * operator's dispatch.
 */
function tenantOfWire(wire, cluster) {
  let matched = null;
  for (const route of cluster.routes ?? []) {
    if (!("tenantDispatch" in route.kind)) continue;
    for (const row of route.kind.tenantDispatch.tenants) {
      if (row.binding !== wire.binding) continue;
      if (matched) return null;
      matched = row;
    }
  }
  return matched;
}

/**
 * Everything compose needs to know about sockets, worked out once.
 *
 * Holders are compose SERVICES. A bundle is one service under its own name;
 * a `perTenant` bundle with tenants is one service per tenant, named
 * `<bundle>-<tenant>`.
 *
 * @param {object} cluster a parsed cluster
 * @returns {{
 *   dirs: Array<{dir: string, volume: string, holders: string[]}>,
 *   binds: Array<{service: string, bundle: string, tenant: string, path: string, dir: string}>,
 *   dials: Array<{service: string, from: string, to: string, binding: string, path: string, dir: string}>,
 * }}
 *   `binds` is every socket a service binds. `dials` is every socket path a
 *   wire hands its source, one row per service of the source. `dirs` is in
 *   directory order, holders in the order cluster.toml declares them, binders
 *   before callers.
 */
export function socketPlan(cluster) {
  const bundles = new Map((cluster.bundles ?? []).map((b) => [b.name, b]));
  const tenantsOf = new Map();
  for (const b of cluster.bundles ?? []) {
    tenantsOf.set(b.name, external(b) && b.perTenant === true ? tenantInstances(b.name, cluster) : []);
  }
  const servicesOf = (name) => {
    const tenants = tenantsOf.get(name) ?? [];
    return tenants.length ? tenants.map((t) => `${name}-${t.name}`) : [name];
  };

  const binds = [];
  for (const b of cluster.bundles ?? []) {
    const socket = socketOf(b);
    if (!socket) continue;
    const tenants = tenantsOf.get(b.name);
    if (tenants.length === 0) {
      binds.push({ service: b.name, bundle: b.name, tenant: "", path: socket, dir: socketDir(socket, b.name) });
      continue;
    }
    for (const t of tenants) {
      const path = tenantSocketPath(socket, t.name, b.name);
      binds.push({ service: `${b.name}-${t.name}`, bundle: b.name, tenant: t.name, path, dir: posix.dirname(path) });
    }
  }

  const dials = [];
  for (const w of cluster.wires ?? []) {
    const target = bundles.get(w.to);
    const socket = socketOf(target);
    // A source with no container of its own runs inside the gateway's
    // process: there is nothing to mount a directory into.
    if (!socket || !external(bundles.get(w.from))) continue;
    const tenant = tenantsOf.get(w.to).length ? tenantOfWire(w, cluster) : null;
    const path = tenant ? tenantSocketPath(socket, tenant.name, w.to) : socket;
    for (const service of servicesOf(w.from)) {
      dials.push({ service, from: w.from, to: w.to, binding: w.binding, path, dir: socketDir(path, w.to) });
    }
  }

  const holders = new Map();
  for (const row of [...binds, ...dials]) {
    if (!holders.has(row.dir)) holders.set(row.dir, []);
    if (!holders.get(row.dir).includes(row.service)) holders.get(row.dir).push(row.service);
  }
  const volumes = volumeNames(holders.keys());
  const dirs = [...holders.keys()].sort().map((dir) => ({ dir, volume: volumes.get(dir), holders: holders.get(dir) }));
  return { dirs, binds, dials };
}

/** The socket directories one service's container mounts, in directory order. */
export function socketMountsFor(service, plan) {
  return plan.dirs.filter((d) => d.holders.includes(service));
}

/** The socket path a wire hands its source, or "" when the target binds none. */
export function dialPath(wire, plan) {
  return plan.dials.find((d) => d.from === wire.from && d.to === wire.to && d.binding === wire.binding)?.path ?? "";
}

/** Where a service binds its socket, or "" when it binds none. */
export function bindPath(service, plan) {
  return plan.binds.find((b) => b.service === service)?.path ?? "";
}

/**
 * Who can open the socket a wire dials.
 *
 * @returns {{path: string, dir: string, bound: string[], callers: string[], undeclared: string[]} | null}
 *   null when the wire dials no socket. `bound` is the services that bind
 *   exactly this path (empty when nothing does). `callers` is the services a
 *   wire hands this path. `undeclared` is every other service that mounts the
 *   directory: it binds another socket there, or dials one.
 */
export function socketExposure(wire, plan) {
  const path = dialPath(wire, plan);
  if (!path) return null;
  const dir = posix.dirname(path);
  const bound = plan.binds.filter((b) => b.path === path).map((b) => b.service);
  const callers = [...new Set(plan.dials.filter((d) => d.path === path).map((d) => d.service))];
  const holding = plan.dirs.find((d) => d.dir === dir)?.holders ?? [];
  const undeclared = holding.filter((service) => !bound.includes(service) && !callers.includes(service));
  return { path, dir, bound, callers, undeclared };
}
