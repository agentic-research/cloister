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
    minStrength: text(c?.minStrength),
    targets: (Array.isArray(c?.targets) ? c.targets : []).map((t) => ({
      env: text(t?.env),
      bundle: text(t?.bundle),
      port: text(t?.port),
    })),
  }));
}

/** Normalize `[[bundles.placements]]` rows to the PlacementSpec shape. */
export function normalizePlacements(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({ env: text(p?.env), kind: text(p?.kind), manifest: text(p?.manifest) }));
}

// ── Placements and channel strength (ADR-0070 §2–3) ──────────────────────

/** Constructed: cloister builds the node. Forwarded: it owns only the edges. */
export const CONSTRUCTED_KINDS = Object.freeze(["microvm", "workerd"]);
export const FORWARDED_KINDS = Object.freeze(["kubernetes", "cloudRun"]);
export const PLACEMENT_KINDS = Object.freeze([...CONSTRUCTED_KINDS, ...FORWARDED_KINDS]);

/** Ordered weakest → strongest; the meet of two is the earlier one. */
export const STRENGTHS = Object.freeze(["none", "policy", "capability"]);

/**
 * The channel strength a placement kind delivers (ADR-0070 §3).
 *
 * microvm is `capability` unconditionally because socket hijacking is off by
 * construction: the host runtime hardcodes it and a launch plan cannot turn it
 * on. If that ever becomes a plan field, a hijacking microvm must map to
 * `policy` here. kubernetes is `policy` (NetworkPolicy, which the cluster's CNI
 * must enforce). Every other kind is `none` until it is lowered with a
 * mechanism that enforces anything — never an optimistic default.
 */
export function strengthOf(kind) {
  if (kind === "microvm") return "capability";
  if (kind === "kubernetes") return "policy";
  return "none";
}

/** The meet (weaker) of two strengths. */
export function meetStrength(a, b) {
  return STRENGTHS[Math.min(STRENGTHS.indexOf(a), STRENGTHS.indexOf(b))];
}

/**
 * A bundle's placement kind for `env`, or null when it has none.
 *
 * A bundle with NO placement rows and executionMode "microvm" is implicitly
 * "microvm" in every env — the behaviour before placements existed, kept so a
 * cluster.toml that only says `executionMode = "microvm"` still lowers. Any
 * declared row turns the implicit default off for that bundle entirely.
 */
export function placementFor(bundle, env) {
  const rows = bundle?.placements ?? [];
  if (rows.length === 0) return bundle?.executionMode === "microvm" ? "microvm" : null;
  return rows.find((p) => p.env === env)?.kind ?? null;
}

/** The manifest path of a bundle's placement row for `env` ("" if none). */
export function placementManifest(bundle, env) {
  return (bundle?.placements ?? []).find((p) => p.env === env)?.manifest ?? "";
}

/** Cluster-dir-relative path: no leading "/", no "." / ".." / empty segment. */
function relativePathProblem(path) {
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\0") || path.includes("\\")) return "contains a NUL or backslash";
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `has a ${JSON.stringify(seg)} segment`;
  }
  return null;
}

