// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One graph (ADR-0075).
//
// cluster.toml states edges in two vocabularies. A `[[connections]]` row is an
// edge between bundles placed in an environment. A `[[wires]]` row is an edge
// the gateway's own bundles use: a binding on one bundle that reaches another.
// They are the same kind of statement, "this bundle may reach that one", and
// until now nothing showed them together or said, for a wire, what holds it.
//
// This module reads both and gives every edge the same three facts:
//
//   carrier    how the edge is carried where it runs
//   strength   what stops a bundle that is NOT the declared caller
//              (none < policy < capability, ADR-0070 §3)
//   why        the mechanism, or the absence of one, in a sentence
//
// A strength here is never a hope. It is what the emitter for that placement
// writes today. Where nothing enforces an edge the answer is "none", with the
// reason, so the gap is stated by the tool and not found by a reader.
//
// It reads cluster.toml only. It writes nothing and starts nothing.

import {
  MANIFEST_KINDS,
  STRENGTHS,
  checkableBundle,
  edgeStrength,
  joinable,
  normalizeConnections,
  placementFor,
  placementManifest,
} from "./connections.mjs";
import { connectionEdgeOf, httpEdgeOf, networkExposure, networkPlan } from "./http-networks.mjs";
import { composeView } from "./compose-placement.mjs";
import { bundleServices, socketExposure, socketPlan } from "./socket-dirs.mjs";

/** The placement a wire runs in: what `cloister cluster up` starts. */
export const WIRE_PLACEMENT = "compose";

const quoted = (names) => names.map((name) => `"${name}"`).join(" and ");

/**
 * How compose carries a wire, and what holds it.
 *
 * The address is chosen by the same test `emit-compose` uses: a socket path
 * if the target declares one, else its HTTP port. Who holds a socket is read
 * from `socket-dirs.mjs`, and who is on a wire's network from
 * `http-networks.mjs`: the functions the emitter mounts volumes and attaches
 * networks from, so this cannot describe a compose file other than the one
 * written.
 *
 * A wire is `capability` only when every container that mounts the socket's
 * directory binds that socket or is handed it by a wire. Any other holder,
 * and the answer is `none` with that holder named. A `perTenant` target is
 * one container per tenant, each in a directory of its own, so a wire that
 * reaches one tenant is judged against that tenant's directory.
 *
 * The bundle-isolation rails (Inv 1, 4, 5) hold the WORKER's bindings to the
 * wires, which is a different thing: they bound what the gateway's own code
 * can name, not what a container beside it can dial.
 */
function wireReach(wire, declared, plan, nets, services) {
  const target = declared.get(wire.to);
  const source = declared.get(wire.from);
  const external = target?.kind?.external;
  if (external?.ipcSocket) {
    if (!(source?.kind && "external" in source.kind)) {
      return { over: `socket ${external.ipcSocket}`, strength: "none", why: `"${wire.from}" has no container of its own, so compose mounts the socket's directory into nothing for it and hands it no address` };
    }
    const { path, dir, bound, callers, undeclared } = socketExposure(wire, plan);
    const over = `socket ${path}`;
    if (bound.length === 0) {
      return { over, strength: "none", why: `several tenants share the binding "${wire.binding}", so compose hands "${wire.from}" the bundle's declared socket, and no tenant's instance binds it: what answers there is the operator's own dispatch` };
    }
    if (undeclared.length) {
      return {
        over,
        strength: "none",
        why: `${quoted(undeclared)} also ${undeclared.length === 1 ? "mounts" : "mount"} ${dir} (for a socket of ${undeclared.length === 1 ? "its" : "their"} own there, or a wire to another bundle that binds there) with no wire to this socket, and can open it. A directory of its own would hold it`,
      };
    }
    return {
      over,
      strength: "capability",
      why: `${dir} is mounted only into ${quoted(bound)} and its declared ${callers.length === 1 ? "caller" : "callers"} ${quoted(callers)}: a bundle with no wire has no path to the socket. A caller that relays requests extends this to whoever can reach it, which is that caller's own edge`,
    };
  }
  const http = httpEdgeOf(wire, nets);
  if (http) {
    const over = `HTTP port ${http.port} at ${http.address}`;
    if (http.kind === "unaddressed") {
      return { over, strength: "none", why: `${http.reason}, so compose hands "${wire.from}" an address nothing answers at` };
    }
    if (http.kind === "namespace") {
      return { over, strength: "none", why: `"${wire.to}" runs inside "${wire.from}"'s network namespace. Who else reaches it depends on the address it listens on, and compose does not constrain that: on any address but loopback, every container on a network "${wire.from}" is on can` };
    }
    const { network, undeclared } = networkExposure(http, nets, services);
    if (undeclared.length) {
      return { over, strength: "none", why: `${quoted(undeclared)} ${undeclared.length === 1 ? "shares" : "share"} the network namespace of an end of this wire, so ${undeclared.length === 1 ? "it is" : "they are"} on network ${network} too, with no wire to "${wire.to}"` };
    }
    return {
      over,
      strength: "capability",
      why: `only "${wire.from}" and "${wire.to}" are on network ${network}, and no container is on a shared one, so a bundle with no wire has no route to the port. The network joins them both ways: "${wire.to}" can reach "${wire.from}"'s ports too`,
    };
  }
  if (external?.httpPort > 0) {
    return { over: `HTTP port ${external.httpPort}`, strength: "none", why: `"${wire.from}" has no container of its own, so compose attaches nothing to a network for it and hands it no address` };
  }
  return { over: "no address", strength: "none", why: "the target declares neither a socket nor a port, so compose hands the source no address" };
}

