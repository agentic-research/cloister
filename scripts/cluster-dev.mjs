#!/usr/bin/env node
/**
 * cluster-dev — mac-native launcher for `cluster.capnp`. Runs the same
 * bundle topology as `task cluster:up` but without containers. Per
 * cloister-be0607c.
 *
 * Pipeline:
 *
 *   src/generated/cluster.ts   (validated)
 *           │
 *           │  this script
 *           ▼
 *   N child processes (workerd via wrangler-dev / mache / rsry / etc.)
 *   UDS sockets in /tmp/cloister-dev/run/
 *   DO storage in  $HOME/.cache/cloister-dev/do/
 *
 * Design choices:
 *
 * - **No containers** — uses native binaries on PATH (or override via
 *   $CLUSTER_DEV_BIN_<bundle>). The whole point of mac-dev mode is
 *   skipping the OCI build loop for iteration.
 * - **UDS in /tmp** — macOS doesn't have writable /run; we use a fresh
 *   /tmp/cloister-dev/run/ each invocation. The dir is removed on exit
 *   so stale sockets don't accumulate.
 * - **DO storage in $HOME/.cache** — persists across invocations (so
 *   beads / attestations / lease counters survive a Ctrl-C). Wipe
 *   manually if you want a clean slate.
 * - **cloister-router is launched via `wrangler dev`** — it's a worker,
 *   so we boot it through the same path `task dev` uses. The mache /
 *   rosary / notme bundles are spawned as their native binaries with
 *   the cluster.capnp-declared args.
 * - **Missing binaries are surfaced, not fatal** — if `mache` isn't on
 *   PATH, that bundle is skipped with a clear "install: ..." hint.
 *   The router still boots; you just lose the mache_* tools. This
 *   matches the user expectation that "I haven't built rosary yet"
 *   shouldn't block cloister dev.
 *
 * Usage:
 *
 *   node scripts/cluster-dev.mjs        # default
 *   task cluster:dev                    # via Taskfile
 *
 * Env overrides:
 *
 *   CLUSTER_DEV_BIN_<NAME>=/path        # override binary lookup for bundle NAME
 *                                       # (NAME is upper-cased, hyphens → underscores)
 *   CLUSTER_DEV_INSPECTOR_PORT_<NAME>=N # override wrangler dev inspector port
 *   CLUSTER_DEV_INSPECTOR_PORT_BASE=N   # first auto-assigned inspector port (default 9229)
 *   CLUSTER_DEV_INTERLACE_ROOT_PUBKEY=B64
 *                                       # pass --var INTERLACE_ROOT_PUBKEY:B64
 *                                       # to the router's wrangler dev process
 *   CLUSTER_DEV_INTERLACE_MASTER_PUBKEY=B64
 *                                       # pass --var INTERLACE_MASTER_PUBKEY:B64
 *   CLUSTER_DEV_RUN_DIR=/path           # default /tmp/cloister-dev/run
 *   CLUSTER_DEV_DO_DIR=/path            # default $HOME/.cache/cloister-dev/do
 *   CLUSTER_DEV_DRY_RUN=1               # print the plan, don't spawn anything
 *
 * Signal handling:
 *
 *   Ctrl-C (SIGINT) or SIGTERM is broadcast to every child. We wait
 *   ≤5s for graceful exit then SIGKILL stragglers. Exit code is the
 *   highest child exit code (so CI surfaces failures).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO  = process.cwd();
const ENV   = process.env;
const DRY   = ENV.CLUSTER_DEV_DRY_RUN === "1";

const RUN_DIR = ENV.CLUSTER_DEV_RUN_DIR ?? "/tmp/cloister-dev/run";
const DO_DIR  = ENV.CLUSTER_DEV_DO_DIR  ?? join(homedir(), ".cache/cloister-dev/do");
const INSPECTOR_PORT_BASE = parsePositiveInt(ENV.CLUSTER_DEV_INSPECTOR_PORT_BASE, 9229);

// ── Load + validate the cluster manifest ──────────────────────────────────

const INPUT_PATH = resolve(REPO, "src/generated/cluster.ts");
if (!existsSync(INPUT_PATH)) {
  console.error(`cluster-dev: ${rel(INPUT_PATH)} doesn't exist`);
  console.error("  run \`task cluster:manifest\` first");
  process.exit(1);
}

const mod = await import(pathToFileURL(INPUT_PATH).href);
const cluster = mod.cluster;
const { validateCluster } = await import(pathToFileURL(resolve(REPO, "src/manifest/cluster-types.ts")).href);
validateCluster(cluster);

// ── Resolve per-bundle launch plans ───────────────────────────────────────
//
// Each external bundle is one of:
//   - cloister-router: workerd via `wrangler dev` (HTTP on httpPort,
//                       DO storage in DO_DIR)
//   - notme-identity:  workerd via wrangler too — same shape
//   - mache:           native `mache` binary, args from cluster.capnp,
//                       UDS socket path injected into the args
//   - rosary:          native `rsry` binary (binary name differs from
//                       bundle name; the convention is bundle-name →
//                       known-binary mapping below)
//
// The bundle-name → binary mapping is intentionally explicit (not
// "look up bundle name on PATH") because some bundles' names don't
// match their binary (rosary → rsry). When in doubt, set
// CLUSTER_DEV_BIN_<BUNDLE>.

/** bundle-name → default binary lookup. Overridable via env. */
const BUNDLE_TO_BIN = {
  "cloister-router": "wrangler",        // runs workerd via wrangler dev
  "notme-identity":  "wrangler",        // same; uses its own wrangler.toml in ../notme
  "mache":           "mache",
  "rosary":          "rsry",            // binary name differs from bundle name
};

