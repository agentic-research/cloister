// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One graph (ADR-0075): connections and wires are shown together, and each
// edge is given the strength its placement really delivers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { main as clusterMain } from "../../commands/cluster.mjs";
import { WIRE_STRENGTH, clusterGraph, renderGraph } from "../../lib/cluster/graph.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cluster = async (path) => parseTomlToCluster(readFileSync(resolve(ROOT, path), "utf8"));

const bundle = (name, kind) => ({ name, kind: { external: {} }, ports: [{ name: "http", port: 8080, appProtocol: "art.http", expose: "cluster" }], placements: [{ env: "local", kind }] });
const connection = (from, to, extra = {}) => ({ from, name: to, appProtocol: "art.http", targets: [{ env: "local", bundle: to, port: "http" }], ...extra });

test("this repository's own cluster: every wire is an edge, and none is held", async () => {
  const graph = clusterGraph(await cluster("cluster.toml"), "local");
  const wires = graph.edges.filter((e) => e.declaredAs === "wire");
  assert.ok(wires.length >= 4, "the gateway's wires are edges of the graph");
  for (const e of wires) {
    assert.equal(e.from, "cloister-router");
    assert.equal(e.strength, "none");
  }
  // The reason is the real one for how compose reaches each target.
  const by = Object.fromEntries(wires.map((e) => [e.to, e]));
  assert.match(by.rosary.carrier, /socket \/run\/cloister-uds\/rosary\.sock/);
  assert.match(by.rosary.why, /one socket volume/);
  assert.match(by["notme-identity"].carrier, /HTTP port 8788/);
  assert.match(by["notme-identity"].why, /nothing there checks which bundle is calling/);
});

// The claim that a wire is not held is a claim about emit-compose. If compose
// stops giving every container the one socket volume, this fails, and
// WIRE_STRENGTH and its reason are what must change with it.
test("a wire is `none` because compose gives every container the same socket volume", () => {
  assert.equal(WIRE_STRENGTH, "none");
  const compose = parseYaml(readFileSync(resolve(ROOT, "cluster.compose.yaml"), "utf8"));
  const services = Object.entries(compose.services);
  assert.ok(services.length >= 2);
  const sharing = services.filter(([, s]) => (s.volumes ?? []).some((v) => String(v).startsWith("cloister-uds:")));
  assert.deepEqual(sharing.map(([name]) => name), services.map(([name]) => name), "a container no longer mounts the shared socket volume: wires may now be held, so update WIRE_STRENGTH (ADR-0075 §3)");
});

test("a connection's strength is what its two placements deliver, with the mechanism named", async () => {
  const kind = clusterGraph(await cluster("test/e2e/lowered-kind/cluster.toml"), "local");
  assert.deepEqual(kind.edges.map((e) => [e.from, e.to, e.strength]), [["caller", "server", "policy"], ["probe", "server", "policy"]]);
  for (const e of kind.edges) assert.match(e.why, /NetworkPolicy/);

  const knative = clusterGraph(await cluster("test/e2e/lowered-knative/cluster.toml"), "local");
  const into = knative.edges.find((e) => e.to === "web");
  const outOf = knative.edges.find((e) => e.from === "web");
  assert.equal(into.strength, "none");
  assert.match(into.why, /Knative's ingress/);
  assert.equal(outOf.strength, "policy");
});

test("an edge nothing lowers is `none`, and says which emitter is missing", () => {
  const graph = clusterGraph({ bundles: [bundle("a", "kubernetes"), bundle("b", "cloudRun")], connections: [connection("a", "b")] }, "local");
  assert.equal(graph.edges[0].strength, "none");
  assert.match(graph.edges[0].why, /no emitter joins a kubernetes bundle to a cloudRun one/);
});

test("an edge below its minStrength is marked, not passed over", () => {
  const graph = clusterGraph({ bundles: [bundle("a", "cloudRun"), bundle("b", "cloudRun")], connections: [connection("a", "b", { minStrength: "policy" })] }, "local");
  assert.equal(graph.edges[0].meetsMinimum, false);
  assert.match(renderGraph(graph), /BELOW its minStrength "policy"/);
  const held = clusterGraph({ bundles: [bundle("a", "kubernetes"), bundle("b", "kubernetes")], connections: [connection("a", "b", { minStrength: "policy" })] }, "local");
  assert.equal(held.edges[0].meetsMinimum, true);
});

test("a connection with no target in the environment is listed, not dropped", () => {
  const c = { ...connection("a", "b"), targets: [{ env: "prod", bundle: "b", port: "http" }] };
  const graph = clusterGraph({ bundles: [bundle("a", "kubernetes"), bundle("b", "kubernetes")], connections: [c] }, "local");
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.elsewhere, [{ from: "a", name: "b", envs: ["prod"] }]);
  assert.match(renderGraph(graph), /has targets only for "prod"/);
});

test("the counts add up to the edges", async () => {
  const graph = clusterGraph(await cluster("test/e2e/lowered-knative/cluster.toml"), "local");
  assert.equal(Object.values(graph.counts).reduce((a, b) => a + b, 0), graph.edges.length);
});

test("`cloister cluster graph` prints the graph, and --json prints it as data", async () => {
  const lines = [];
  const deps = { log: (l) => lines.push(l), errLog: (l) => lines.push(l) };
  assert.equal(await clusterMain(["graph", "--dir", resolve(ROOT, "test/e2e/lowered-kind"), "--env", "local"], deps), 0);
  assert.match(lines.join("\n"), /caller → server {3}\[policy\] {3}connection "server"/);
  lines.length = 0;
  assert.equal(await clusterMain(["graph", "--dir", resolve(ROOT, "test/e2e/lowered-kind"), "--json"], deps), 0);
  assert.equal(JSON.parse(lines.join("\n")).edges.length, 2);
});
