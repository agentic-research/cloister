// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One graph (ADR-0075): connections and wires are shown together, and each
// edge is given the strength its placement really delivers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { main as clusterMain } from "../../commands/cluster.mjs";
import { clusterGraph, renderGraph } from "../../lib/cluster/graph.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cluster = async (path) => parseTomlToCluster(readFileSync(resolve(ROOT, path), "utf8"));

const bundle = (name, kind) => ({ name, kind: { external: {} }, ports: [{ name: "http", port: 8080, appProtocol: "art.http", expose: "cluster" }], placements: [{ env: "local", kind, ...(["kubernetes", "knative"].includes(kind) ? { manifest: `${name}.yaml` } : {}) }] });
const connection = (from, to, extra = {}) => ({ from, name: to, appProtocol: "art.http", targets: [{ env: "local", bundle: to, port: "http" }], ...extra });

test("this repository's own cluster: every wire is an edge, and a socket in a directory of its own is held", async () => {
  const graph = clusterGraph(await cluster("cluster.toml"), "local");
  const wires = graph.edges.filter((e) => e.declaredAs === "wire");
  assert.ok(wires.length >= 5, "the gateway's wires are edges of the graph");
  const strength = Object.fromEntries(wires.map((e) => [`${e.from} → ${e.to}`, e.strength]));
  assert.deepEqual(strength, {
    "cloister-router → mache": "none",
    "cloister-router → rosary": "capability",
    "cloister-router → notme-identity": "none",
    "cloister-router → notme-proxy": "capability",
    // The companion opens rosary's socket for the gateway. That is an edge,
    // so it is declared, and it is what puts the directory in its container.
    "notme-proxy → rosary": "capability",
  });
  const by = Object.fromEntries(wires.filter((e) => e.from === "cloister-router").map((e) => [e.to, e]));
  assert.match(by.rosary.carrier, /socket \/run\/cloister-uds\/rosary\/rosary\.sock/);
  assert.match(by.rosary.why, /mounted only into "rosary" and its declared callers "cloister-router" and "notme-proxy"/);
  // The two HTTP targets are not held, each for the reason that is true of
  // it: mache runs inside the gateway's namespace, which also puts it on the
  // network the gateway shares with notme-identity.
  assert.match(by["notme-identity"].carrier, /HTTP port 8788 at http:\/\/notme-identity:8788/);
  assert.match(by["notme-identity"].why, /"mache" shares the network namespace of an end of this wire/);
  assert.match(by.mache.carrier, /HTTP port 7532 at http:\/\/127\.0\.0\.1:7532/);
  assert.match(by.mache.why, /runs inside "cloister-router"'s network namespace/);
});

// What the graph says about a wire is a claim about the compose file. This
// reads the RENDERED file, works out from its `volumes:` lines alone which
// services can open each socket, and requires the graph to agree. It runs on
// this repository's cluster and on every recipe, so a change to the emitter
// that the graph does not follow fails here.
const RENDERED = ["", ...readdirSync(resolve(ROOT, "recipes"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `recipes/${d.name}/`)]
  .filter((dir) => existsSync(resolve(ROOT, `${dir}cluster.compose.yaml`)) && existsSync(resolve(ROOT, `${dir}cluster.toml`)));

test("a wire to a socket is `capability` exactly when the rendered compose file mounts its directory into no one else", async () => {
  let held = 0;
  let open = 0;
  assert.ok(RENDERED.length >= 4, "the repository's cluster and its recipes are all read");
  for (const dir of RENDERED) {
    const parsed = await cluster(`${dir}cluster.toml`);
    const compose = parseYaml(readFileSync(resolve(ROOT, `${dir}cluster.compose.yaml`), "utf8"));
    const bundleOf = (service) => (service.labels ?? []).map((l) => /^cloister\.bundle=(.+)$/.exec(l)?.[1]).find(Boolean);
    const mounting = (path) => Object.values(compose.services)
      .filter((s) => (s.volumes ?? []).some((v) => String(v).split(":")[1] === path))
      .map(bundleOf);
    const graph = clusterGraph(parsed, "local");
    for (const w of parsed.wires) {
      const socket = parsed.bundles.find((b) => b.name === w.to)?.kind?.external?.ipcSocket;
      if (!socket) continue;
      const callers = parsed.wires.filter((x) => x.to === w.to).map((x) => x.from);
      const others = mounting(posix.dirname(socket)).filter((name) => name !== w.to && !callers.includes(name));
      const edge = graph.edges.find((e) => e.declaredAs === "wire" && e.from === w.from && e.to === w.to);
      const where = `${dir}cluster.toml ${w.from} → ${w.to}`;
      assert.ok(mounting(posix.dirname(socket)).includes(w.to), `${where}: the target mounts its own socket directory`);
      assert.ok(mounting(posix.dirname(socket)).includes(w.from), `${where}: the declared caller mounts the directory`);
      if (others.length === 0) {
        assert.equal(edge.strength, "capability", where);
        held += 1;
      } else {
        assert.equal(edge.strength, "none", where);
        for (const name of others) assert.match(edge.why, new RegExp(`"${name}"`), `${where}: the bundle that can open it is named`);
        open += 1;
      }
    }
  }
  assert.ok(held > 0, "at least one rendered wire is held, so the capability branch ran");
  // Nothing rendered in this repository shares a socket directory with a
  // stranger any more. The `none` branch above still guards a file that does,
  // and the next test drives it with clusters built for the purpose.
  assert.equal(open, 0, "a rendered wire is open to a bundle with no wire to it: give its target a directory of its own");
});

// The same for a wire carried over HTTP, again from the RENDERED file alone:
// who is on a network with the target is read from `networks:` and
// `network_mode:`, and the graph must agree. Two facts the whole scheme rests
// on are checked for every service on the way: none is left on compose's
// shared default network, and every published port is on the host's loopback.
test("a wire over HTTP is `capability` exactly when the rendered compose file puts no one else on a network with its target", async () => {
  let tried = 0;
  for (const dir of RENDERED) {
    const parsed = await cluster(`${dir}cluster.toml`);
    const compose = parseYaml(readFileSync(resolve(ROOT, `${dir}cluster.compose.yaml`), "utf8"));
    const entries = Object.entries(compose.services);
    for (const [name, s] of entries) {
      assert.ok((s.networks ?? []).length > 0 || /^service:/.test(s.network_mode ?? ""), `${dir}${name}: on a network of its own wires, or in another's namespace, never on the shared default`);
      for (const p of s.ports ?? []) assert.match(String(p), /^127\.0\.0\.1:\d+:\d+$/, `${dir}${name}: a published port is on the host's loopback`);
    }
    for (const n of Object.keys(compose.networks ?? {})) assert.notEqual(n, "default", `${dir}: no shared default network is declared`);
    const hostOf = (s) => /^service:(.+)$/.exec(s.network_mode ?? "")?.[1];
    const graph = clusterGraph(parsed, "local");
    for (const w of parsed.wires) {
      const target = parsed.bundles.find((b) => b.name === w.to)?.kind?.external;
      if (!target || target.ipcSocket || !(target.httpPort > 0)) continue;
      tried += 1;
      const edge = graph.edges.find((e) => e.declaredAs === "wire" && e.from === w.from && e.to === w.to);
      const where = `${dir}cluster.toml ${w.from} → ${w.to}`;
      const service = compose.services[w.to];
      if (hostOf(service)) {
        assert.equal(edge.strength, "none", `${where}: a target inside another's namespace is not held`);
        continue;
      }
      const onNetwork = entries.filter(([, s]) => (s.networks ?? []).some((n) => service.networks.includes(n))).map(([name]) => name);
      const reaching = entries.filter(([name, s]) => onNetwork.includes(name) || onNetwork.includes(hostOf(s))).map(([name]) => name);
      const callers = parsed.wires.filter((x) => x.to === w.to).map((x) => x.from);
      const others = reaching.filter((name) => name !== w.to && !callers.includes(name));
      assert.ok(reaching.includes(w.from), `${where}: the declared caller is on a network with the target`);
      if (others.length === 0) assert.equal(edge.strength, "capability", where);
      else {
        assert.equal(edge.strength, "none", where);
        for (const name of others) assert.match(edge.why, new RegExp(`"${name}"`), `${where}: the bundle that can reach it is named`);
      }
    }
  }
  assert.ok(tried >= 4, "the rendered clusters hold HTTP wires, so this ran");
});

test("a wire over HTTP: held on a network of its own, and not when a namespace is shared or nothing answers", () => {
  const ext = (name, extra = {}) => ({ name, kind: { external: { ipcSocket: "", httpPort: 0, ...extra } } });
  const wire = (from, to) => ({ from, to, binding: `${to.toUpperCase().replace(/-/g, "_")}_URL`, transport: "uds" });
  const edge = (c, from, to) => clusterGraph(c, "local").edges.find((e) => e.from === from && e.to === to);

  const alone = { bundles: [ext("a"), ext("web", { httpPort: 80 }), ext("b")], wires: [wire("a", "web")] };
  assert.equal(edge(alone, "a", "web").strength, "capability");
  assert.match(edge(alone, "a", "web").why, /only "a" and "web" are on network wire-a-web/);
  assert.match(edge(alone, "a", "web").why, /both ways/);

  // The one bundle the emitter places in another's namespace, by name.
  const shared = { bundles: [ext("cloister-router"), ext("mache", { httpPort: 7532 }), ext("web", { httpPort: 80 })], wires: [wire("cloister-router", "web"), wire("cloister-router", "mache")] };
  assert.equal(edge(shared, "cloister-router", "web").strength, "none");
  assert.match(edge(shared, "cloister-router", "web").why, /"mache" shares the network namespace/);
  assert.equal(edge(shared, "cloister-router", "mache").strength, "none");

  const stranger = { bundles: [ext("a"), ext("cloister-router"), ext("mache", { httpPort: 7532 })], wires: [wire("a", "mache")] };
  assert.equal(edge(stranger, "a", "mache").strength, "none");
  assert.match(edge(stranger, "a", "mache").why, /has no name of its own on any network/);

  const inProcess = { bundles: [{ name: "w", kind: { workerd: {} } }, ext("web", { httpPort: 80 })], wires: [wire("w", "web")] };
  assert.equal(edge(inProcess, "w", "web").strength, "none");
  assert.match(edge(inProcess, "w", "web").why, /no container of its own/);
});

test("a wire is not held when someone else is in the directory, when tenants share its binding, or when the source has no container", () => {
  const ext = (name, ipcSocket, extra = {}) => ({ name, kind: { external: { ipcSocket, httpPort: 0 } }, ...extra });
  const wire = (from, to) => ({ from, to, binding: `${to.toUpperCase()}_SOCK`, transport: "uds" });
  const edge = (c, from, to) => clusterGraph(c, "local").edges.find((e) => e.from === from && e.to === to);

  const shared = { bundles: [ext("a", "/run/s/a.sock"), ext("b", "/run/s/b.sock"), ext("c", "")], wires: [wire("c", "a")] };
  assert.equal(edge(shared, "c", "a").strength, "none");
  assert.match(edge(shared, "c", "a").why, /"b" also mounts \/run\/s/);

  const apart = { bundles: [ext("a", "/run/s/a/a.sock"), ext("b", "/run/s/b/b.sock"), ext("c", "")], wires: [wire("c", "a")] };
  assert.equal(edge(apart, "c", "a").strength, "capability");

  // A caller of ANOTHER socket in the directory holds this one too.
  const viaWire = { bundles: [ext("a", "/run/s/a.sock"), ext("b", "/run/s/b.sock"), ext("c", ""), ext("d", "")], wires: [wire("c", "a"), wire("d", "b"), wire("c", "b")] };
  assert.match(edge(viaWire, "c", "a").why, /"b" and "d" also mount/);

  // A perTenant bundle is one container per tenant, each in a directory of
  // its own. A wire that reaches one tenant is held; one whose binding
  // several tenants share is handed a socket nothing binds.
  const rows = (...tenants) => [{ path: "/", kind: { tenantDispatch: { tenants: tenants.map(([name, binding]) => ({ name, binding, mode: "sni", matchValue: `${name}.example` })) } } }];
  const perTenant = {
    bundles: [ext("t", "/run/t/t.sock", { perTenant: true }), ext("c", "")],
    wires: [{ ...wire("c", "t"), binding: "T_ALICE" }, { ...wire("c", "t"), binding: "T_BOB" }],
    routes: rows(["alice", "T_ALICE"], ["bob", "T_BOB"]),
  };
  const tenantEdges = clusterGraph(perTenant, "local").edges;
  assert.deepEqual(tenantEdges.map((e) => [e.name, e.strength]), [["T_ALICE", "capability"], ["T_BOB", "capability"]]);
  assert.match(tenantEdges[0].carrier, /socket \/run\/t\/alice\/t\.sock/);
  assert.match(tenantEdges[0].why, /mounted only into "t-alice" and its declared caller "c"/);

  const sharedBinding = { ...perTenant, wires: [{ ...wire("c", "t"), binding: "T_ANY" }], routes: rows(["alice", "T_ANY"], ["bob", "T_ANY"]) };
  assert.equal(edge(sharedBinding, "c", "t").strength, "none");
  assert.match(edge(sharedBinding, "c", "t").why, /no tenant's instance binds it/);

  const inProcess = { bundles: [ext("a", "/run/s/a/a.sock"), { name: "w", kind: { workerd: {} } }], wires: [wire("w", "a")] };
  assert.equal(edge(inProcess, "w", "a").strength, "none");
  assert.match(edge(inProcess, "w", "a").why, /no container of its own/);
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

test("an end that names no manifest is not credited with a policy nobody wrote", () => {
  const unwritten = (name) => ({ ...bundle(name, "kubernetes"), placements: [{ env: "local", kind: "kubernetes" }] });
  const graph = clusterGraph({ bundles: [bundle("a", "kubernetes"), unwritten("b")], connections: [connection("a", "b", { minStrength: "policy" })] }, "local");
  assert.equal(graph.edges[0].strength, "none");
  assert.match(graph.edges[0].why, /"b" names no manifest here, so cloister writes no policy for it/);
  assert.equal(graph.edges[0].meetsMinimum, false);
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
