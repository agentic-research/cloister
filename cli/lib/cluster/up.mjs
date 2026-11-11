// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli/lib/cluster/up.mjs — `cloister cluster up --env <env>`: cluster.toml in,
// running microVMs out (cloister-991e65, ADR-0070 §4 microvm row).
//
// Everything here is DERIVED from what is already declared; nothing is a new
// knob:
//   - which bundles start: every bundle placed `microvm` in the env (explicitly,
//     or implicitly as an external executionMode="microvm" bundle with no
//     placement rows). Not only those with channels: `up` brings up the env as
//     declared, and picking a subset would be a selection rule nobody wrote.
//   - start order: a connection's target starts before its source. A cycle has
//     no order and is refused by name.
//   - readiness: a bundle is ready when every socket its plan BINDS exists.
//     Those paths are its §6 bind grants — the same ones a dependent's connect
//     grant names — so "ready" is exactly "a dependent can now be granted".
//     There is no timeout: a bundle that never binds is still a running child,
//     and one that fails exits, which `up` sees.
//   - plans: emitted in memory by `buildLaunchPlan`, the code path behind
//     `runtime plan`, then handed to the host runtime as a 0600 file.
//
// One fresh owner-only channel directory per invocation (LLO refuses a bind
// path that already exists, and does not unlink sockets after a run —
// 156d83), removed on exit. No daemon, no state file.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { parseTomlToCluster } from "./toml-to-cluster.mjs";
import { checkableBundle, isExposed, placementFor } from "./connections.mjs";
import { buildLaunchPlan, parsePlanArgs } from "../../commands/runtime-plan.mjs";
import { casRootInCas } from "../runtime/cas-root.mjs";
import { hostRuntimeEnv, resolveHostRuntime } from "../runtime/compatibility-client.mjs";
import { MAX_UNIX_SOCKET_PATH } from "./connections.mjs";

/**
 * Which bundles `up` starts for `env`, in start order, and which it skips.
 *
 * @returns {{order: string[], skipped: Array<{name: string, reason: string}>}}
 */
export function startOrder(cluster, env) {
  const bundles = cluster.bundles.map(checkableBundle);
  const started = [];
  const skipped = [];
  for (const b of bundles) {
    const kind = placementFor(b, env);
    if (kind === "microvm") started.push(b.name);
    else if (kind === "kubernetes") {
      skipped.push({ name: b.name, reason: `placed "kubernetes" for env "${env}"; deploy it with \`cloister cluster k8s --env ${env}\`` });
    } else if (kind === null) {
      skipped.push({ name: b.name, reason: `no microvm placement for env "${env}"` });
    } else {
      skipped.push({ name: b.name, reason: `placed "${kind}" for env "${env}", which cluster up does not start` });
    }
  }

  // deps[x] = bundles x connects to in this env (they must start first).
  const inSet = new Set(started);
  const deps = new Map(started.map((n) => [n, []]));
  for (const c of cluster.connections ?? []) {
    const t = c.targets.find((x) => x.env === env);
    if (!t || !inSet.has(c.from) || !inSet.has(t.bundle)) continue;
    if (!deps.get(c.from).includes(t.bundle)) deps.get(c.from).push(t.bundle);
  }

  // Depth-first, visiting in declaration order, so the order is deterministic
  // and a cycle is found with its path.
  const order = [];
  const state = new Map(); // undefined | "visiting" | "done"
  const visit = (name, path) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new Error(
        `connections in env "${env}" form a cycle (${cycle.join(" → ")}): each end would ` +
          `have to be running before the other, so there is no start order`,
      );
    }
    state.set(name, "visiting");
    for (const d of deps.get(name)) visit(d, [...path, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of started) visit(name, []);
  return { order, skipped };
}

