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
import { socketDirs, socketExposure } from "./socket-dirs.mjs";

/** The placement a wire runs in: what `cloister cluster up` starts. */
export const WIRE_PLACEMENT = "compose";

const quoted = (names) => names.map((name) => `"${name}"`).join(" and ");

/**
 * How compose carries a wire, and what holds it.
 *
 * The address is chosen by the same test `emit-compose` uses: a socket path
 * if the target declares one, else its HTTP port. For a socket, who holds it
 * is read from `socket-dirs.mjs`, the function the emitter mounts volumes
 * from, so this cannot describe a compose file other than the one written.
 *
 * A wire is `capability` only when every container that mounts the target's
 * socket directory is the target or one of its declared callers. Any other
 * holder, and the answer is `none` with that holder named.
 *
 * The bundle-isolation rails (Inv 1, 4, 5) hold the WORKER's bindings to the
 * wires, which is a different thing: they bound what the gateway's own code
 * can name, not what a container beside it can dial.
 */
function wireReach(cluster, wire, declared, dirs) {
  const target = declared.get(wire.to);
  const source = declared.get(wire.from);
  const external = target?.kind?.external;
  if (external?.ipcSocket) {
    const over = `socket ${external.ipcSocket}`;
    if (!(source?.kind && "external" in source.kind)) {
      return { over, strength: "none", why: `"${wire.from}" has no container of its own, so compose mounts the socket's directory into nothing for it and hands it no address` };
    }
    const { dir, callers, undeclared } = socketExposure(cluster, wire.to, dirs);
    if (undeclared.length) {
      return {
        over,
        strength: "none",
        why: `${quoted(undeclared)} also ${undeclared.length === 1 ? "mounts" : "mount"} ${dir} (for a socket of ${undeclared.length === 1 ? "its" : "their"} own there, or a wire to another bundle that binds there) with no wire to "${wire.to}", and can open this socket. A directory of its own would hold it`,
      };
    }
    if (target.perTenant === true) {
      return { over, strength: "none", why: `every tenant's instance of "${wire.to}" binds in ${dir}, so one tenant's instance can open another's socket` };
    }
    return {
      over,
      strength: "capability",
      why: `${dir} is mounted only into "${wire.to}" and its declared ${callers.length === 1 ? "caller" : "callers"} ${quoted(callers)}: a bundle with no wire has no path to the socket. A caller that relays requests extends this to whoever can reach it, which is that caller's own edge`,
    };
  }
  if (external?.httpPort > 0) {
    return {
      over: `HTTP port ${external.httpPort}`,
      strength: "none",
      why: "it is reached over a network compose shares between containers, and nothing there checks which bundle is calling",
    };
  }
  return { over: "no address", strength: "none", why: "the target declares neither a socket nor a port, so compose hands the source no address" };
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
    const strength = lowered ? edgeStrength(fromKind, toKind) : "none";
    edges.push({
      from: c.from,
      to: target.bundle,
      declaredAs: "connection",
      name: c.name,
      carrier: `${fromKind ?? "unplaced"} → ${toKind ?? "unplaced"}, port "${target.port}"`,
      strength,
      minStrength: c.minStrength,
      meetsMinimum: c.minStrength === "" || STRENGTHS.indexOf(strength) >= STRENGTHS.indexOf(c.minStrength),
      why: connectionWhy(fromKind, toKind, strength, unwritten),
    });
  }

  const declared = new Map((cluster.bundles ?? []).map((b) => [b.name, b]));
  const dirs = socketDirs(cluster);
  for (const w of cluster.wires ?? []) {
    const reach = wireReach(cluster, w, declared, dirs);
    edges.push({
      from: w.from,
      to: w.to,
      declaredAs: "wire",
      name: w.binding,
      carrier: `${WIRE_PLACEMENT}, binding ${w.binding}, ${reach.over}`,
      strength: reach.strength,
      // A wire cannot ask for a strength yet (ADR-0075 §4).
      minStrength: "",
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
