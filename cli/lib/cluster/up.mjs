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
//   - "bound", not "ready": a bundle counts as BOUND when every socket its plan
//     BINDS exists. Those paths are its §6 bind grants — the same ones a
//     dependent's connect grant names — so "bound" is exactly "a dependent can
//     now be granted". Its health is NOT checked, so `up` never calls it
//     ready (ADR-0071 §3; health-gated start is a later slice).
//     There is no timeout: a bundle that never binds is still a running child,
//     and one that fails exits, which `up` sees.
//   - plans: emitted in memory by `buildLaunchPlan`, the code path behind
//     `runtime plan`, then handed to the host runtime as a 0600 file.
//   - host TCP: a port declared `expose = "edge"` is published on
//     127.0.0.1:<port> and relayed to the bundle's bind socket
//     (edge-relay.mjs). Every edge port is reserved before anything starts (a
//     busy one is refused by name), relays once its bundle is bound, and is
//     closed before the runs are stopped. `cluster` stays socket-only.
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
import { lazyRootfsInCas } from "../runtime/cas-root.mjs";
import { lazyGuestPlatform } from "../runtime/guest-platform.mjs";
import { hostRuntimeEnv, resolveHostRuntime } from "../runtime/compatibility-client.mjs";
import { MAX_UNIX_SOCKET_PATH } from "./connections.mjs";
import { describeEdge, edgePorts, openEdgeListeners } from "./edge-relay.mjs";

/**
 * `cloister-host-runtime run` exits 124 (timeout(1)'s status) when LLO stops a
 * run at its wall-clock ceiling — distinct from a workload failure (1).
 * Mirrors EXIT_WALL_CLOCK in rs/crates/host-runtime/src/lib.rs.
 */
export const EXIT_WALL_CLOCK = 124;

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

/** The bind grants of a plan: what must exist before the bundle is bound. */
export function bindPaths(plan) {
  return (plan.confinement?.unixSocket?.allow ?? []).filter((g) => g.mode === "bind").map((g) => g.path);
}

/** Signals that stop the cluster (never kill `up` and orphan its runs). */
export const STOP_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);

/**
 * Bring the env up and supervise it until a stop request or a run ends on its
 * own, then stop everything in reverse start order.
 *
 * Lifecycle guarantees (cloister-991e65 review; ownership of a running
 * workload — who stops it, and what is promised when they cannot — is
 * ADR-0071):
 *   - stop requests: SIGINT, SIGTERM, SIGHUP, SIGQUIT, an uncaught exception
 *     or rejection inside `up`, and EPIPE on stdout all run the SAME teardown.
 *     The handlers stay installed until teardown has finished.
 *   - a second signal during teardown does not kill `up`; it prints which
 *     bundles are still stopping. A THIRD signal SIGKILLs the remaining host
 *     runtimes (ADR-0071's escalation rule: a repeated signal, never a
 *     timeout) and says, loudly, that their VM workers may survive them until
 *     ley-line-open-f963e6.
 *   - if `up` itself dies (SIGKILL, crash), each host runtime sees EOF on the
 *     stdin pipe `up` holds open and stops its run (`run --stop-on-stdin-eof`).
 *   - any started run that ends on its own — during a later bundle's start,
 *     or after everything is bound — stops the cluster, and the exit status is
 *     non-zero even if a signal also arrived: 124 when that end was the
 *     wall-clock ceiling, 1 otherwise.
 *
 * @param {object} o
 * @param {string} o.root cluster directory
 * @param {string} o.env
 * @param {object} [o.deps] injectable: spawn, log, errLog, env, rootfsInCas, guestPlatform,
 *   makeTemp, exists, signals (EventEmitter-like: on/off, receives signal and
 *   uncaughtException/unhandledRejection events), stdout, pollMs,
 *   hostRuntime ({command, env, args?}), openEdge (edge-relay's
 *   openEdgeListeners)
 * @returns {Promise<number>} exit status
 */
