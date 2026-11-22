#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister cluster up|down` — bring a declared cluster up, and take it down.
// `cloister cluster k8s` — lower kubernetes placements (ADR-0070 §4).
//
// ── Why this is a CLI verb and not (only) a Taskfile task ──────────────────
//
// `task cluster:up` originally worked only in THIS repo. Early scaffolded
// clusters (`cloister init --recipe … --out <dir>`) shipped `cluster.toml`,
// `cloister.capnp` and `cluster.compose.yaml` but no Taskfile, even though their
// README told an operator to run a task there:
//
//     $ cd <scaffolded>; task dev
//     task: No Taskfile found at ""
//
// The command lives here so a cluster the operator owns is runnable from the
// CLI. Cloister's Taskfile and the scaffold's Taskfile both delegate here, so
// there is one implementation of "bring a cluster up" rather than one per
// directory.
//
// ── Why it takes --dir ─────────────────────────────────────────────────────
//
// The near-term shape is one cloister running MANY tools. The shape after that
// is many cloisters — and a verb that only ever operates on the current working
// directory quietly forecloses the second. `--dir` costs nothing now and means
// the multi-cluster case is a loop rather than a rewrite.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { FlagsError, parseFlags } from "../lib/flags.mjs";

/** The `cluster` subcommands, each parsed from its declaration in cli/surface.mjs. */
export const DECLARED_PARSE = Object.freeze(["generate", "resolve", "up", "down", "k8s", "lower", "graph"]);
import { startedAsScript } from "../lib/started-as-script.mjs";
import { helpFor } from "../help.mjs";

export class ClusterUsageError extends Error {}

/** Compose runtimes, in the order cloister's Taskfile has always tried them. */
export const COMPOSE_RUNTIMES = Object.freeze([
  { bin: "nerdctl", args: ["compose"] },
  { bin: "podman", args: ["compose"] },
  { bin: "docker", args: ["compose"] },
]);

/**
 * Pick a compose runtime, or explain what to install.
 *
 * `COMPOSE_CMD` overrides — the same env var the Taskfile honours, so an
 * operator's existing muscle memory keeps working.
 *
 * @param {{env?: Record<string,string|undefined>, which?: (bin: string) => boolean}} [deps]
 */
export function resolveComposeCmd(deps = {}) {
  const env = deps.env ?? process.env;
  if (env.COMPOSE_CMD) return env.COMPOSE_CMD.split(/\s+/).filter(Boolean);
  const has = deps.which ?? ((bin) => {
    const r = spawnSyncSafe("which", [bin]);
    return r === 0;
  });
  for (const rt of COMPOSE_RUNTIMES) {
    if (has(rt.bin)) return [rt.bin, ...rt.args];
  }
  throw new ClusterUsageError(
    `no compose-capable runtime found (tried ${COMPOSE_RUNTIMES.map((r) => r.bin).join(", ")}). ` +
    `Install one, or set COMPOSE_CMD to the command that runs compose here.`,
  );
}

function spawnSyncSafe(bin, args) {
  try { return spawnSync(bin, args, { stdio: "ignore" }).status; } catch { return 1; }
}

/**
 * Parse `cloister cluster <sub> …`: each subcommand's flags from its
 * declaration in cli/surface.mjs (ADR-0077 Part 3), and only those. A flag the
 * declaration gives no default and the user does not give keeps the base value
 * here, so `env` and `out` stay null when absent: `up` without `--env` is the
 * compose path, as it always was.
 *
 * @param {string[]} argv
 * @returns {{help:boolean, sub:string|null, dir:string, check:boolean, detach:boolean, destroy:boolean, locked:boolean, passthrough:string[], env:string|null, out:string|null, json:boolean}}
 */
