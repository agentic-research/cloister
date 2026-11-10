// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/connections.mjs — declared ports + connections
// (ADR-0069 §1–2) and their microvm lowering (ADR-0070 §4), cloister-991e65.
//
// Two consumers, one rule set:
//   - toml-to-cluster runs `assertPortsAndConnections` as a build-time check,
//     so an unresolvable declaration fails `task cluster:toml` by name;
//   - `cloister runtime plan` validates cluster.toml through that same
//     pipeline (`parseTomlToCluster`), then `lowerChannelGrants` turns the
//     declarations into confinement/v1 §6 `unixSocket.allow` grants with
//     `guestPort`. Its own refusals stay as defense in depth.
//
// The lowering is a pure function of (cluster.toml, env, channelDir): the
// socket a target bundle BINDS and the socket a dialling bundle CONNECTS are
// the same string, `<channelDir>/<bundle>.<port>.sock`, so two separately
// emitted plans join on the host with no broker.

import { validateAppProtocol } from "../app-protocol.mjs";

/** `expose` values. "" is accepted and means "none". */
export const EXPOSE_VALUES = Object.freeze(["none", "cluster", "edge"]);

/**
 * Longest UNIX socket path macOS's `sockaddr_un.sun_path` holds (104 bytes,
 * NUL included). Linux allows 107; the plan is refused at the narrower limit
 * so one plan is valid on both hosts. Mirrors MAX_UNIX_SOCKET_PATH in
 * rs/crates/host-runtime/src/lib.rs, which refuses the same plan at launch.
 */
export const MAX_UNIX_SOCKET_PATH = 103;

export const DEFAULT_CHANNEL_DIR = "/tmp/cloister-host-runtime/ch";

function text(v) {
  return typeof v === "string" ? v : "";
}

/** Normalize `[[bundles.ports]]` rows to the PortSpec shape. */
export function normalizePorts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    name: text(p?.name),
    port: typeof p?.port === "number" ? p.port : 0,
    appProtocol: text(p?.appProtocol),
    expose: text(p?.expose),
  }));
}

/** Normalize `[[connections]]` rows to the ConnectionSpec shape. */
export function normalizeConnections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    from: text(c?.from),
    name: text(c?.name),
    appProtocol: text(c?.appProtocol),
    targets: (Array.isArray(c?.targets) ? c.targets : []).map((t) => ({
      env: text(t?.env),
      bundle: text(t?.bundle),
      port: text(t?.port),
    })),
  }));
}

/** True when a port is reachable by anything other than its own bundle. */
export function isExposed(port) {
  return port.expose !== "" && port.expose !== "none";
}

/**
 * A port name is a lowercase IANA-service-name-shaped token (a-z, 0-9,
 * hyphen) — the same shape Kubernetes requires of a container port name.
 * It is part of the lowered socket path `<bundle>.<port>.sock`, so a "." or
 * "/" in it would let two different (bundle, port) pairs lower to one path.
 * Char scan, no regex (cloister-6f06cc).
 */
function portNameProblem(name) {
  if (name === "") return "is empty";
  for (const ch of name) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
    if (!ok) return `contains ${JSON.stringify(ch)} (allowed: a-z, 0-9, hyphen)`;
  }
  if (name.startsWith("-") || name.endsWith("-")) return "starts or ends with a hyphen";
  return null;
}

/**
 * A bundle that holds a channel end — an exposed port, an outbound
 * connection, or a connection target — names a socket file, and (once
 * forwarded placements exist) a Kubernetes namespace. So its name must be an
 * RFC 1123 DNS label: a-z, 0-9 and hyphen, 1-63 chars, alphanumeric at both
 * ends. Lowercase-only also rules out two bundles whose socket paths differ
 * only in case colliding on a case-insensitive filesystem (macOS by default).
 * Char scan, no regex (cloister-6f06cc).
 */
export function dnsLabelProblem(name) {
  if (typeof name !== "string" || name === "") return "is empty";
  if (name.length > 63) return `is ${name.length} characters (at most 63)`;
  for (const ch of name) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
    if (!ok) return `contains ${JSON.stringify(ch)} (allowed: a-z, 0-9, hyphen)`;
  }
  if (name.startsWith("-") || name.endsWith("-")) return "starts or ends with a hyphen";
  return null;
}

/**
 * Why bundle `b` cannot hold a channel end, or null if it can.
 *
 * Channels are lowered only for external `microvm` bundles: confinement/v1 §6
 * `guestPort` presentation is microVM-only (LLO). A workerd bundle reaches
 * peers through service bindings, never a socket — and ADR-0069 §3 forbids a
 * SQL-wire connection from one outright (ADR-0033). An external `process`
 * bundle has no way to be handed the channel at all.
 */
function endpointProblem(b) {
  if (b.kind !== "external") {
    return `is a ${b.kind || "non-external"} bundle; workerd bundles reach peers through ` +
      `service bindings, not declared channels (and ADR-0069 §3 forbids a SQL-wire ` +
      `connection from one — ADR-0033)`;
  }
  if (b.executionMode !== "microvm") {
    return `has executionMode ${JSON.stringify(b.executionMode)}; channels are lowered only ` +
      `for "microvm" bundles (confinement/v1 §6 guestPort is microVM-only, LLO)`;
  }
  return null;
}