/** A planned subprocess to spawn. */
class Launch {
  constructor({ name, bin, args, env, cwd, ignoredReason }) {
    this.name = name;
    this.bin  = bin;
    this.args = args ?? [];
    this.env  = env ?? {};
    this.cwd  = cwd ?? REPO;
    this.ignoredReason = ignoredReason ?? null;
  }
}

const launches = [];
let nextInspectorOffset = 0;
for (const b of cluster.bundles) {
  if (!("external" in b.kind)) continue;
  const ext = b.kind.external;

  const overrideKey = `CLUSTER_DEV_BIN_${b.name.toUpperCase().replace(/-/g, "_")}`;
  const defaultBin  = BUNDLE_TO_BIN[b.name] ?? b.name;
  const bin         = ENV[overrideKey] ?? whichSync(defaultBin);

  if (!bin) {
    launches.push(new Launch({
      name: b.name,
      bin: defaultBin,
      ignoredReason: `binary "${defaultBin}" not found on PATH (set ${overrideKey} to override, or install it)`,
    }));
    continue;
  }

  // Build the UDS path: cluster.capnp declares /run/cloister-uds/X.sock
  // but on mac we relocate to /tmp/cloister-dev/run/X.sock. Rewrite both
  // the bundle's own ipcSocket AND any wire bindings pointing at it.
  const localSocket = ext.ipcSocket ? relocateSocket(ext.ipcSocket) : "";

  // Translate bundle-declared args by substituting the relocated UDS path.
  const args = ext.args.map(a => a === ext.ipcSocket ? localSocket : a);

  // Build env: wire bindings (with relocated sockets), then bundle env.
  const env = {};
  for (const w of cluster.wires) {
    if (w.from !== b.name) continue;
    const target = cluster.bundles.find(x => x.name === w.to);
    if (!target || !("external" in target.kind)) continue;
    const t = target.kind.external;
    if (t.ipcSocket) {
      env[w.binding] = relocateSocket(t.ipcSocket);
    } else if (t.httpPort > 0) {
      // No UDS — use HTTP. Mac dev mode binds to 127.0.0.1.
      env[w.binding] = `http://127.0.0.1:${t.httpPort}`;
    }
  }
  for (const e of ext.env) env[e.name] = e.value;

  // cloister-router special case: wrangler dev needs to know about
  // local DO storage. wrangler.toml handles that in this repo via
  // `[[durable_objects.bindings]]` + the `local_persistence` flag.
  // We just set CLOISTER_DO_STORAGE_DIR so the worker code can read it
  // if it needs to (and so the operator can see what we picked).
  if (b.name === "cloister-router") {
    env.CLOISTER_DO_STORAGE_DIR = DO_DIR;
  }

  let resolvedArgs = args;
  let cwd = REPO;
  if (b.name === "cloister-router") {
    // wrangler dev binds to httpPort (default 8787 from cluster.capnp).
    resolvedArgs = [
      "dev",
      "--local",
      "--port",
      String(ext.httpPort || 8787),
      "--inspector-port",
      String(inspectorPortFor(b.name)),
      ...interlaceWranglerVarArgs(),
    ];
  } else if (b.name === "notme-identity") {
    // notme's worker is at ../notme/worker/ (sibling repo). Allow
    // CLUSTER_DEV_DIR_NOTME_IDENTITY to override the path for users
    // with a different layout.
    const notmeDir = ENV.CLUSTER_DEV_DIR_NOTME_IDENTITY ?? resolve(REPO, "../notme/worker");
    if (!existsSync(join(notmeDir, "wrangler.toml"))) {
      launches.push(new Launch({
        name: b.name,
        bin: "wrangler",
        ignoredReason: `${notmeDir}/wrangler.toml not found — set CLUSTER_DEV_DIR_NOTME_IDENTITY to its location`,
      }));
      continue;
    }
    cwd = notmeDir;
    resolvedArgs = [
      "dev",
      "--local",
      "--port",
      String(ext.httpPort || 8788),
      "--inspector-port",
      String(inspectorPortFor(b.name)),
    ];
  }

  launches.push(new Launch({
    name: b.name,
    bin,
    args: resolvedArgs,
    env,
    cwd,
  }));
}

// ── Print the plan ────────────────────────────────────────────────────────

