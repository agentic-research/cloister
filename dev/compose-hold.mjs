#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// dev/compose-hold.mjs — start what `emit-compose` writes, and see that the
// graph's word for each wire is true of running containers (ADR-0075 §4.1).
//
// Every other test of this stops at the YAML. This one runs it:
//
//   1. test/e2e/compose-hold/cluster.toml is emitted as a compose file
//   2. `docker compose up` starts it
//   3. for every wire to a socket, EVERY other bundle tries to connect
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
import { parseTomlToCluster } from "../cli/lib/cluster/toml-to-cluster.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "test/e2e/compose-hold/cluster.toml");
const say = (line) => console.log(`compose-hold: ${line}`);
const fail = (line) => { console.error(`compose-hold: FAIL: ${line}`); process.exitCode = 1; };

const cluster = await parseTomlToCluster(readFileSync(INPUT, "utf8"));
const graph = clusterGraph(cluster, "local");
const work = mkdtempSync(join(tmpdir(), "cloister-compose-hold-"));
const file = join(work, "cluster.compose.yaml");
writeFileSync(file, emitCompose(cluster));
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

// The emitter writes `pull_policy: never`, so the images are fetched here.
for (const image of new Set(cluster.bundles.map((b) => b.kind.external.image))) {
  say(`pulling ${image}`);
  execFileSync("docker", ["pull", "--quiet", image], { stdio: "inherit" });
}

let refusals = 0;
let namedEntries = 0;
let declared = 0;
try {
  compose("up", "--detach", "--wait");
  const sockets = new Map(cluster.bundles.filter((b) => b.kind.external.ipcSocket).map((b) => [b.name, b.kind.external.ipcSocket]));

  // A listener binds a moment after its container starts. Wait for each from
  // inside its OWN container, which holds the directory whatever else is true.
  for (const [name, path] of sockets) {
    const deadline = Date.now() + 30_000;
    while (attempt(name, path) !== "connected:ok") {
      if (Date.now() > deadline) throw new Error(`"${name}" never served ${path}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  for (const target of new Set(cluster.wires.map((w) => w.to))) {
    const path = sockets.get(target);
    if (!path) continue;
    const callers = cluster.wires.filter((w) => w.to === target).map((w) => w.from);
    const edge = graph.edges.find((e) => e.declaredAs === "wire" && e.to === target);
    for (const b of cluster.bundles) {
      if (b.name === target) continue;
      const got = attempt(b.name, path);
      const line = `${b.name} → ${target} (${path}): ${got}`;
      if (callers.includes(b.name)) {
        if (got === "connected:ok") { declared += 1; say(`ok    declared caller    ${line}`); }
        else fail(`a declared caller could not connect: ${line}`);
      } else if (edge.strength === "capability") {
        if (got === "refused:FileNotFoundError") { refusals += 1; say(`ok    refused, no path   ${line}`); }
        else fail(`the graph says "capability", and a bundle with no wire got "${got}": ${line}`);
      } else if (edge.why.includes(`"${b.name}"`)) {
        if (got === "connected:ok") { namedEntries += 1; say(`ok    open, as stated    ${line}`); }
        else fail(`the graph names "${b.name}" as able to open this socket, and it could not: ${line}`);
      } else if (got === "refused:FileNotFoundError") {
        say(`ok    refused, no path   ${line}`);
      } else {
        fail(`"${b.name}" opened a socket the graph does not say it can: ${line}`);
      }
    }
  }
  if (declared === 0) fail("no declared caller was tried");
  if (refusals === 0) fail("no refusal was observed, so `capability` was not tested");
  if (namedEntries === 0) fail("no bundle the graph names as able to open a shared directory was tried, so `none` was not tested");
} catch (error) {
  fail(error.message);
  try { console.error(compose("ps", "--all")); console.error(compose("logs", "--tail", "40")); } catch { /* lint-allow-silent: diagnostics for a failure already reported */ }
} finally {
  if (process.env.KEEP_CLUSTER === "1") say(`left up: docker compose -f ${file} down -v`);
  else compose("down", "--volumes", "--timeout", "1");
}
if (process.exitCode !== 1) say(`passed: ${declared} declared, ${refusals} refused, ${namedEntries} open as the graph states`);
