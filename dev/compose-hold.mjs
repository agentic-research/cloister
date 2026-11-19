#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// dev/compose-hold.mjs — start what `emit-compose` writes, and see that the
// graph's word for each wire is true of running containers (ADR-0075 §5).
//
// Every other test of this stops at the YAML. This one runs it:
//
//   1. test/e2e/compose-hold/cluster.toml is emitted as a compose file
//   2. `docker compose up` starts it
//   3. for every wire to a socket, EVERY other container tries to connect
//
// (and, first, docker parses every compose file the repository commits)
//
// and each attempt must come out the way `cloister cluster graph` says:
//
//   - a declared caller connects
//   - where the graph says `capability`, a bundle with no wire is refused,
//     and refused because the path does not exist in its container
//   - where the graph says `none` and names who else can open the socket,
//     that bundle really can
//   - one tenant's instance of a `perTenant` bundle cannot open another's
//   - a target reached over HTTP answers its declared callers, and no one
//     else has a route: by its name, at its addresses, or through the host
//     at the published port (ADR-0075 §6)
//
// The refusals are what matter. Without them this would pass on a compose
// file that mounts everything everywhere, and `capability` would be a word.
// So the run fails if it observed no refusal, or no named bundle getting in.
//
// Needs docker with the compose plugin. Run from the repository root:
// `task smoke:compose-hold`. KEEP_CLUSTER=1 leaves the containers up.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitCompose } from "../cli/lib/cluster/emit-compose.mjs";
import { clusterGraph, renderGraph } from "../cli/lib/cluster/graph.mjs";
import { composeView } from "../cli/lib/cluster/compose-placement.mjs";
import { PUBLISH_ADDRESS, edgePortsOf, networkExposure, networkPlan } from "../cli/lib/cluster/http-networks.mjs";
import { bundleServices, socketExposure, socketPlan } from "../cli/lib/cluster/socket-dirs.mjs";
import { parseTomlToCluster } from "../cli/lib/cluster/toml-to-cluster.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "test/e2e/compose-hold/cluster.toml");
const say = (line) => console.log(`compose-hold: ${line}`);
const fail = (line) => { console.error(`compose-hold: FAIL: ${line}`); process.exitCode = 1; };

const declared = await parseTomlToCluster(readFileSync(INPUT, "utf8"));
const graph = clusterGraph(declared, "local");
const view = composeView(declared);
const work = mkdtempSync(join(tmpdir(), "cloister-compose-hold-"));
const file = join(work, "cluster.compose.yaml");
writeFileSync(file, emitCompose(declared));
say(`wrote ${file}`);
console.log(renderGraph(graph));