console.log(`cluster-dev: ${cluster.metadata.name} v${cluster.metadata.version}`);
console.log(`  RUN_DIR = ${RUN_DIR}`);
console.log(`  DO_DIR  = ${DO_DIR}`);
console.log("");
for (const l of launches) {
  if (l.ignoredReason) {
    console.log(`  ✗ ${l.name.padEnd(18)} skipped: ${l.ignoredReason}`);
  } else {
    const envStr = Object.entries(l.env).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`  ✓ ${l.name.padEnd(18)} ${l.bin} ${l.args.join(" ")}`);
    if (envStr) console.log(`    env: ${envStr}`);
    if (l.cwd !== REPO) console.log(`    cwd: ${l.cwd}`);
  }
}
console.log("");

const runnable = launches.filter(l => !l.ignoredReason);
if (runnable.length === 0) {
  console.error("cluster-dev: nothing to run — install missing binaries above");
  process.exit(2);
}

if (DRY) {
  console.log("cluster-dev: CLUSTER_DEV_DRY_RUN=1, exiting before spawn");
  process.exit(0);
}

// ── Set up paths ──────────────────────────────────────────────────────────

// Fresh UDS dir each run — stale sockets get cleaned up at exit.
if (existsSync(RUN_DIR)) rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(DO_DIR,  { recursive: true });

// ── Spawn children ────────────────────────────────────────────────────────

const children = [];
let exitCode = 0;
let shuttingDown = false;

for (const l of runnable) {
  const child = spawn(l.bin, l.args, {
    cwd: l.cwd,
    env: { ...ENV, ...l.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push({ launch: l, child });

  const prefix = `[${l.name}]`.padEnd(20);
  child.stdout.on("data", chunk => process.stdout.write(prefixed(prefix, chunk)));
  child.stderr.on("data", chunk => process.stderr.write(prefixed(prefix, chunk)));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const why = code != null ? `exit ${code}` : `signal ${signal}`;
    console.error(`${prefix} terminated (${why})`);
    if (code != null && code > exitCode) exitCode = code;
    // If one of the hypervisor-tier bundles dies, the whole cluster is
    // dead. Tear down.
    if (l.name === "cloister-router" || l.name === "notme-identity") {
      console.error(`cluster-dev: hypervisor-tier bundle "${l.name}" died — tearing down`);
      shutdown();
    }
  });
}

console.log(`cluster-dev: ${runnable.length} bundle(s) running. Ctrl-C to stop.`);

// ── Signal handling ───────────────────────────────────────────────────────

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("\ncluster-dev: shutting down");
  for (const { child } of children) {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
  }
  // SIGKILL stragglers after 5s.
  setTimeout(() => {
    for (const { launch, child } of children) {
      if (child.exitCode == null && child.signalCode == null) {
        console.error(`cluster-dev: ${launch.name} didn't exit in 5s — SIGKILL`);
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }
    cleanup();
    process.exit(exitCode);
  }, 5000).unref();
}

// Cleanup runs on graceful exit too. cluster-do is intentionally
// preserved (persistence is the point); RUN_DIR is wiped.
function cleanup() {
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

function interlaceWranglerVarArgs() {
  const pairs = [
    ["INTERLACE_ROOT_PUBKEY", ENV.CLUSTER_DEV_INTERLACE_ROOT_PUBKEY],
    ["INTERLACE_MASTER_PUBKEY", ENV.CLUSTER_DEV_INTERLACE_MASTER_PUBKEY],
  ];
  return pairs.flatMap(([name, value]) =>
    value === undefined ? [] : ["--var", `${name}:${value}`],
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function rel(p) {
  return p.startsWith(REPO + "/") ? p.slice(REPO.length + 1) : p;
}

function relocateSocket(declared) {
  // declared: "/run/cloister-uds/router.sock" → "/tmp/cloister-dev/run/router.sock"
  const base = declared.split("/").pop();
  return join(RUN_DIR, base);
}

function inspectorPortFor(bundleName) {
  const overrideKey = `CLUSTER_DEV_INSPECTOR_PORT_${bundleName.toUpperCase().replace(/-/g, "_")}`;
  if (ENV[overrideKey]) return parsePositiveInt(ENV[overrideKey], INSPECTOR_PORT_BASE);
  return INSPECTOR_PORT_BASE + nextInspectorOffset++;
}

function parsePositiveInt(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    console.error(`cluster-dev: invalid port value "${value}"`);
    process.exit(1);
  }
  return n;
}

function whichSync(bin) {
  // Walk $PATH ourselves rather than spawning `which` (avoids a process
  // per lookup and works the same on every platform we care about).
  const paths = (ENV.PATH || "").split(":");
  for (const p of paths) {
    const candidate = join(p, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function prefixed(prefix, chunk) {
  const text = chunk.toString();
  // Prefix each non-empty line; keep trailing newline behavior intact
  // so blank lines aren't doubled.
  return text.split("\n").map((line, i, arr) =>
    line === "" && i === arr.length - 1 ? "" : `${prefix} ${line}`
  ).join("\n");
}