/** A fresh owner-only channel directory, short enough for sun_path. */
export function makeChannelDir(makeTemp = mkdtempSync, realpath = realpathSync) {
  // /tmp, not os.tmpdir(): on macOS the latter is ~50 bytes deep under
  // /var/folders, which eats half of the 103-byte sun_path budget. mkdtemp
  // creates the directory 0700.
  //
  // Then the REAL path: on macOS /tmp is a symlink to /private/tmp, and a
  // socket path through it was refused live by libkrun's
  // krun_add_vsock_port2 (status -22, EINVAL) while the same socket under
  // /private/tmp bound. The grant paths are committed in the confinement
  // digest, so they are spelled the way the kernel resolves them.
  return realpath(makeTemp("/tmp/cloister-up-"));
}

/** The bind grants of a plan: what must exist before the bundle is ready. */
export function bindPaths(plan) {
  return (plan.confinement?.unixSocket?.allow ?? []).filter((g) => g.mode === "bind").map((g) => g.path);
}

/**
 * Bring the env up and supervise it until a signal or a run ends on its own.
 *
 * @param {object} o
 * @param {string} o.root cluster directory
 * @param {string} o.env
 * @param {object} [o.deps] injectable: spawn, log, errLog, env, rootfsInCas,
 *   makeTemp, exists, signals (an EventEmitter-like with on/off), pollMs
 * @returns {Promise<number>} exit status
 */
