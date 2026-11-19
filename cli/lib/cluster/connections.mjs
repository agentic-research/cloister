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
  return raw.map((p) => ({
    env: text(p?.env),
    kind: text(p?.kind),
    manifest: text(p?.manifest),
    ports: Array.isArray(p?.ports) ? p.ports.map((x) => ({ name: text(x?.name), port: x?.port ?? 0, expose: text(x?.expose) })) : [],
    name: text(p?.name),
  }));
}

// ── Placements and channel strength (ADR-0070 §2–3) ──────────────────────

/** Constructed: cloister builds the node. Forwarded: it owns only the edges. */
export const CONSTRUCTED_KINDS = Object.freeze(["microvm", "workerd"]);
export const FORWARDED_KINDS = Object.freeze(["kubernetes", "knative", "cloudRun"]);
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
 *
 * knative is `none` on purpose, and is its own kind for that reason. A Knative
 * Service runs on Kubernetes, but a request reaches it through Knative's
 * ingress and activator, not pod to pod, so the NetworkPolicies that make
 * `kubernetes` a `policy` placement do not describe its path. Cloister checks
 * a knative bundle's ports and writes nothing. If it were a `kubernetes`
 * placement, this function would report `policy` for an edge nothing enforces.
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
 * The strength of one edge, from the kinds of its two ends.
 *
 * It is the weaker end's, with one exception that is a fact about direction.
 * Strength is about the TARGET: can something that is not a declared caller
 * reach it? A knative bundle calling a kubernetes one is a direct pod-to-pod
 * request, so the target's NetworkPolicy admits exactly the caller's pods and
 * refuses the rest: `policy`. The other way round the request goes through
 * Knative's ingress and activator, the target has no policy, and the edge is
 * `none` like any into a knative bundle (ADR-0070 §3 amendment).
 */
export function edgeStrength(fromKind, toKind) {
  if (fromKind === "knative" && toKind === "kubernetes") return "policy";
  return meetStrength(strengthOf(fromKind), strengthOf(toKind));
}

/** The label Knative puts on every pod of a Service; its value is the Service's name. */
export const KNATIVE_POD_LABEL = "serving.knative.dev/service";

/** Kind pairs whose edge an emitter can lower although the two ends differ. */
const JOINABLE = Object.freeze([["kubernetes", "knative"], ["knative", "kubernetes"]]);
export const joinable = (fromKind, toKind) => fromKind === toKind || JOINABLE.some(([a, b]) => a === fromKind && b === toKind);

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

/**
 * What a bundle is called in `env`: its placement row's `name`, or its own
 * name (ADR-0074 §4). Null when the bundle is not placed there at all.
 */
export function placementName(bundle, env) {
  const rows = bundle?.placements ?? [];
  if (rows.length === 0) return bundle?.name ?? null;
  const row = rows.find((p) => p.env === env);
  return row ? (row.name || bundle.name) : null;
}

/**
 * Within one environment a name means one bundle. Throws by name when two
 * bundles placed in the same environment go by the same name there, whether
 * by a placement row's `name` or by their own.
 */
function assertPlacementNames(bundles) {
  const envs = new Set(bundles.flatMap((b) => (b.placements ?? []).map((p) => p.env)));
  for (const env of envs) {
    const seen = new Map();
    for (const b of bundles) {
      const name = placementName(b, env);
      if (name === null) continue;
      if (seen.has(name)) {
        throw new Error(
          `bundles "${seen.get(name)}" and "${b.name}" are both called ${JSON.stringify(name)} in env "${env}". ` +
            `A name means one bundle there: change a placement row's \`name\``,
        );
      }
      seen.set(name, b.name);
    }
  }
}

/** The manifest path of a bundle's placement row for `env` ("" if none). */
export function placementManifest(bundle, env) {
  return (bundle?.placements ?? []).find((p) => p.env === env)?.manifest ?? "";
}

/** Forwarded kinds whose manifest cloister reads, when the row names one. */
export const MANIFEST_KINDS = Object.freeze(["kubernetes", "knative"]);

/**
 * The manifest path of a bundle placed in `env`, for a command that must
 * read or write one. Throws by name when the row names none.
 */
export function requireManifest(bundle, env, command) {
  const path = placementManifest(bundle, env);
  if (path !== "") return path;
  throw new Error(
    `bundle "${bundle.name}" is placed "${placementFor(bundle, env)}" for env "${env}" and names no manifest. ` +
      `\`${command}\` works from a manifest: add \`manifest = "${bundle.name}.yaml"\` to that placement row. ` +
      `A placement described only by a plan is checked with \`cloister inspect\``,
  );
}