/**
 * A connection between two compose bundles: what the network plan says holds
 * it (ADR-0075 §7). The same answer a wire over HTTP gets, because it is
 * carried the same way.
 */
function composeConnection(c, nets, services) {
  const edge = connectionEdgeOf(c.from, c.name, nets);
  if (!edge) return { strength: "none", why: `the compose file is written for env "${nets.env}", and this connection has no target there` };
  if (edge.kind !== "network") return { strength: "none", why: `${edge.reason}, so compose cannot carry it` };
  const { network, undeclared } = networkExposure(edge, nets, services);
  if (undeclared.length) {
    return { strength: "none", why: `${quoted(undeclared)} ${undeclared.length === 1 ? "shares" : "share"} the network namespace of an end of this connection, so ${undeclared.length === 1 ? "it is" : "they are"} on network ${network} too, with no connection to "${edge.to}"` };
  }
  return {
    strength: "capability",
    why: `only "${edge.from}" and "${edge.to}" are on network ${network}, and no container is on a shared one, so a bundle with no connection has no route to the port. The network joins them both ways: "${edge.to}" can reach "${edge.from}"'s ports too`,
  };
}

/** Why a connection edge has the strength it has, from the kinds of its ends. */
function connectionWhy(fromKind, toKind, strength, unwritten) {
  if (fromKind === null || toKind === null) {
    return "an end has no placement in this environment, so nothing lowers the edge";
  }
  if (unwritten.length) {
    return `${unwritten.map((name) => `"${name}"`).join(" and ")} ${unwritten.length === 1 ? "names" : "name"} no manifest here, so cloister writes no policy for it: what holds this edge is whatever its plan applies`;
  }
  if (!joinable(fromKind, toKind)) {
    return `no emitter joins a ${fromKind} bundle to a ${toKind} one: that needs a broker`;
  }
  if (strength === "capability") return "the host runtime hands the socket to the declared caller and to no one else";
  if (strength === "policy") return "a NetworkPolicy on the target admits the declared callers and refuses the rest";
  if (toKind === "knative") return "requests arrive through Knative's ingress, which does not tell callers apart";
  return `nothing cloister writes for a ${toKind} placement refuses an undeclared caller`;
}

/**
 * Every edge cluster.toml declares, for one environment.
 *
 * @param {object} cluster a parsed cluster (the zod shape)
 * @param {string} env the environment connections are read for. Wires are not
 *   per-environment: they describe the compose cluster.
 * @returns {{env: string, edges: Array, elsewhere: Array, counts: Record<string, number>}}
 *   `elsewhere` lists connections with no target in `env`, so none is dropped
 *   without a word.
 */