export async function clusterUp({ root, env, deps = {} }) {
  const procEnv = deps.env ?? process.env;
  const spawn = deps.spawn ?? nodeSpawn;
  const exists = deps.exists ?? existsSync;
  const signals = deps.signals ?? process;
  const stdout = deps.stdout ?? process.stdout;
  const pollMs = deps.pollMs ?? 100;
  let stdoutBroken = false;
  const log = (m) => { if (!stdoutBroken) (deps.log ?? console.log)(m); };
  const errLog = deps.errLog ?? console.error;

  // Everything that can be refused is refused before any side effect.
  const absRoot = realpathSync(resolve(root));
  const cluster = await parseTomlToCluster(readFileSync(join(absRoot, "cluster.toml"), "utf8"));
  const lockPath = join(absRoot, "cluster.lock.toml");
  if (!exists(lockPath)) throw new Error(`no cluster.lock.toml in ${absRoot}`);
  const lock = parseToml(readFileSync(lockPath, "utf8"));
  const { order, skipped } = startOrder(cluster, env);
  for (const sk of skipped) log(`cloister cluster up: skipping "${sk.name}": ${sk.reason}`);
  if (order.length === 0) throw new Error(`no bundle is placed "microvm" for env "${env}"`);
  const shownDir = relative(process.cwd(), absRoot) || ".";
  // Attaches the CAS volume (or refuses by name) when the first plan checks
  // its rootfs — before anything is spawned (cloister-727354).
  const rootfsInCas = deps.rootfsInCas ?? lazyRootfsInCas({ env: procEnv, warn: errLog });
  // The platform whose rootfs row is run: the host runtime's, asked once
  // (cloister-1c4ef5).
  const guestPlatform = deps.guestPlatform ?? lazyGuestPlatform({ env: procEnv });

  // ── stop control ─────────────────────────────────────────────────────────
  const runs = [];
  const ownExits = [];
  let stopRequested = false;
  let signalCount = 0;
  let internalError = null;
  let forced = false;
  let resolveStop;
  const stopPromise = new Promise((r) => { resolveStop = r; });
  const requestStop = (why) => {
    if (stopRequested) return;
    stopRequested = true;
    resolveStop(why);
  };
  const pending = () => runs.filter((run) => !run.done && run.child.pid !== undefined);
  const describePending = () => pending().map((run) => `${run.bundle} (pid ${run.child.pid})`).join(", ") || "none";
  const forceKill = () => {
    forced = true;
    const left = pending();
    for (const run of left) {
      try { run.child.kill("SIGKILL"); } catch (error) {
        errLog(`cloister cluster up: SIGKILL of "${run.bundle}" (pid ${run.child.pid}) failed: ${error.message}`);
      }
    }
    errLog(
      `cloister cluster up: SIGKILLed host runtimes ${left.map((run) => `${run.bundle} (pid ${run.child.pid})`).join(", ") || "none"}. ` +
        `Their krun workers — the VMs — may STILL BE RUNNING: a worker does not notice its ` +
        `host runtime dying until ley-line-open-f963e6. Check \`ps\` for leyline-krun-worker.`,
    );
  };
  const onSignal = (sig) => {
    signalCount += 1;
    if (signalCount === 1) {
      log(`cloister cluster up: ${sig}: stopping every run in reverse start order`);
      requestStop({ signal: sig });
    } else if (signalCount === 2) {
      errLog(
        `cloister cluster up: ${sig} again: still stopping ${describePending()}. ` +
          `Waiting for them; one more signal SIGKILLs the host runtimes (their VMs may then survive — ley-line-open-f963e6).`,
      );
    } else if (!forced) {
      forceKill();
    }
  };
  const onInternal = (error) => {
    internalError = internalError ?? error;
    errLog(`cloister cluster up: internal error, stopping everything: ${error?.stack ?? error}`);
    requestStop({ error });
  };
  const onStdoutError = (error) => {
    if (error?.code === "EPIPE") {
      stdoutBroken = true;
      errLog("cloister cluster up: stdout closed (EPIPE); stopping everything");
      requestStop({ epipe: true });
    } else {
      onInternal(error);
    }
  };
  // Installed BEFORE anything exists to clean up, removed only after teardown.
  for (const sig of STOP_SIGNALS) signals.on(sig, onSignal);
  signals.on("uncaughtException", onInternal);
  signals.on("unhandledRejection", onInternal);
  stdout?.on?.("error", onStdoutError);

  let channelDir = null;
  let edgeListeners = [];
  try {
    channelDir = makeChannelDir(deps.makeTemp);
    // Host TCP for expose = "edge": reserved first, before any plan is built or
    // the host runtime is called, so a busy port is refused by name with
    // nothing to tear down.
    edgeListeners = await (deps.openEdge ?? openEdgeListeners)(edgePorts(cluster, order, channelDir), { errLog });
    const plans = order.map((name) => {
      const opts = parsePlanArgs([name, "--workspace", absRoot, "--env", env, "--channel-dir", channelDir]);
      return buildLaunchPlan(cluster, lock, { ...opts, dir: shownDir, rootfsInCas, guestPlatform });
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

    const describeExit = (run, res) => {
      if (res.error) return `bundle "${run.bundle}" could not be started: ${res.error.message}`;
      if (res.code === EXIT_WALL_CLOCK) {
        return `bundle "${run.bundle}" reached its wall-clock ceiling and was stopped by the ` +
          `runtime — not a workload failure (services cannot ask for "no ceiling" yet: ` +
          `ley-line-open-e6b1bb)`;
      }
      const status = res.signal ? `signal ${res.signal}` : `status ${res.code}`;
      const why = run.stderrTail.length ? `: ${run.stderrTail[run.stderrTail.length - 1]}` : "";
      return `bundle "${run.bundle}" exited on its own with ${status}${why}`;
    };

    const start = (plan) => {
      const planPath = join(channelDir, `${plan.bundle}.plan.json`);
      writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
      // detached: own process group, so a terminal Ctrl-C reaches `up` only
      // and `up` decides the stop order. stdin: a pipe `up` holds open and
      // never writes — it closes only when `up` is gone, which the host
      // runtime takes as a stop (--stop-on-stdin-eof).
      const child = spawn(host.command, [...(host.args ?? []), "run", "--stop-on-stdin-eof", planPath], {
        env: host.env,
        stdio: ["pipe", "inherit", "pipe"],
        detached: true,
      });
      // Writing is never done; an EPIPE here only means the child is gone,
      // which its exit event reports.
      child.stdin?.on?.("error", () => {}); // lint-allow-silent: the child's exit is the signal; see above
      const run = { bundle: plan.bundle, plan, child, stderrTail: [], stopRequested: false, done: null };
      // Relay WHOLE lines only. A pipe delivers bytes in arbitrary chunks, so
      // a line split across two reads used to be relayed as two lines — which
      // could separate the host runtime's `| ` guest-output prefix from the
      // guest's text. The unfinished tail is carried to the next chunk, and
      // flushed as one line when the stream ends. UTF-8 decoding is
      // stream-aware (setEncoding), so a split multi-byte character is safe.
      let partial = "";
      const relay = (line) => {
        if (!line) return;
        errLog(`[${plan.bundle}] ${line}`);
        run.stderrTail.push(line);
        if (run.stderrTail.length > 20) run.stderrTail.shift();
      };
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (chunk) => {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop();
        for (const line of lines) relay(line);
      });
      child.stderr?.on("end", () => { relay(partial); partial = ""; });
      run.ended = new Promise((r) => {
        // `close`, not `exit`: it fires after the child's stdio has ended, so
        // the last stderr line is relayed before describeExit reads the tail.
        child.on("close", (code, signal) => r({ code, signal }));
        child.on("error", (error) => r({ error }));
      }).then((res) => {
        run.done = res;
        if (!run.stopRequested) {
          ownExits.push({ run, res });
          errLog(`cloister cluster up: ${describeExit(run, res)}`);
          requestStop({ ownExit: run.bundle });
        }
        return res;
      });
      runs.push(run);
      return run;
    };

    for (const plan of plans) {
      if (stopRequested) break;
      const run = start(plan);
      log(`cloister cluster up: started "${plan.bundle}"${run.child.pid !== undefined ? ` (pid ${run.child.pid})` : ""}`);
      const binds = bindPaths(plan);
      // Bound when every bind socket exists. ANY run ending on its own — this
      // one or an earlier one — requests a stop, which ends this wait too.
      await new Promise((r) => {
        let finished = false;
        const finish = () => { if (!finished) { finished = true; clearInterval(timer); r(); } };
        const check = () => { if (binds.every((p) => exists(p))) finish(); };
        const timer = setInterval(check, pollMs);
        stopPromise.then(finish);
        check();
      });
      if (stopRequested) break;
      log(`cloister cluster up: "${plan.bundle}" bound (its sockets exist; health not checked — ADR-0071 §3)`);
      for (const l of edgeListeners.filter((x) => x.edge.bundle === plan.bundle)) {
        l.activate();
        log(`cloister cluster up: ${describeEdge(l.edge)} (reachable by any local user or process on this host)`);
      }
    }

    if (!stopRequested) {
      for (const run of runs) {
        const ports = cluster.bundles.find((b) => b.name === run.bundle)?.ports ?? [];
        for (const p of ports.filter(isExposed)) {
          log(`  ${run.bundle}.${p.name} (${p.appProtocol}): unix://${join(channelDir, `${run.bundle}.${p.name}.sock`)}`);
        }
      }
      for (const l of edgeListeners) log(`  ${describeEdge(l.edge)}`);
      log("cloister cluster up: all bundles bound (health not checked — ADR-0071 §3); Ctrl-C to stop");
      log(
        "cloister cluster up: note: every run is stopped at its wall-clock ceiling (each " +
          "bundle's is printed above); a service cannot ask for \"no ceiling\" yet " +
          "(ley-line-open-e6b1bb)",
      );
      await stopPromise;
    }
  } finally {
    // Edge listeners first: no new host connection may reach a bundle that is
    // about to stop, and none outlives `up`.
    if (edgeListeners.length > 0) {
      await Promise.all(edgeListeners.map((l) => l.close()));
      log(`cloister cluster up: closed edge listeners (${edgeListeners.map((l) => `127.0.0.1:${l.edge.port}`).join(", ")})`);
    }
    // Stop in reverse start order: dependents before what they depend on.
    // The stop handlers are still installed: a second signal reports
    // progress, a third escalates — neither kills `up` mid-teardown.
    for (const run of [...runs].reverse()) {
      if (run.done) continue;
      run.stopRequested = true;
      if (!forced) {
        try {
          run.child.kill("SIGTERM");
        } catch (error) {
          errLog(`cloister cluster up: could not signal "${run.bundle}" (pid ${run.child.pid}): ${error.message}`);
        }
      }
      const res = await run.ended;
      if (!res.error) {
        log(`cloister cluster up: stopped "${run.bundle}" (${res.signal ? `signal ${res.signal}` : `status ${res.code}`})`);
      }
    }
    if (channelDir) rmSync(channelDir, { recursive: true, force: true });
    for (const sig of STOP_SIGNALS) signals.off?.(sig, onSignal);
    signals.off?.("uncaughtException", onInternal);
    signals.off?.("unhandledRejection", onInternal);
    stdout?.off?.("error", onStdoutError);
  }

  if (forced) return 1;
  if (internalError) return 1;
  if (ownExits.length > 0) {
    const allCeiling = ownExits.every(({ res }) => res.code === EXIT_WALL_CLOCK);
    const names = ownExits.map(({ run }) => `"${run.bundle}"`).join(", ");
    errLog(`cloister cluster up: ${names} ended on ${ownExits.length === 1 ? "its" : "their"} own; stopped the rest`);
    return allCeiling ? EXIT_WALL_CLOCK : 1;
  }
  return 0;
}
