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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { renderCommandHelp } from "../surface.mjs";

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
 * @param {string[]} argv
 * @returns {{help:boolean, sub:string|null, dir:string, check:boolean, detach:boolean, destroy:boolean, passthrough:string[]}}
 */
export function parseArgs(argv) {
  const out = {
    help: false, sub: null, dir: ".", check: false, detach: false, destroy: false, passthrough: [],
    env: null, out: null, terraform: null, from: null, to: null, name: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--detach" || a === "-d") { out.detach = true; continue; }
    if (a === "--destroy") { out.destroy = true; continue; }
    if (a === "--check") { out.check = true; continue; }
    if (a === "--dir") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new ClusterUsageError("--dir requires a value");
      out.dir = v; i++; continue;
    }
    if (["--env", "--out", "--terraform", "--from", "--to", "--name"].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new ClusterUsageError(`${a} requires a value`);
      out[a.slice(2)] = v; i++; continue;
    }
    if (!out.sub && ["generate", "resolve", "up", "down", "k8s", "lower"].includes(a)) { out.sub = a; continue; }
    if (a.startsWith("-")) throw new ClusterUsageError(`unknown option ${JSON.stringify(a)}`);
    throw new ClusterUsageError(`unexpected argument ${JSON.stringify(a)}`);
  }
  return out;
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
 * `cloister cluster lower`: read a rendered plan, and write a cluster.toml and
 * one Kubernetes manifest per workload into `out` (ADR-0074 §5.3).
 *
 * `out` must be new or empty. These files are meant to be read, edited and
 * committed, so a second run is never allowed to replace an edited one.
 */
export async function lowerPlanDir({ terraform, from, to, name, out, cwd, isGitTracked }) {
  const need = (value, flag, what) => { if (!value) throw new ClusterUsageError(`${flag} is required: ${what}`); };
  need(terraform, "--terraform <file>", "the output of `terraform show -json <planfile>`");
  need(from, "--from <env>", "the environment the plan describes");
  need(to, "--to <env>", "the environment the manifests are for");
  need(out, "--out <dir>", "where the files are written");
  const file = resolve(cwd, terraform);
  if (!existsSync(file)) throw new ClusterUsageError(`no such file: ${terraform}`);
  const inspect = await import("./inspect.mjs");
  const tracked = isGitTracked ?? inspect.isGitTracked;
  if (tracked(file) || tracked(realpathSync(file))) {
    throw new ClusterUsageError(
      `${terraform} is tracked by git. A rendered Terraform document prints secrets in plain text, ` +
        "so it must not be committed. Pass an untracked copy.",
    );
  }
  const outDir = resolve(cwd, out);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new ClusterUsageError(`${out} is not empty. Lowered files are meant to be edited, so they are never overwritten: choose a new --out`);
  }
  const { importFacts } = await import("../lib/facts/import.mjs");
  const { lowerCluster } = await import("../lib/facts/lower.mjs");
  const lowered = lowerCluster(importFacts(JSON.parse(readFileSync(file, "utf8"))), { from, to, name });
  mkdirSync(outDir, { recursive: true });
  for (const [path, content] of Object.entries(lowered.files)) writeFileSync(join(outDir, path), content);
  return { files: Object.keys(lowered.files).sort(), notes: lowered.notes, bundles: lowered.bundles, connections: lowered.connections };
}