/** "a", "a or b", "a, b or c". */
const oneOf = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

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
    if (CONSTRUCTED_KINDS.includes(p.kind) && (p.name ?? "") !== "") {
      throw new Error(
        `${where}: kind "${p.kind}" is constructed by cloister and named after the bundle; it takes no \`name\` ` +
          `(name is for forwarded kinds: ${FORWARDED_KINDS.join(", ")})`,
      );
    }
    if (/[\u0000-\u001f\u007f]/.test(p.name ?? "")) {
      throw new Error(`${where}: name holds a control character`);
    }
    if (CONSTRUCTED_KINDS.includes(p.kind) && p.manifest !== "") {
      throw new Error(
        `${where}: kind "${p.kind}" is constructed by cloister and takes no manifest ` +
          `(manifest is for forwarded kinds: ${FORWARDED_KINDS.join(", ")})`,
      );
    }
    // A manifest is not required here. A placement may be described by
    // something other than YAML (a Terraform plan that declares the
    // Deployment), and `inspect` reads that. The commands that READ a
    // manifest (`cluster k8s`, `cluster lower`) refuse a row without one, by
    // name, for the env they are run for (ADR-0070 §2 amendment 2026-11-19).
    if (p.manifest !== "") {
      const problem = relativePathProblem(p.manifest);
      if (problem) {
        throw new Error(`${where}: manifest ${JSON.stringify(p.manifest)} ${problem}; it must be relative to the cluster directory`);
      }
    }
    // The number a port is dialled on here, when it is not the one the
    // workload listens on (ADR-0074 §7).
    const dialled = new Set();
    for (const row of p.ports ?? []) {
      if (!FORWARDED_KINDS.includes(p.kind)) {
        throw new Error(
          `${where}: kind "${p.kind}" takes no ports rows. A port is dialled on another number only ` +
            `where something sits in front of the workload (forwarded kinds: ${FORWARDED_KINDS.join(", ")})`,
        );
      }
      const declared = (b.ports ?? []).find((x) => x.name === row.name);
      if (!declared) {
        throw new Error(`${where}: ports row names "${row.name}", which is not a port of bundle "${b.name}" (it declares: ${(b.ports ?? []).map((x) => x.name).join(", ") || "none"})`);
      }
      if (dialled.has(row.name)) throw new Error(`${where}: ports row for "${row.name}" appears more than once`);
      dialled.add(row.name);
      const number = row.port ?? 0;
      const expose = text(row.expose);
      if (number === 0 && expose === "") {
        throw new Error(`${where}: ports row for "${row.name}" sets neither port nor expose, so it says nothing`);
      }
      if (!Number.isInteger(number) || number < 0 || number > 65535) {
        throw new Error(`${where}: port "${row.name}" is dialled on ${JSON.stringify(row.port)}, which is not a port number (1-65535)`);
      }
      if (expose !== "" && !PLACEMENT_EXPOSE.includes(expose)) {
        throw new Error(`${where}: port "${row.name}" expose ${JSON.stringify(expose)} is not one of ${PLACEMENT_EXPOSE.join(", ")}`);
      }
      // Only a port that is reachable at all can be reachable differently here.
      if (expose !== "" && !isExposed(declared)) {
        throw new Error(`${where}: port "${row.name}" has expose = "${declared.expose || "none"}" on the bundle, so no placement can open it; set the bundle port's expose first`);
      }
    }
    const numbers = new Map();
    for (const port of portsFor(b, p.env)) {
      if (numbers.has(port.port)) {
        throw new Error(`${where}: ports "${numbers.get(port.port)}" and "${port.name}" are both dialled on ${port.port}`);
      }
      numbers.set(port.port, port.name);
    }
  }
}

/**
 * A bundle's ports as a peer in `env` sees them: `port` is the number that is
 * DIALLED there, `listen` is the number the workload binds, and `expose` is
 * whether it can be reached from outside there. They differ from the bundle's
 * own only where the env's placement row says so (ADR-0074 §7).
 */
export function portsFor(b, env) {
  const row = (b.placements ?? []).find((p) => p.env === env);
  return (b.ports ?? []).map((port) => {
    const override = (row?.ports ?? []).find((x) => x.name === port.name);
    return {
      ...port,
      listen: port.port,
      port: override?.port ? override.port : port.port,
      // Whether it can be reached from outside in this placement.
      expose: override?.expose ? override.expose : port.expose,
    };
  });
}

