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
  STRENGTHS,
  checkableBundle,
  edgeStrength,
  joinable,
  normalizeConnections,
  placementFor,
} from "./connections.mjs";

/** The placement a wire runs in: what `cloister cluster up` starts. */
export const WIRE_PLACEMENT = "compose";

/**
 * What holds a wire under compose: nothing.
 *
 * `emit-compose` gives every container the one socket volume, and that volume
 * holds every bundle's socket. A wire sets the address its source is handed;
 * it does not stop a bundle with no wire from opening the same path. The
 * bundle-isolation rails (Inv 1, 4, 5) hold the WORKER's bindings to the
 * wires, which is a different thing: they bound what the gateway's own code
 * can name, not what a container beside it can dial.
 *
 * `cli/test/cluster/graph.test.mjs` ties this to the emitter: when compose
 * stops sharing one volume, that test fails and this is what changes.
 */
export const WIRE_STRENGTH = "none";

/**
 * How compose reaches a wire's target, and so why nothing holds the edge.
 * The same test `emit-compose` uses to pick the address it hands the source:
 * a socket path if the target declares one, else its HTTP port.
 */
function wireReach(target) {
  const external = target?.kind?.external;
  if (external?.ipcSocket) {
    return {
      over: `socket ${external.ipcSocket}`,
      why: "every bundle mounts the one socket volume, so a bundle with no wire to this one can open the same socket",
    };
  }
  if (external?.httpPort > 0) {
    return {
      over: `HTTP port ${external.httpPort}`,
      why: "it is reached over a network compose shares between containers, and nothing there checks which bundle is calling",
    };
  }
  return { over: "no address", why: "the target declares neither a socket nor a port, so compose hands the source no address" };
}

/** Why a connection edge has the strength it has, from the kinds of its ends. */
function connectionWhy(fromKind, toKind, strength) {
  if (fromKind === null || toKind === null) {
    return "an end has no placement in this environment, so nothing lowers the edge";
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
    const lowered = fromKind !== null && toKind !== null && joinable(fromKind, toKind);
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
      why: connectionWhy(fromKind, toKind, strength),
    });
  }

  const declared = new Map((cluster.bundles ?? []).map((b) => [b.name, b]));
  for (const w of cluster.wires ?? []) {
    const reach = wireReach(declared.get(w.to));
    edges.push({
      from: w.from,
      to: w.to,
      declaredAs: "wire",
      name: w.binding,
      carrier: `${WIRE_PLACEMENT}, binding ${w.binding}, ${reach.over}`,
      strength: WIRE_STRENGTH,
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