export async function clusterUp({ root, env, deps = {} }) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const procEnv = deps.env ?? process.env;
  const spawn = deps.spawn ?? nodeSpawn;
  const exists = deps.exists ?? existsSync;
  const signals = deps.signals ?? process;
  const pollMs = deps.pollMs ?? 100;

  const absRoot = realpathSync(resolve(root));
  const cluster = await parseTomlToCluster(readFileSync(join(absRoot, "cluster.toml"), "utf8"));
  const lockPath = join(absRoot, "cluster.lock.toml");
  if (!exists(lockPath)) throw new Error(`no cluster.lock.toml in ${absRoot}`);
  const lock = parseToml(readFileSync(lockPath, "utf8"));
  const { order, skipped } = startOrder(cluster, env);
  for (const s of skipped) log(`cloister cluster up: skipping "${s.name}": ${s.reason}`);
  if (order.length === 0) throw new Error(`no bundle is placed "microvm" for env "${env}"`);

  const shownDir = relative(process.cwd(), absRoot) || ".";
  const rootfsInCas = deps.rootfsInCas ?? casRootInCas(procEnv);

  // Every plan is built BEFORE anything starts, so a missing rootfs or an
  // over-long path refuses the whole `up` with nothing to tear down.
  const channelDir = makeChannelDir(deps.makeTemp);
  const runs = [];
  let stopping = false;
  let failure = null;
  try {
    const plans = order.map((name) => {
      const opts = parsePlanArgs([name, "--workspace", absRoot, "--env", env, "--channel-dir", channelDir]);
      return buildLaunchPlan(cluster, lock, { ...opts, dir: shownDir, rootfsInCas });
    });
    for (const plan of plans) {
      for (const p of bindPaths(plan)) {
        if (Buffer.byteLength(p) > MAX_UNIX_SOCKET_PATH) throw new Error(`channel socket path over ${MAX_UNIX_SOCKET_PATH} bytes: ${p}`);
      }
    }

    const host = deps.hostRuntime ?? (() => {
      const binary = resolveHostRuntime({ env: procEnv });
      return { command: binary.command, env: binary.record ? hostRuntimeEnv(binary.record, procEnv) : procEnv };
    })();

    // Stop requests: the first SIGINT/SIGTERM stops everything.
    let resolveStop;
    const stopRequested = new Promise((r) => { resolveStop = r; });
    const onSignal = (sig) => { if (!stopping) { stopping = true; resolveStop(sig); } };
    signals.on("SIGINT", onSignal);
    signals.on("SIGTERM", onSignal);

    // One run's lifecycle. `ended` resolves with {code, signal}.
    const start = (plan) => {
      const planPath = join(channelDir, `${plan.bundle}.plan.json`);
      writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
      // Own process group: a terminal Ctrl-C reaches `up` only, so `up`
      // decides the stop order instead of every run cancelling at once.
      const child = spawn(host.command, ["run", planPath], {
        env: host.env,
        stdio: ["ignore", "inherit", "pipe"],
        detached: true,
      });
      const run = { bundle: plan.bundle, plan, child, stderrTail: [], stoppedByUs: false };
      child.stderr?.on("data", (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (!line) continue;
          errLog(`[${plan.bundle}] ${line}`);
          run.stderrTail.push(line);
          if (run.stderrTail.length > 20) run.stderrTail.shift();
        }
      });
      run.ended = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
      run.spawnError = new Promise((r) => child.on("error", (e) => r(e)));
      runs.push(run);
      return run;
    };

    const describeExit = (run, result) => {
      const status = result.signal ? `signal ${result.signal}` : `status ${result.code}`;
      const why = run.stderrTail.length ? `: ${run.stderrTail[run.stderrTail.length - 1]}` : "";
      return `bundle "${run.bundle}" exited on its own with ${status}${why}`;
    };

    for (const plan of plans) {
      if (stopping) break;
      const run = start(plan);
      log(`cloister cluster up: started "${plan.bundle}" (pid ${run.child.pid})`);
      const binds = bindPaths(plan);
      // Ready when every bind socket exists — or the run ends first.
      const outcome = await new Promise((r) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearInterval(timer); r(v); } };
        const check = () => { if (binds.every((p) => exists(p))) finish({ ready: true }); };
        const timer = setInterval(check, pollMs);
        run.ended.then((res) => finish({ ready: false, res }));
        run.spawnError.then((e) => finish({ ready: false, error: e }));
        stopRequested.then(() => finish({ ready: false, stop: true }));
        check();
      });
      if (outcome.stop) break;
      if (outcome.error) {
        failure = `bundle "${plan.bundle}" could not be started: ${outcome.error.message}`;
        break;
      }
      if (!outcome.ready) {
        failure = `${describeExit(run, outcome.res)} — before it was ready`;
        break;
      }
      log(`cloister cluster up: "${plan.bundle}" ready`);
    }

    if (!failure && !stopping) {
      for (const run of runs) {
        const ports = cluster.bundles.find((b) => b.name === run.bundle)?.ports ?? [];
        for (const p of ports.filter(isExposed)) {
          log(`  ${run.bundle}.${p.name} (${p.appProtocol}): unix://${join(channelDir, `${run.bundle}.${p.name}.sock`)}`);
        }
      }
      log("cloister cluster up: all bundles ready; Ctrl-C to stop");
      // Run until a signal, or until any run ends on its own.
      const first = await Promise.race([
        stopRequested.then(() => null),
        ...runs.map((run) => run.ended.then((res) => ({ run, res }))),
      ]);
      if (first) failure = describeExit(first.run, first.res);
    }

    signals.off?.("SIGINT", onSignal);
    signals.off?.("SIGTERM", onSignal);
  } finally {
    // Stop in reverse start order: dependents before what they depend on.
    for (const run of [...runs].reverse()) {
      if (run.child.exitCode !== null || run.child.signalCode !== null) continue;
      run.stoppedByUs = true;
      try {
        run.child.kill("SIGTERM");
      } catch (error) {
        errLog(`cloister cluster up: could not signal "${run.bundle}" (pid ${run.child.pid}): ${error.message}`);
      }
      const res = await run.ended;
      log(`cloister cluster up: stopped "${run.bundle}" (${res.signal ? `signal ${res.signal}` : `status ${res.code}`})`);
    }
    rmSync(channelDir, { recursive: true, force: true });
  }

  if (failure) {
    errLog(`cloister cluster up: ${failure}; stopped the rest`);
    return 1;
  }
  return 0;
}