export function parseArgs(argv) {
  const base = {
    help: false, sub: null, dir: ".", check: false, detach: false, destroy: false, locked: false, passthrough: [],
    env: null, out: null, json: false,
  };
  const [sub, ...rest] = argv;
  if (sub === undefined) return base;
  if (!DECLARED_PARSE.includes(sub)) {
    throw new ClusterUsageError(sub.startsWith("-") ? `unknown option ${JSON.stringify(sub)}` : `unexpected argument ${JSON.stringify(sub)}`);
  }
  let flags;
  try {
    flags = parseFlags(`cluster ${sub}`, rest);
  } catch (error) {
    if (error instanceof FlagsError) throw new ClusterUsageError(error.message);
    throw error;
  }
  const given = Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined));
  return { ...base, sub, ...given };
}

/**
 * The compose file a cluster directory must carry.
 *
 * Checked BEFORE spawning, so a directory that is not a cluster gets a sentence
 * naming what is missing rather than compose's own error about a file it cannot
 * find — which reads as a compose problem and sends people to the wrong docs.
 */
export function clusterComposePath(dir) {
  const root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  const file = resolve(root, "cluster.compose.yaml");
  if (!existsSync(file)) {
    throw new ClusterUsageError(
      `no cluster.compose.yaml in ${root}. Either this is not a cluster directory, or it ` +
      `has not been emitted yet — scaffold one with \`cloister init --recipe <name> --out <dir>\`, ` +
      `or run \`cloister cluster generate --dir ${root}\`.`,
    );
  }
  return { root, file };
}

/**
 * `cloister cluster k8s`: read `<root>/cluster.toml`, validate it, lower its
 * kubernetes placements for `env`, and write them under `out`.
 *
 * `out` may already exist, but only holding files this run writes: a stale
 * file from an earlier run (a bundle since removed, a renamed manifest) would
 * otherwise be applied by `kubectl apply -f`, so it is refused by name rather
 * than deleted or silently kept.
 */
/**
 * `cloister cluster lower`: for each bundle placed "kubernetes" or "knative" in `env`,
 * write the manifest its placement row names, from the bundle as cluster.toml
 * declares it (ADR-0074 §7).
 *
 * A manifest that already exists is left alone: it may be one the operator
 * rendered, or a lowered one they have edited. Nothing is ever overwritten.
 */
export async function lowerDir({ root, env }) {
  const { parseTomlToCluster, checkableBundle } = await import("../lib/cluster/toml-to-cluster.mjs");
  const { placementFor, requireManifest } = await import("../lib/cluster/connections.mjs");
  const { kubernetesWorkload, knativeWorkload, LOWERED_KINDS } = await import("../lib/cluster/emit-workload.mjs");
  const { lockedImages } = await import("../lib/oci-artifact.mjs");
  const { parse: parseToml } = await import("smol-toml");
  const cluster = await parseTomlToCluster(readFileSync(resolve(root, "cluster.toml"), "utf8"));
  const bundles = cluster.bundles.map(checkableBundle);
  const connections = cluster.connections ?? [];
  // The lock's image pins, so a lowered workload runs by digest (ADR-0083 §1).
  const lockPath = resolve(root, "cluster.lock.toml");
  const images = existsSync(lockPath) ? lockedImages(parseToml(readFileSync(lockPath, "utf8"))) : new Map();
  const written = [];
  const kept = [];
  const pending = [];
  for (const bundle of cluster.bundles) {
    const checkable = bundles.find((b) => b.name === bundle.name);
    const kind = placementFor(checkable, env);
    if (!LOWERED_KINDS.includes(kind)) continue;
    const manifest = requireManifest(checkable, env, "cloister cluster lower");
    const dest = resolve(root, manifest);
    if (existsSync(dest)) { kept.push(manifest); continue; }
    pending.push({ manifest, dest, content: (kind === "knative" ? knativeWorkload : kubernetesWorkload)(bundle, { bundles, connections, env, images }) });
  }
  // Every manifest is worked out before any is written: a bundle that cannot
  // be lowered stops the run with nothing half-done on disk.
  for (const { manifest, dest, content } of pending) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    written.push(manifest);
  }
  if (written.length === 0 && kept.length === 0) {
    throw new ClusterUsageError(`no bundle is placed "kubernetes" or "knative" for env "${env}"; those are the placements lowering writes a manifest for`);
  }
  return { written, kept };
}