function assertPlacements(b) {
  const envs = new Set();
  for (const p of b.placements ?? []) {
    const where = `bundle "${b.name}" placement env "${p.env}"`;
    if (p.env === "") throw new Error(`bundle "${b.name}": a placement has an empty env`);
    if (envs.has(p.env)) {
      throw new Error(`bundle "${b.name}" declares a placement for env "${p.env}" more than once`);
    }
    envs.add(p.env);
    if (!PLACEMENT_KINDS.includes(p.kind)) {
      throw new Error(`${where}: kind ${JSON.stringify(p.kind)} is not one of ${PLACEMENT_KINDS.join(", ")}`);
    }
    if (p.kind === "microvm" && b.executionMode !== "microvm") {
      throw new Error(
        `${where}: kind "microvm" requires executionMode = "microvm" ` +
          `(the bundle declares ${JSON.stringify(b.executionMode)}) — the two must agree`,
      );
    }
    if (CONSTRUCTED_KINDS.includes(p.kind) && p.manifest !== "") {
      throw new Error(
        `${where}: kind "${p.kind}" is constructed by cloister and takes no manifest ` +
          `(manifest is for forwarded kinds: ${FORWARDED_KINDS.join(", ")})`,
      );
    }
    if (p.kind === "kubernetes" && p.manifest === "") {
      throw new Error(`${where}: kind "kubernetes" requires a manifest (a rendered YAML path)`);
    }
    if (p.manifest !== "") {
      const problem = relativePathProblem(p.manifest);
      if (problem) {
        throw new Error(`${where}: manifest ${JSON.stringify(p.manifest)} ${problem}; it must be relative to the cluster directory`);
      }
    }
  }
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
/** Placement kinds a channel end may have: the two that are lowered. */
const CHANNEL_KINDS = ["microvm", "kubernetes"];

/**
 * Why bundle `b` cannot hold a channel end — in `env` when given (a
 * connection end), or in any env (an exposed port) — or null if it can.
 *
 * Placements generalise #283's "external microvm only" rule: an end must be
 * placed `microvm` or `kubernetes`, the two kinds an emitter lowers. A bundle
 * with no placement rows is placed implicitly only if it is an external
 * microvm bundle, so for it the old rule and message stand.
 */
function endpointProblem(b, env) {
  if (b.kind !== "external") {
    return `is a ${b.kind || "non-external"} bundle; workerd bundles reach peers through ` +
      `service bindings, not declared channels (and ADR-0069 §3 forbids a SQL-wire ` +
      `connection from one — ADR-0033)`;
  }
  const rows = b.placements ?? [];
  if (rows.length === 0 && b.executionMode !== "microvm") {
    return `has executionMode ${JSON.stringify(b.executionMode)} and no placements; channels ` +
      `are lowered only for "microvm" bundles (confinement/v1 §6 guestPort is microVM-only, ` +
      `LLO) or bundles placed "kubernetes"`;
  }
  if (env !== undefined) {
    const kind = placementFor(b, env);
    if (kind === null) {
      return `has no placement for env "${env}" — declare a [[bundles.placements]] row ` +
        `(only an executionMode "microvm" bundle with no rows is placed implicitly)`;
    }
    if (!CHANNEL_KINDS.includes(kind)) {
      return `is placed "${kind}" for env "${env}"; a channel end must be placed ` +
        `${CHANNEL_KINDS.join(" or ")}, the kinds ADR-0070 §4 lowers today`;
    }
    return null;
  }
  const kinds = rows.length === 0 ? ["microvm"] : rows.map((r) => r.kind);
  if (!kinds.some((k) => CHANNEL_KINDS.includes(k))) {
    return `has no placement of kind ${CHANNEL_KINDS.join(" or ")} (declared: ` +
      `${kinds.join(", ")}), so nothing would lower its channel`;
  }
  return null;
}

function assertEndpoint(b, role, env) {
  const problem = endpointProblem(b, env);
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
    assertPlacements(b);
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
    const protoProblem = validateAppProtocol(c.appProtocol);
    if (protoProblem) throw new Error(`${where}: appProtocol ${protoProblem}`);
    if (c.minStrength !== "" && !STRENGTHS.includes(c.minStrength)) {
      throw new Error(
        `${where}: minStrength ${JSON.stringify(c.minStrength)} is not one of ${STRENGTHS.join(", ")}`,
      );
    }
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
      // Both ends must be channel ends placed in this env (ADR-0070: every
      // bundle a connection touches resolves a placement for the env it names).
      assertEndpoint(byName.get(c.from), `is the from of connection "${c.name}"`, t.env);
      assertEndpoint(target, `is the target of connection "${c.name}"`, t.env);
      const fromKind = placementFor(byName.get(c.from), t.env);
      const toKind = placementFor(target, t.env);
      // ADR-0070 §3: the edge is as strong as its weaker end.
      if (c.minStrength !== "") {
        const strength = meetStrength(strengthOf(fromKind), strengthOf(toKind));
        if (STRENGTHS.indexOf(strength) < STRENGTHS.indexOf(c.minStrength)) {
          throw new Error(
            `${tw}: minStrength "${c.minStrength}" is not met — "${c.from}" is placed ` +
              `"${fromKind}" and "${t.bundle}" is placed "${toKind}", ` +
              `so the edge's strength is "${strength}" (the meet of ` +
              `${strengthOf(fromKind)} and ${strengthOf(toKind)})`,
          );
        }
      }
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
    placements: b?.placements ?? [],
  };
}

/** Refuse a bundle this emitter does not lower, naming why. */
export function refuseNonMicrovm(label, kind, env) {
  if (kind === "kubernetes") {
    throw new Error(`${label} is placed "kubernetes" for env "${env}"; lower it with \`cloister cluster k8s\`, not \`runtime plan\``);
  }
  throw new Error(`${label} is placed "${kind}" for env "${env}", which is not lowered yet (ADR-0070 §4)`);
}

/**
 * Refuse an edge whose two ends are placed differently. Such an edge is legal
 * in the graph — it is how constructed and forwarded tiers meet — but no
 * emitter joins two placements directly: that is LLO's broker
 * (ley-line-open-e2c5ce), which does not exist yet.
 */
export function refuseCrossPlacement(c, fromName, fromKind, toName, toKind, env) {
  for (const [end, kind] of [[fromName, fromKind], [toName, toKind]]) {
    if (kind === "workerd" || kind === "cloudRun") {
      throw new Error(
        `connection "${c.name}" (from "${fromName}") env "${env}": "${end}" is ` +
          `placed "${kind}", which is not lowered yet (ADR-0070 §4)`,
      );
    }
  }
  throw new Error(
    `connection "${c.name}" (from "${fromName}") env "${env}" joins "${fromName}" ` +
      `(${fromKind}) to "${toName}" (${toKind}): an edge across placements needs ` +
      `LLO's broker (ley-line-open-e2c5ce), which no emitter lowers yet`,
  );
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

  const selfKind = placementFor(self, env);
  if (selfKind !== "microvm") {
    if (selfKind !== null) refuseNonMicrovm(`bundle "${name}"`, selfKind, env);
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
    const targetKind = placementFor(tb, env);
    if (targetKind !== "microvm") {
      // The other end would never bind the socket: a non-microvm target is a
      // different placement, and constructed ↔ other joins go through LLO's
      // broker (ADR-0070 §4), which this lowering does not emit.
      refuseCrossPlacement(c, name, "microvm", target.bundle, targetKind, env);
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