/** What a placement row may say a port's expose is there. */
export const PLACEMENT_EXPOSE = Object.freeze(["cluster", "edge"]);

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
/**
 * Placement kinds a channel end may have (ADR-0074 §6): `microvm`, which is
 * lowered, and every forwarded kind. A forwarded end is checked against what
 * the operator rendered (a manifest for kubernetes and knative, a plan for
 * anything a provider mapping describes) and its strength is "none" unless an
 * emitter writes something that enforces it, as `cluster k8s` does for
 * kubernetes. The rule is on the category: a new forwarded kind is a
 * connection end without an edit here.
 */
export const CHANNEL_KINDS = Object.freeze(["microvm", ...FORWARDED_KINDS]);

/**
 * Why bundle `b` cannot hold a channel end — in `env` when given (a
 * connection end), or in any env (an exposed port) — or null if it can.
 *
 * Placements generalise #283's "external microvm only" rule: an end must be
 * placed `microvm` or a forwarded kind (CHANNEL_KINDS). A bundle
 * with no placement rows is placed implicitly only if it is an external
 * microvm bundle, so for it the old rule and message stand.
 *
 * The one exception is a port (no `env`) on an external bundle with no
 * placement: compose lowers it. See the comment in the body.
 */
function endpointProblem(b, env) {
  if (b.kind !== "external") {
    return `is a ${b.kind || "non-external"} bundle; workerd bundles reach peers through ` +
      `service bindings, not declared channels (and ADR-0069 §3 forbids a SQL-wire ` +
      `connection from one — ADR-0033)`;
  }
  const rows = b.placements ?? [];
  // A PORT on an external bundle with no placement is lowered by compose,
  // which runs every external bundle whatever its executionMode: an `edge`
  // port is published on the host's loopback, and any other is left
  // unpublished (ADR-0069 amendment 2026-11-19). A CONNECTION end still needs
  // a placement in its env, so `env` given keeps the refusal below.
  if (rows.length === 0 && b.executionMode !== "microvm" && env === undefined) return null;
  if (rows.length === 0 && b.executionMode !== "microvm") {
    return `has executionMode ${JSON.stringify(b.executionMode)} and no placements; channels ` +
      `are lowered only for "microvm" bundles (confinement/v1 §6 guestPort is microVM-only, ` +
      `LLO) or bundles with a forwarded placement (${FORWARDED_KINDS.join(", ")})`;
  }
  if (env !== undefined) {
    const kind = placementFor(b, env);
    if (kind === null) {
      return `has no placement for env "${env}" — declare a [[bundles.placements]] row ` +
        `(only an executionMode "microvm" bundle with no rows is placed implicitly)`;
    }
    if (!CHANNEL_KINDS.includes(kind)) {
      return `is placed "${kind}" for env "${env}"; a channel end must be placed ` +
        `${oneOf(CHANNEL_KINDS)}, the kinds that are lowered or checked (ADR-0074 §6)`;
    }
    return null;
  }
  const kinds = rows.length === 0 ? ["microvm"] : rows.map((r) => r.kind);
  if (!kinds.some((k) => CHANNEL_KINDS.includes(k))) {
    return `has no placement of kind ${oneOf(CHANNEL_KINDS)} (declared: ` +
      `${kinds.join(", ")}), so nothing would lower or check its channel`;
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

  for (const b of bundles) assertPlacements(b);
  assertPlacementNames(bundles);
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
        const strength = edgeStrength(fromKind, toKind);
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

/** Where an env row's value comes from: "value", "connection" or "secret". */
export function envSource(row) {
  // A secret is where the value comes from, whatever else the row says about
  // what the value IS (see `secretBorne`).
  if (text(row?.secret) !== "") return "secret";
  if (text(row?.connection) !== "") return "connection";
  return "value";
}

/**
 * The connections whose address a bundle keeps in a secret (ADR-0074 §7).
 *
 * A database URL usually holds a password, so it lives in a secret, and the
 * edge it carries is then in a value cloister never reads. A row that sets
 * `secret` AND `connection` says so: "this secret holds the address of that
 * connection". The value still comes from the secret. The edge is DECLARED,
 * not observed, and every report that shows it says which.
 *
 * @param {Array} bundles validated bundles (the zod shape)
 * @returns {Map<string, {secret: string, env: string}>} keyed `from\0connection`
 */
export function secretBorne(bundles) {
  const out = new Map();
  for (const b of bundles ?? []) {
    for (const row of b?.kind?.external?.env ?? []) {
      if (text(row?.secret) === "" || text(row?.connection) === "") continue;
      const key = `${b.name}\u0000${row.connection}`;
      if (!out.has(key)) out.set(key, { secret: row.secret, env: row.name });
    }
  }
  return out;
}

export const RUNS = Object.freeze(["service", "job"]);

/**
 * Checks on a bundle's env bindings and run mode that capnp cannot express
 * (ADR-0074 §7). An env row takes its value from exactly one place; a
 * connection binding names a connection this bundle declares; a job is not
 * something another bundle can reach.
 *
 * @param {Array} bundles validated bundles (the zod shape)
 * @param {Array} connections normalized connections
 */
export function assertEnvBindings(bundles, connections) {
  for (const b of bundles) {
    const external = b?.kind?.external;
    if (!external) continue;
    const runs = text(external.runs);
    if (runs !== "" && !RUNS.includes(runs)) {
      throw new Error(`bundle "${b.name}": runs ${JSON.stringify(runs)} is not one of ${RUNS.join(", ")}`);
    }
    if (runs === "job") {
      const exposed = (b.ports ?? []).find(isExposed);
      if (exposed) {
        throw new Error(`bundle "${b.name}" runs = "job" but exposes port "${exposed.name}": a job runs to completion, so nothing can depend on reaching it`);
      }
    }
    for (const row of external.env ?? []) {
      const where = `bundle "${b.name}" env ${JSON.stringify(text(row?.name))}`;
      const set = [["value", row?.value], ["connection", row?.connection], ["secret", row?.secret]].filter(([, v]) => text(v) !== "").map(([k]) => k);
      // One source for the value. `secret` with `connection` is not two
      // sources: the value comes from the secret, and `connection` says what
      // that value is the address of.
      const inSecret = set.length === 2 && set.includes("secret") && set.includes("connection");
      if (set.length > 1 && !inSecret) {
        throw new Error(`${where} sets ${set.join(" and ")}: a variable's value comes from exactly one of value, connection or secret`);
      }
      const source = envSource(row);
      if (text(row?.path) !== "" && source !== "connection") {
        throw new Error(
          inSecret
            ? `${where} sets path with secret: the secret holds the whole address, so nothing is appended to it`
            : `${where} sets path without connection: path is appended to a connection's address`,
        );
      }
      if (text(row?.secretKey) !== "" && source !== "secret") {
        throw new Error(`${where} sets secretKey without secret`);
      }
      if (text(row?.connection) !== "" && !connections.some((c) => c.from === b.name && c.name === row.connection)) {
        const own = connections.filter((c) => c.from === b.name).map((c) => c.name);
        throw new Error(
          `${where} is bound to connection "${row.connection}", but bundle "${b.name}" declares no connection of that name` +
            (own.length ? ` (it declares: ${own.join(", ")})` : " (it declares none)"),
        );
      }
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
  if (kind === "knative") {
    throw new Error(`${label} is placed "knative" for env "${env}"; check it with \`cloister cluster k8s\`. A knative placement is checked, never lowered or started`);
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
  return lowerChannels(bundles, connections, options).grants;
}

/**
 * How an app_protocol label is dialled as a URL. A label not listed has no
 * URL form: a variable that needs one is set with a literal value. One table,
 * so every placement writes an address for the same protocols.
 */
export const URL_SCHEMES = Object.freeze({ "art.http": "http", "art.http2": "http", "art.grpc": "http", "art.mcp-jsonrpc": "http" });

/**
 * The grants of `lowerChannelGrants`, and with them what each outbound
 * connection is dialled at from inside the guest.
 *
 * `dials` maps a connection's name to the guest port its grant presents
 * (confinement/v1 §6: the workload connects to 127.0.0.1:<guestPort>) and its
 * app protocol. It is built in the same pass as the grants, from the same
 * number, so an address written into the workload's environment cannot name
 * a port no grant presents.
 */
export function lowerChannels(bundles, connections, options) {
  const dials = new Map();
  const grants = lowerGrants(bundles, connections, options, dials);
  return { grants, dials };
}

function lowerGrants(bundles, connections, options, dials) {
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
    dials.set(c.name, { guestPort: port.port, appProtocol: c.appProtocol, to: target.bundle });
  }

  // No auto-shift on a collision. An env row bound to the connection would be
  // told a moved port, but a workload may hold the declared number anywhere
  // else (an argument, a config file), and would dial the wrong channel.
  const byPort = new Map();
  for (const g of grants) {
    if (byPort.has(g.guestPort)) {
      throw new Error(
        `bundle "${name}": guestPort ${g.guestPort} is presented by two grants ` +
          `(${byPort.get(g.guestPort)} and ${g.path}). Ports are not shifted ` +
          `automatically: a workload may hold the declared number where no ` +
          `workload env reaches it, so a moved port would be dialled wrongly.`,
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