const compose = (...args) => execFileSync("docker", ["compose", "-f", file, ...args], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

// One line of Python, run inside a container: connect, read the greeting, and
// print either what came back or the NAME of the error. The name is the
// evidence: FileNotFoundError means the path is not in this container at all.
const TRY = 'import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.settimeout(5)\ntry:\n    s.connect(sys.argv[1])\n    print("connected:" + s.recv(16).decode())\nexcept OSError as e:\n    print("refused:" + type(e).__name__)\n';
function attempt(service, socketPath) {
  const run = spawnSync("docker", ["compose", "-f", file, "exec", "-T", service, "python3", "-c", TRY, socketPath], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`could not run the attempt inside "${service}": ${run.stderr.trim() || `exit ${run.status}`}`);
  return run.stdout.trim();
}

// Every compose file this repository commits is one the emitter wrote. Have
// docker itself parse each: a mount line or a volume it cannot read fails
// here, not on someone's `compose up`.
const committed = execFileSync("git", ["-C", ROOT, "ls-files", "--", "cluster.compose.yaml", "recipes/*/cluster.compose.yaml"], { encoding: "utf8" }).split("\n").filter(Boolean);
if (committed.length < 2) fail(`expected this repository's compose file and its recipes', found ${committed.length}`);
for (const path of committed) {
  const parsed = spawnSync("docker", ["compose", "-f", join(ROOT, path), "config", "--quiet"], { encoding: "utf8" });
  if (parsed.status === 0) say(`ok    docker parses      ${path}`);
  else fail(`docker cannot read ${path}: ${parsed.stderr.trim()}`);
}

// The same over HTTP: fetch a URL from inside a container.
const GET = 'import sys,urllib.request\ntry:\n    print("http:%d" % urllib.request.urlopen(sys.argv[1], timeout=3).status)\nexcept Exception as e:\n    r = getattr(e, "reason", e)\n    print("refused:" + type(r).__name__)\n';
function fetchFrom(service, url) {
  const run = spawnSync("docker", ["compose", "-f", file, "exec", "-T", service, "python3", "-c", GET, url], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`could not run the fetch inside "${service}": ${run.stderr.trim() || `exit ${run.status}`}`);
  return run.stdout.trim();
}
// The host, as a container sees it: its default route's gateway.
const GATEWAY = 'import socket,struct\nfor l in open("/proc/net/route").read().splitlines()[1:]:\n    f = l.split()\n    if f[1] == "00000000":\n        print(socket.inet_ntoa(struct.pack("<L", int(f[2], 16))))\n        break\n';
function gatewayOf(service) {
  const run = spawnSync("docker", ["compose", "-f", file, "exec", "-T", service, "python3", "-c", GATEWAY], { encoding: "utf8" });
  const gateway = run.stdout.trim();
  if (run.status !== 0 || !gateway) throw new Error(`could not read the default gateway inside "${service}"`);
  return gateway;
}

// The emitter writes `pull_policy: never`, so the images are fetched here.
for (const image of new Set(view.cluster.bundles.map((b) => b.kind.external.image))) {
  say(`pulling ${image}`);
  execFileSync("docker", ["pull", "--quiet", image], { stdio: "inherit" });
}

let refusals = 0;
let namedEntries = 0;
let declaredOk = 0;
let published = 0;
let unpublished = 0;
try {
  compose("up", "--detach", "--wait");
  const services = compose("config", "--services").split("\n").filter(Boolean).sort();

  // Compose is a placement: what is running is what the view says, no more.
  const running = compose("ps", "--services", "--status", "running").split("\n").filter(Boolean).sort();
  const expected = [...bundleServices(view.cluster).values()].flat().sort();
  if (JSON.stringify(running) === JSON.stringify(expected)) say(`ok    running            ${running.length} services, the bundles placed compose`);
  else fail(`running services [${running.join(", ")}] are not the bundles placed compose [${expected.join(", ")}]`);
  if (view.skipped.length === 0) fail("the fixture has no bundle placed elsewhere, so NOT running one was not tried");
  for (const s of view.skipped) {
    if (running.includes(s.name) || services.includes(s.name)) fail(`"${s.name}" is a service, and ${s.reason}`);
    else say(`ok    not run            ${s.name}: ${s.reason}`);
  }

  // From here on, the cluster is the one compose runs.
  const cluster = view.cluster;
  const plan = socketPlan(cluster);

  // A listener binds a moment after its container starts. Wait for each from
  // inside its OWN container, which holds the directory whatever else is true.
  for (const { service, path } of plan.binds) {
    const deadline = Date.now() + 30_000;
    while (attempt(service, path) !== "connected:ok") {
      if (Date.now() > deadline) throw new Error(`"${service}" never served ${path}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Every socket path a wire hands out, tried from EVERY service.
  for (const wire of cluster.wires) {
    const reach = socketExposure(wire, plan);
    if (!reach) continue;
    const edge = graph.edges.find((e) => e.declaredAs === "wire" && e.from === wire.from && e.to === wire.to && e.name === wire.binding);
    for (const service of services) {
      if (reach.bound.includes(service)) continue;
      const got = attempt(service, reach.path);
      const line = `${service} → ${reach.path} (wire ${wire.binding}): ${got}`;
      if (reach.callers.includes(service)) {
        if (got === "connected:ok") { declaredOk += 1; say(`ok    declared caller    ${line}`); }
        else fail(`a declared caller could not connect: ${line}`);
      } else if (edge.strength === "capability") {
        if (got === "refused:FileNotFoundError") { refusals += 1; say(`ok    refused, no path   ${line}`); }
        else fail(`the graph says "capability", and a service with no wire got "${got}": ${line}`);
      } else if (edge.why.includes(`"${service}"`)) {
        if (got === "connected:ok") { namedEntries += 1; say(`ok    open, as stated    ${line}`); }
        else fail(`the graph names "${service}" as able to open this socket, and it could not: ${line}`);
      } else if (got === "refused:FileNotFoundError") {
        say(`ok    refused, no path   ${line}`);
      } else {
        fail(`"${service}" opened a socket the graph does not say it can: ${line}`);
      }
    }
  }
  // ── Over HTTP ────────────────────────────────────────────────────────────
  // For each target a wire reaches over HTTP: its callers get a page. So does
  // a container the graph names as sharing a caller's namespace. No one else
  // has a route, tried three ways: by the target's name, by each address the
  // target's container has, and through the host's address at the published
  // port. The last must fail for EVERYONE, callers included: a port published
  // on loopback is not reachable from a container at all.
  const nets = networkPlan(cluster);
  const serviceMap = bundleServices(cluster);
  for (const target of new Set(nets.edges.filter((e) => e.kind === "network").map((e) => e.to))) {
    const edges = nets.edges.filter((e) => e.to === target && e.kind === "network");
    const port = edges[0].port;
    const allowed = new Set(edges.flatMap((e) => serviceMap.get(e.from)));
    const named = new Set(edges.flatMap((e) => networkExposure(e, nets, serviceMap).undeclared));
    const addresses = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", `cloister-${target}`], { encoding: "utf8" }));
    const ips = Object.values(addresses).map((n) => n.IPAddress).filter(Boolean);
    if (ips.length === 0) throw new Error(`"${target}" has no address to try`);

    const deadline = Date.now() + 30_000;
    while (fetchFrom(target, `http://127.0.0.1:${port}/`) !== "http:200") {
      if (Date.now() > deadline) throw new Error(`"${target}" never served port ${port}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    // On the host only if the bundle declares the port `edge`.
    const isEdge = edgePortsOf(cluster.bundles.find((b) => b.name === target)).some((p) => p.port === port);
    const fromHost = await fetch(`http://${PUBLISH_ADDRESS}:${port}/`).then((r) => `http:${r.status}`, (e) => `refused:${e.cause?.code ?? e.name}`);
    if (isEdge) {
      published += 1;
      if (fromHost === "http:200") say(`ok    published (edge)   host → ${PUBLISH_ADDRESS}:${port}: ${fromHost}`);
      else fail(`"${target}" declares port ${port} edge, and the host got "${fromHost}"`);
    } else {
      unpublished += 1;
      if (fromHost.startsWith("refused:")) say(`ok    not published      host → ${PUBLISH_ADDRESS}:${port}: ${fromHost}`);
      else fail(`"${target}" declares no edge port ${port}, and the host got "${fromHost}"`);
    }

    for (const service of services) {
      if (service === target) continue;
      const byName = fetchFrom(service, `http://${target}:${port}/`);
      const line = `${service} → http://${target}:${port} : ${byName}`;
      if (allowed.has(service)) {
        if (byName === "http:200") { declaredOk += 1; say(`ok    declared caller    ${line}`); }
        else fail(`a declared caller got no page: ${line}`);
      } else if (named.has(service)) {
        if (byName === "http:200") { namedEntries += 1; say(`ok    open, as stated    ${line}`); }
        else fail(`the graph names "${service}" as on this network, and it got no page: ${line}`);
      } else {
        const tries = [["by name", byName], ...ips.map((ip) => [`at ${ip}`, fetchFrom(service, `http://${ip}:${port}/`)])];
        for (const [how, got] of tries) {
          if (got.startsWith("refused:")) { refusals += 1; say(`ok    refused, no route  ${service} → ${target} ${how}: ${got}`); }
          else fail(`"${service}" has no wire to "${target}" and got "${got}" ${how}`);
        }
      }
      const gateway = gatewayOf(service);
      const viaHost = fetchFrom(service, `http://${gateway}:${port}/`);
      if (viaHost.startsWith("refused:")) say(`ok    not via the host   ${service} → ${gateway}:${port}: ${viaHost}`);
      else fail(`"${service}" reached the published port through the host's address ${gateway}: ${viaHost}`);
    }
  }
  if (nets.edges.filter((e) => e.kind === "network").length === 0) fail("the fixture has no wire carried over a network, so HTTP was not tried");
  if (published === 0) fail("the fixture has no HTTP target with an edge port, so publishing was not tried");
  if (unpublished === 0) fail("the fixture has no HTTP target without an edge port, so NOT publishing was not tried");

  // The claim that matters most for tenants, stated on its own so that a
  // fixture without two tenants cannot pass it by having nothing to try.
  const tenantBinds = plan.binds.filter((b) => b.tenant !== "");
  if (tenantBinds.length < 2) fail("the fixture has fewer than two tenant instances, so tenants were not tried against each other");
  for (const mine of tenantBinds) {
    for (const theirs of tenantBinds) {
      if (mine === theirs) continue;
      const got = attempt(mine.service, theirs.path);
      if (got === "refused:FileNotFoundError") say(`ok    tenant kept out    ${mine.service} → ${theirs.path}: ${got}`);
      else fail(`tenant instance "${mine.service}" got "${got}" on another tenant's socket ${theirs.path}`);
    }
  }
  if (declaredOk === 0) fail("no declared caller was tried");
  if (refusals === 0) fail("no refusal was observed, so `capability` was not tested");
  if (namedEntries === 0) fail("no bundle the graph names as able to open a shared directory was tried, so `none` was not tested");
} catch (error) {
  fail(error.message);
  try { console.error(compose("ps", "--all")); console.error(compose("logs", "--tail", "40")); } catch { /* lint-allow-silent: diagnostics for a failure already reported */ }
} finally {
  if (process.env.KEEP_CLUSTER === "1") say(`left up: docker compose -f ${file} down -v`);
  else compose("down", "--volumes", "--timeout", "1");
}
if (process.exitCode !== 1) say(`passed: ${declaredOk} declared, ${refusals} refused, ${namedEntries} open as the graph states`);