/**
 * Every edge cluster.toml declares, for one environment (ADR-0075).
 * Reads cluster.toml; writes and starts nothing.
 */
export async function graphDir({ root, env }) {
  const { parseTomlToCluster } = await import("../lib/cluster/toml-to-cluster.mjs");
  const { clusterGraph } = await import("../lib/cluster/graph.mjs");
  return clusterGraph(await parseTomlToCluster(readFileSync(resolve(root, "cluster.toml"), "utf8")), env);
}

/** `--locked` refused these (ADR-0083 §5); nothing was written or started. */
export class LockedRefusal extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

export async function emitK8sDir({ root, env, out, locked = false }) {
  const { parseTomlToCluster, checkableBundle } = await import("../lib/cluster/toml-to-cluster.mjs");
  const { lowerK8s } = await import("../lib/cluster/emit-k8s.mjs");
  const cluster = await parseTomlToCluster(readFileSync(resolve(root, "cluster.toml"), "utf8"));
  const { files, applies, checked, references, unreferenced, unread, images: manifests } = lowerK8s({
    bundles: cluster.bundles.map(checkableBundle),
    connections: cluster.connections ?? [],
    env,
    readManifest: (path) => readFileSync(resolve(root, path), "utf8"),
  });
  if (locked) {
    // Before anything is written: a locked lowering applies only pinned images (ADR-0083 §5).
    const { lockedManifestProblems } = await import("../lib/cluster/emit-k8s.mjs");
    const { lockedImages } = await import("../lib/oci-artifact.mjs");
    const { parse: parseToml } = await import("smol-toml");
    const lockPath = resolve(root, "cluster.lock.toml");
    const images = existsSync(lockPath) ? lockedImages(parseToml(readFileSync(lockPath, "utf8"))) : new Map();
    const declared = new Map(cluster.bundles.map((b) => [b.name, b.kind?.external?.image ?? ""]));
    const problems = lockedManifestProblems({ manifests, declared, images });
    if (problems.length > 0) throw new LockedRefusal(problems);
  }
  if (files.length === 0 && checked.length === 0) {
    throw new ClusterUsageError(`no bundle is placed "kubernetes" or "knative" for env "${env}"`);
  }
  const expected = new Set(files.map((f) => f.path));
  const stale = existsSync(out)
    ? readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath ?? d.path, d.name).slice(out.length + 1))
      .filter((p) => !expected.has(p))
      .sort()
    : [];
  if (stale.length > 0) {
    throw new ClusterUsageError(
      `${out} holds files this run would not write (${stale.join(", ")}); ` +
        `kubectl would apply them too. Remove them or choose an empty --out.`,
    );
  }
  for (const f of files) {
    const dest = join(out, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
  // A connection no value names may be one the bundle keeps in a secret.
  const { secretBorne } = await import("../lib/cluster/connections.mjs");
  const inSecret = secretBorne(cluster.bundles);
  return {
    files: files.map((f) => f.path),
    applies,
    checked,
    references,
    unreferenced: unreferenced.map((c) => {
      const declared = inSecret.get(`${c.from}\u0000${c.name}`);
      return declared ? { ...c, declaredIn: declared } : c;
    }),
    unread,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const spawnImpl = deps.spawn ?? spawn;

  // Help is the declaration's (cli/help.mjs), however main is reached.
  const help = helpFor(["cluster", ...argv]);
  if (help !== undefined) {
    log(help);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ClusterUsageError) { errLog(`cloister cluster: ${e.message}`); return 2; }
    throw e;
  }
  if (!args.sub) {
    // `cloister cluster` names no subcommand: say which there are.
    errLog(helpFor(["cluster", "--help"]));
    return 2;
  }

  const selectedRoot = isAbsolute(args.dir) ? args.dir : resolve(process.cwd(), args.dir);
  if (args.sub === "generate") {
    try {
      const generate = deps.generateClusterArtifacts
        ?? (await import("../lib/cluster/generate.mjs")).generateClusterArtifacts;
      const result = await generate({
        root: selectedRoot,
        check: args.check,
        env: deps.env ?? process.env,
        warn: errLog,
      });
      const relative = result.changed.map((file) => file.slice(selectedRoot.length + 1));
      if (args.check && relative.length > 0) {
        for (const file of relative) errLog(`cloister cluster generate: drift: ${file}`);
        return 1;
      }
      if (args.check) log("cloister cluster generate: all projections match cluster.toml");
      else if (relative.length === 0) log("cloister cluster generate: generated files already current");
      else log(`cloister cluster generate: generated ${relative.join(", ")}`);
      return 0;
    } catch (error) {
      errLog(`cloister cluster generate: ${error.message}`);
      return 2;
    }
  }

  if (args.sub === "resolve") {
    try {
      const resolveInputs = deps.resolveClusterInputs
        ?? (await import("../lib/cluster/resolve-inputs.mjs")).resolveClusterInputs;
      const result = await resolveInputs({
        root: selectedRoot,
        fetchImpl: deps.fetchImpl ?? fetch,
        log,
        errLog,
        env: deps.env ?? process.env,
      });
      log(`cloister cluster resolve: ${result.resolvedCount} input(s) pinned`);
      return 0;
    } catch (error) {
      errLog(`cloister cluster resolve: ${error.message}`);
      return 1;
    }
  }

  if (args.sub === "lower") {
    try {
      const env = args.env;
      const { written, kept } = await lowerDir({ root: selectedRoot, env });
      for (const f of written) log(`cloister cluster lower: wrote ${join(args.dir, f)}`);
      for (const f of kept) log(`cloister cluster lower: kept ${join(args.dir, f)} (it exists; a manifest is never overwritten)`);
      log(`  next: cloister cluster k8s --dir ${args.dir} --env ${env} --out <dir>`);
      return 0;
    } catch (error) {
      errLog(`cloister cluster lower: ${error.message}`);
      return error instanceof ClusterUsageError ? 2 : 1;
    }
  }

  if (args.sub === "graph") {
    // Its default, "local", is declared in cli/surface.mjs.
    const env = args.env;
    try {
      const graph = await graphDir({ root: selectedRoot, env });
      if (args.json) {
        const { declaredOutput } = await import("../lib/output-format.mjs");
        log(JSON.stringify(await declaredOutput("Graph", graph), null, 2));
      }
      else {
        const { renderGraph } = await import("../lib/cluster/graph.mjs");
        log(renderGraph(graph));
      }
      return 0;
    } catch (error) {
      errLog(`cloister cluster graph: ${error.message}`);
      return 1;
    }
  }

  if (args.sub === "k8s") {
    try {
      // --out is required and --env defaults to local, both by the declaration.
      const outDir = args.out;
      const written = await emitK8sDir({ root: selectedRoot, env: args.env, out: resolve(process.cwd(), outDir), locked: args.locked });
      for (const f of written.files) log(`cloister cluster k8s: wrote ${join(outDir, f)}`);
      for (const a of written.applies) log(`  kubectl apply ${a.namespace ? `-n ${a.namespace} ` : ""}-f ${join(outDir, a.bundle)}`);
      for (const k of written.checked) {
        const address = `${k.service}${k.namespace ? `.${k.namespace}.svc` : ""}:${k.port}`;
        log(`cloister cluster k8s: checked "${k.bundle}" (knative, strength "none"): reached at ${address} (${k.wire}); its manifest is copied, and no policy is written`);
        for (const c of k.connectionsIn) log(`  connection "${c.name}" from "${c.from}": checked, not enforced`);
      }
      // What the containers' own env, args and command say about the graph.
      for (const r of written.references) {
        const from = `"${r.bundle}" container ${JSON.stringify(r.container)} ${r.where}`;
        if (r.to) {
          log(`cloister cluster k8s: ${from} names ${r.address}: ${r.connections.map((c) => `connection "${c}"`).join(", ")}`);
          if (r.overTls) log(`  it is dialled over TLS on port 443. A Knative Service answers there only where the cluster's Knative has internal encryption turned on, which no manifest shows: check the cluster`);
        }
        else log(`cloister cluster k8s: ${from} names ${r.address}, which is no bundle placed here; not checked`);
      }
      for (const u of written.unread) {
        log(`cloister cluster k8s: "${u.bundle}" container ${JSON.stringify(u.container)} ${u.where} comes from ${u.kind} ${JSON.stringify(u.name)}, which is not in this manifest; not read`);
      }
      for (const c of written.unreferenced) {
        if (c.declaredIn) {
          log(`cloister cluster k8s: connection "${c.name}" from "${c.from}" to "${c.to}": cluster.toml says its address is in secret "${c.declaredIn.secret}" (env ${c.declaredIn.env}). A secret's value is never read, so this edge is declared, not observed`);
        } else {
          log(`cloister cluster k8s: connection "${c.name}" from "${c.from}" to "${c.to}": no env, args or command value names it`);
        }
      }
      return 0;
    } catch (error) {
      if (error instanceof LockedRefusal) {
        for (const problem of error.problems) errLog(`cloister cluster k8s: ${problem}`);
        errLog("cloister cluster k8s: nothing was written");
        return 1;
      }
      errLog(`cloister cluster k8s: ${error.message}`);
      return error instanceof ClusterUsageError ? 2 : 1;
    }
  }

  // `up --env <env>`: start the env's microVM-placed bundles from cluster.toml
  // (ADR-0070 §4). Without --env, `up` is the compose path below, unchanged —
  // scaffolded clusters' Taskfiles call it.
  if (args.sub === "up" && args.env !== null) {
    if (args.detach) {
      errLog("cloister cluster up: --detach is a compose option; `up --env` runs in the foreground (no daemon)");
      return 2;
    }
    // The microVM placement runs only the rootfs the lock records, by digest,
    // so `--locked` changes nothing here (ADR-0083 §5).
    if (args.locked) log("cloister cluster up: --locked: the microVM placement runs only the rootfs cluster.lock.toml records, by digest");
    try {
      const up = deps.clusterUp ?? (await import("../lib/cluster/up.mjs")).clusterUp;
      return await up({ root: selectedRoot, env: args.env, deps: { log, errLog, env: deps.env ?? process.env } });
    } catch (error) {
      errLog(`cloister cluster up: ${error.message}`);
      return 1;
    }
  }

  let root, file, compose;
  try {
    ({ root, file } = clusterComposePath(args.dir));
    compose = deps.composeCmd ?? resolveComposeCmd(deps);
  } catch (e) {
    if (e instanceof ClusterUsageError) { errLog(`cloister cluster: ${e.message}`); return 2; }
    throw e;
  }

  // `up`: every image resolved to a content address when it starts, and
  // recorded on its container (ADR-0083 §4).
  if (args.sub === "up") {
    const { composeUp } = await import("../lib/cluster/compose-up.mjs");
    return await composeUp(
      { root, file, compose, detach: args.detach, locked: args.locked },
      { log, errLog, spawn: spawnImpl, env: deps.env ?? process.env, ...(deps.exec ? { exec: deps.exec } : {}) },
    );
  }

  // Volumes survive by default: a `down` that silently destroyed DO SQLite
  // state would be an unrecoverable action behind a routine-looking verb.
  const composeArgs = ["-f", file, "down", ...(args.destroy ? ["-v"] : [])];

  log(`cloister cluster ${args.sub}: ${compose.join(" ")} ${composeArgs.join(" ")}`);
  if (args.sub === "down" && !args.destroy) {
    log("  (volumes preserved — pass --destroy to remove them too)");
  }

  return await new Promise((res) => {
    const child = spawnImpl(compose[0], [...compose.slice(1), ...composeArgs], {
      cwd: root, stdio: "inherit",
    });
    child.on("error", (e) => { errLog(`cloister cluster: ${e.message}`); res(1); });
    child.on("close", (code) => res(code ?? 0));
  });
}

if (startedAsScript(import.meta.url)) {
  main().then((c) => process.exit(c));
}