function assertEndpoint(b, role) {
  const problem = endpointProblem(b);
  if (problem) throw new Error(`bundle "${b.name}" ${role} but ${problem}`);
  const nameProblem = dnsLabelProblem(b.name);
  if (nameProblem) {
    throw new Error(
      `bundle "${b.name}" ${role}, so its name must be a DNS label — it names a socket ` +
        `file and a namespace, and lowercase-only keeps two names from colliding on a ` +
        `case-insensitive filesystem — but it ${nameProblem}`,
    );
  }
}

/**
 * Build-time checks capnp cannot express. Throws on the first violation,
 * naming the bundle / connection at fault.
 *
 * @param {Array<{name, kind, executionMode, ports}>} bundles see `checkableBundle`
 * @param {Array} connections normalized connections
 */
export function assertPortsAndConnections(bundles, connections) {
  const byName = new Map();
  for (const b of bundles) byName.set(b.name, b);

  for (const b of bundles) {
    const names = new Set();
    const numbers = new Map();
    for (const p of b.ports ?? []) {
      const where = `bundle "${b.name}" port "${p.name}"`;
      const nameProblem = portNameProblem(p.name);
      if (nameProblem) {
        throw new Error(`bundle "${b.name}": a port name ${nameProblem} (got ${JSON.stringify(p.name)})`);
      }
      if (names.has(p.name)) {
        throw new Error(`bundle "${b.name}" declares port name "${p.name}" more than once`);
      }
      names.add(p.name);
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
        throw new Error(`${where}: port must be 1-65535 (got ${p.port})`);
      }
      if (numbers.has(p.port)) {
        throw new Error(
          `bundle "${b.name}" declares port number ${p.port} twice ` +
            `("${numbers.get(p.port)}" and "${p.name}")`,
        );
      }
      numbers.set(p.port, p.name);
      if (p.expose !== "" && !EXPOSE_VALUES.includes(p.expose)) {
        throw new Error(
          `${where}: expose ${JSON.stringify(p.expose)} is not one of ${EXPOSE_VALUES.join(", ")}`,
        );
      }
      const protoProblem = validateAppProtocol(p.appProtocol);
      if (protoProblem) throw new Error(`${where}: appProtocol ${protoProblem}`);
      // expose = "none" is a declaration only — no channel — so it is allowed
      // on any bundle. An exposed port is a channel end.
      if (isExposed(p)) assertEndpoint(b, `exposes port "${p.name}"`);
    }
  }

  const seen = new Set();
  const edges = new Map();
  for (const c of connections) {
    const where = `connection "${c.name}" (from "${c.from}")`;
    if (c.name === "") throw new Error(`a connection from "${c.from}" has an empty name`);
    if (!byName.has(c.from)) {
      throw new Error(`${where}: from "${c.from}" is not a declared bundle`);
    }
    const key = `${c.from}\u0000${c.name}`;
    if (seen.has(key)) {
      throw new Error(`${where} is declared more than once — (from, name) must be unique`);
    }
    seen.add(key);
    assertEndpoint(byName.get(c.from), `is the from of connection "${c.name}"`);
    const protoProblem = validateAppProtocol(c.appProtocol);
    if (protoProblem) throw new Error(`${where}: appProtocol ${protoProblem}`);
    if (c.targets.length === 0) {
      throw new Error(`${where} declares no targets — add a [[connections.targets]] row per env`);
    }
    const envs = new Set();
    for (const t of c.targets) {
      if (t.env === "") throw new Error(`${where}: a target has an empty env`);
      if (envs.has(t.env)) {
        throw new Error(`${where} declares env "${t.env}" more than once`);
      }
      envs.add(t.env);
      const tw = `${where} env "${t.env}"`;
      const target = byName.get(t.bundle);
      if (!target) throw new Error(`${tw}: target bundle "${t.bundle}" is not declared`);
      if (t.bundle === c.from) {
        throw new Error(`${tw}: target bundle "${t.bundle}" is the connection's own from bundle`);
      }
      const port = (target.ports ?? []).find((p) => p.name === t.port);
      if (!port) {
        throw new Error(`${tw}: bundle "${t.bundle}" declares no port named "${t.port}"`);
      }
      if (!isExposed(port)) {
        throw new Error(
          `${tw}: port "${t.bundle}.${t.port}" has expose "none" and cannot be a connection target`,
        );
      }
      if (port.appProtocol !== c.appProtocol) {
        throw new Error(
          `${tw}: appProtocol "${c.appProtocol}" does not match port ` +
            `"${t.bundle}.${t.port}" appProtocol "${port.appProtocol}"`,
        );
      }
      assertEndpoint(target, `is the target of connection "${c.name}"`);
      // Two connections from one bundle to the same port in one env are one
      // edge declared twice. Refused here, by name, rather than surfacing
      // later as a guestPort collision that names neither connection.
      const edge = `${c.from}\u0000${t.env}\u0000${t.bundle}\u0000${t.port}`;
      if (edges.has(edge)) {
        throw new Error(
          `connections "${edges.get(edge)}" and "${c.name}" (from "${c.from}") both reach ` +
            `"${t.bundle}.${t.port}" in env "${t.env}" — a duplicate edge; declare it once`,
        );
      }
      edges.set(edge, c.name);
    }
  }
}