export async function emitK8sDir({ root, env, out }) {
  const { parseTomlToCluster, checkableBundle } = await import("../lib/cluster/toml-to-cluster.mjs");
  const { lowerK8s } = await import("../lib/cluster/emit-k8s.mjs");
  const cluster = await parseTomlToCluster(readFileSync(resolve(root, "cluster.toml"), "utf8"));
  const { files, checked, references, unreferenced, unread } = lowerK8s({
    bundles: cluster.bundles.map(checkableBundle),
    connections: cluster.connections ?? [],
    env,
    readManifest: (path) => readFileSync(resolve(root, path), "utf8"),
  });
  if (files.length === 0 && checked.length === 0) {
    throw new ClusterUsageError(`no bundle is placed "kubernetes" or "knative" for env "${env}"`);
  }
  // Only knative bundles: they are checked and nothing is written, so --out is
  // left exactly as it was.
  if (files.length === 0) return { files: [], bundles: [], checked, references, unreferenced, unread };
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
  return {
    files: files.map((f) => f.path),
    bundles: [...new Set(files.map((f) => f.path.split("/")[0]))],
    checked,
    references,
    unreferenced,
    unread,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const spawnImpl = deps.spawn ?? spawn;

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ClusterUsageError) { errLog(`cloister cluster: ${e.message}`); return 2; }
    throw e;
  }
  if (args.help || !args.sub) {
    const helpCommand = args.sub ? `cluster ${args.sub}` : "cluster generate";
    log(renderCommandHelp(helpCommand));
    return args.sub ? 0 : 2;
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
      const written = await lowerPlanDir({
        terraform: args.terraform, from: args.from, to: args.to, name: args.name ?? undefined,
        out: args.out, cwd: process.cwd(), isGitTracked: deps.isGitTracked,
      });
      for (const f of written.files) log(`cloister cluster lower: wrote ${join(args.out, f)}`);
      log(`cloister cluster lower: ${written.bundles} ${written.bundles === 1 ? "bundle" : "bundles"}, ${written.connections} ${written.connections === 1 ? "connection" : "connections"}, for env "${args.to}"`);
      if (written.notes.length) {
        log("cloister cluster lower: the plan did not hold everything. Each file says what it is missing:");
        for (const note of written.notes) log(`  - ${note}`);
      }
      log(`  next: cloister cluster k8s --dir ${args.out} --env ${args.to} --out ${join(args.out, "k8s")}`);
      return 0;
    } catch (error) {
      errLog(`cloister cluster lower: ${error.message}`);
      return error instanceof ClusterUsageError ? 2 : 1;
    }
  }

  if (args.sub === "k8s") {
    try {
      const outDir = args.out ?? (() => { throw new ClusterUsageError("--out <dir> is required"); })();
      const written = await emitK8sDir({ root: selectedRoot, env: args.env ?? "local", out: resolve(process.cwd(), outDir) });
      for (const f of written.files) log(`cloister cluster k8s: wrote ${join(outDir, f)}`);
      for (const b of written.bundles) log(`  kubectl apply -n ${b} -f ${join(outDir, b)}`);
      for (const k of written.checked) {
        const address = `${k.service}${k.namespace ? `.${k.namespace}.svc` : ""}:${k.port}`;
        log(`cloister cluster k8s: checked "${k.bundle}" (knative, strength "none"): reached at ${address} (${k.wire}); nothing written`);
        for (const c of k.connectionsIn) log(`  connection "${c.name}" from "${c.from}": checked, not enforced`);
      }
      // What the containers' own env, args and command say about the graph.
      for (const r of written.references) {
        const from = `"${r.bundle}" container ${JSON.stringify(r.container)} ${r.where}`;
        if (r.to) log(`cloister cluster k8s: ${from} names ${r.address}: ${r.connections.map((c) => `connection "${c}"`).join(", ")}`);
        else log(`cloister cluster k8s: ${from} names ${r.address}, which is no bundle placed here; not checked`);
      }
      for (const u of written.unread) {
        log(`cloister cluster k8s: "${u.bundle}" container ${JSON.stringify(u.container)} ${u.where} comes from ${u.kind} ${JSON.stringify(u.name)}, which is not in this manifest; not read`);
      }
      for (const c of written.unreferenced) {
        log(`cloister cluster k8s: connection "${c.name}" from "${c.from}" to "${c.to}": no env, args or command value names it`);
      }
      return 0;
    } catch (error) {
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

  const composeArgs = args.sub === "up"
    ? ["-f", file, "up", ...(args.detach ? ["-d"] : [])]
    // Volumes survive by default: a `down` that silently destroyed DO SQLite
    // state would be an unrecoverable action behind a routine-looking verb.
    : ["-f", file, "down", ...(args.destroy ? ["-v"] : [])];

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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c));
}
