#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister cluster up|down` — bring a declared cluster up, and take it down.
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
import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { renderCommandHelp } from "./cli-surface.mjs";

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
 * @returns {{help:boolean, sub:string|null, dir:string, detach:boolean, destroy:boolean, passthrough:string[]}}
 */
export function parseArgs(argv) {
  const out = {
    help: false, sub: null, dir: ".", detach: false, destroy: false, passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--detach" || a === "-d") { out.detach = true; continue; }
    if (a === "--destroy") { out.destroy = true; continue; }
    if (a === "--dir") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new ClusterUsageError("--dir requires a value");
      out.dir = v; i++; continue;
    }
    if (!out.sub && (a === "up" || a === "down")) { out.sub = a; continue; }
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
      `or run \`task cluster:emit\` in a cloister checkout.`,
    );
  }
  return { root, file };
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
    log(renderCommandHelp(args.sub === "down" ? "cluster down" : "cluster up"));
    return args.sub ? 0 : 2;
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