/**
 * The fields the checks above read, from a validated Bundle (the zod shape:
 * `kind` is `{ external: {...} }` or `{ workerd: {...} }`).
 */
export function checkableBundle(b) {
  const kind = b?.kind && typeof b.kind === "object" ? Object.keys(b.kind)[0] ?? "" : "";
  return {
    name: b?.name,
    kind,
    executionMode: b?.kind?.external?.executionMode ?? "",
    ports: b?.ports ?? [],
  };
}

/** The one socket path a (bundle, port) pair lowers to. Both ends use it. */
export function channelSocketPath(channelDir, bundle, portName) {
  if (typeof bundle !== "string" || bundle === "" || bundle.includes("/") || bundle.includes("\0")) {
    throw new Error(`bundle name ${JSON.stringify(bundle)} cannot name a channel socket`);
  }
  return `${channelDir}/${bundle}.${portName}.sock`;
}

/**
 * Lower bundle `options.bundle`'s declared ports and outbound connections to
 * confinement/v1 §6 grants for the microvm placement (ADR-0070 §4).
 *
 * Order is deterministic: the bundle's exposed ports (bind grants) in
 * declaration order, then its connections (connect grants) in declaration
 * order. `mode` is omitted on connect grants: the host-runtime plan parser
 * defaults it to "" (connect), which is the narrow grant.
 *
 * Assumes `assertPortsAndConnections` has passed for the same inputs.
 *
 * @param {Array<{name, ports, executionMode}>} bundles normalized bundles
 * @param {Array} connections normalized connections
 * @param {{bundle: string, env: string, channelDir: string}} options
 * @returns {Array<{path: string, mode?: string, guestPort: number}>}
 */
export function lowerChannelGrants(bundles, connections, options) {
  const { bundle: name, env, channelDir } = options;
  const self = bundles.find((b) => b.name === name);
  const outbound = connections.filter((c) => c.from === name);
  const ports = self?.ports ?? [];
  const exposed = ports.filter(isExposed);
  if (ports.length === 0 && outbound.length === 0) return [];

  if (self.executionMode !== "microvm") {
    throw new Error(
      `bundle "${name}" declares ports or connections but its executionMode is ` +
        `"${self.executionMode}": confinement/v1 §6 guestPort presentation is ` +
        `microVM-only (LLO), so a "process" bundle has no way to be handed the ` +
        `channel. Run it as "microvm" or remove the declarations.`,
    );
  }

  const grants = [];
  for (const p of exposed) {
    grants.push({ path: channelSocketPath(channelDir, name, p.name), mode: "bind", guestPort: p.port });
  }
  for (const c of outbound) {
    const target = c.targets.find((t) => t.env === env);
    if (!target) {
      throw new Error(
        `connection "${c.name}" (from "${name}") declares no target for env "${env}" ` +
          `(declared: ${c.targets.map((t) => t.env).join(", ")})`,
      );
    }
    const tb = bundles.find((b) => b.name === target.bundle);
    if (tb.executionMode !== "microvm") {
      // The other end would never bind the socket: a non-microvm target is a
      // different placement, and constructed ↔ other joins go through LLO's
      // broker (ADR-0070 §4), which this lowering does not emit.
      throw new Error(
        `connection "${c.name}" (from "${name}") env "${env}": target bundle ` +
          `"${target.bundle}" is not a microvm bundle, so nothing would bind ` +
          `its channel; joining other placements needs LLO's broker (ADR-0070 §4)`,
      );
    }
    const port = tb.ports.find((p) => p.name === target.port);
    grants.push({ path: channelSocketPath(channelDir, target.bundle, port.name), guestPort: port.port });
  }

  // No auto-shift on a collision: launch plans carry no workload env yet, so
  // a guestPort moved to dodge another could not be told to the workload — it
  // would dial the declared number and reach the wrong channel or nothing.
  const byPort = new Map();
  for (const g of grants) {
    if (byPort.has(g.guestPort)) {
      throw new Error(
        `bundle "${name}": guestPort ${g.guestPort} is presented by two grants ` +
          `(${byPort.get(g.guestPort)} and ${g.path}). Ports are not shifted ` +
          `automatically because a launch plan carries no workload env yet, so ` +
          `the workload could not learn the moved port.`,
      );
    }
    byPort.set(g.guestPort, g.path);
  }
  for (const g of grants) {
    if (Buffer.byteLength(g.path) > MAX_UNIX_SOCKET_PATH) {
      throw new Error(
        `channel socket path is ${Buffer.byteLength(g.path)} bytes, over the ` +
          `${MAX_UNIX_SOCKET_PATH}-byte macOS sun_path limit: ${g.path} — use a shorter --channel-dir`,
      );
    }
  }
  return grants;
}