export function clusterGraph(cluster, env) {
  const bundles = new Map((cluster.bundles ?? []).map((b) => [b.name, checkableBundle(b)]));
  // Edges of the compose cluster are read against what compose runs.
  const view = composeView(cluster);
  const plan = socketPlan(view.cluster);
  const nets = networkPlan(view.cluster, view.env);
  const services = bundleServices(view.cluster);
  const edges = [];
  const elsewhere = [];

  for (const c of normalizeConnections(cluster.connections ?? [])) {
    const target = c.targets.find((t) => t.env === env);
    if (!target) {
      elsewhere.push({ from: c.from, name: c.name, envs: c.targets.map((t) => t.env) });
      continue;
    }
    const fromKind = placementFor(bundles.get(c.from), env);
    const toKind = placementFor(bundles.get(target.bundle), env);
    // An end whose placement reads a manifest, and names none, is described
    // somewhere else (a plan). cloister writes nothing for it.
    const unwritten = [[c.from, fromKind], [target.bundle, toKind]]
      .filter(([name, kind]) => MANIFEST_KINDS.includes(kind) && placementManifest(bundles.get(name), env) === "")
      .map(([name]) => name);
    const lowered = fromKind !== null && toKind !== null && joinable(fromKind, toKind) && unwritten.length === 0;
    // Between two compose bundles the strength is a fact about this edge,
    // read from the network plan the emitter attaches services from.
    const composed = fromKind === "compose" && toKind === "compose" ? composeConnection(c, nets, services) : null;
    const strength = composed ? composed.strength : lowered ? edgeStrength(fromKind, toKind) : "none";
    edges.push({
      from: c.from,
      to: target.bundle,
      declaredAs: "connection",
      name: c.name,
      carrier: `${fromKind ?? "unplaced"} → ${toKind ?? "unplaced"}, port "${target.port}"`,
      strength,
      // "none" when cluster.toml asks for no minimum: every edge meets it.
      minStrength: c.minStrength || "none",
      meetsMinimum: STRENGTHS.indexOf(strength) >= STRENGTHS.indexOf(c.minStrength || "none"),
      why: composed ? composed.why : connectionWhy(fromKind, toKind, strength, unwritten),
    });
  }

  const declared = new Map((cluster.bundles ?? []).map((b) => [b.name, b]));
  for (const w of cluster.wires ?? []) {
    const notRun = [w.from, w.to].map((end) => view.skipped.find((s) => s.name === end)).find(Boolean);
    const reach = notRun
      ? { over: "no address", strength: "none", why: `compose does not run "${notRun.name}": ${notRun.reason}. A wire is an edge of the compose cluster, so this one is carried nowhere` }
      : wireReach(w, declared, plan, nets, services);
    edges.push({
      from: w.from,
      to: w.to,
      declaredAs: "wire",
      name: w.binding,
      carrier: `${WIRE_PLACEMENT}, binding ${w.binding}, ${reach.over}`,
      strength: reach.strength,
      // A wire cannot ask for a strength yet (ADR-0075 §4).
      minStrength: "none",
      meetsMinimum: true,
      why: reach.why,
    });
  }

  const counts = Object.fromEntries(STRENGTHS.map((s) => [s, edges.filter((e) => e.strength === s).length]));
  return { env, edges, elsewhere, counts };
}

/** The graph as lines for a person: one edge, then what holds it. */
export function renderGraph(graph) {
  const lines = [];
  const total = graph.edges.length;
  lines.push(`${total} ${total === 1 ? "edge" : "edges"} for env "${graph.env}": ` + [...STRENGTHS].reverse().map((s) => `${graph.counts[s]} ${s}`).join(", "));
  for (const e of graph.edges) {
    lines.push("");
    lines.push(`${e.from} → ${e.to}   [${e.strength}]   ${e.declaredAs} "${e.name}"`);
    lines.push(`  carried: ${e.carrier}`);
    lines.push(`  held by: ${e.why}`);
    if (!e.meetsMinimum) lines.push(`  BELOW its minStrength "${e.minStrength}"`);
  }
  if (graph.elsewhere.length) {
    lines.push("");
    lines.push(`Not in env "${graph.env}":`);
    for (const c of graph.elsewhere) {
      lines.push(`  ${c.from} → connection "${c.name}" has targets only for ${c.envs.length ? c.envs.map((x) => `"${x}"`).join(", ") : "no environment"}`);
    }
  }
  return lines.join("\n");
}
