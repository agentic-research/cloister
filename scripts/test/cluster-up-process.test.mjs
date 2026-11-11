// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cluster up` supervision with REAL processes and REAL signals
// (cloister-991e65 review, fix 12). The EventEmitter fakes in
// cluster-up.test.mjs could not see a handler removed too early, a signal
// that killed `up`, or a run dying unobserved; these can. `up` runs in its own
// process (fixtures/cluster-up/driver.mjs) and spawns
// fixtures/cluster-up/fake-host-runtime.mjs as each host runtime.
//
// Run with:
//   node --import tsx --test scripts/test/cluster-up-process.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";

const HERE = import.meta.dirname;
const DRIVER = join(HERE, "fixtures/cluster-up/driver.mjs");
const DEMO_TOML = readFileSync(join(HERE, "../../tools/dolt-grpc-demo/microvm/cluster.toml"), "utf8");
const TSX = import.meta.resolve("tsx");

function clusterDir() {
  const dir = mkdtempSync(join(tmpdir(), "cloister-up-proc-"));
  writeFileSync(join(dir, "cluster.toml"), DEMO_TOML);
  const row = (img, rfs) => ({ identifier: "x", digest: img, rootfs: rfs, rootfsImage: img });
  writeFileSync(join(dir, "cluster.lock.toml"), stringifyToml({
    schema: "cloister/lockfile/v1", cluster: "t", version: "0.0.1",
    inputs: {
      dolt: { oci: row(`sha256:${"a".repeat(64)}`, `blake3-256:${"b".repeat(64)}`) },
      orders: { oci: row(`sha256:${"c".repeat(64)}`, `blake3-256:${"d".repeat(64)}`) },
    },
  }));
  return dir;
}

/** Start `up` in a child process; collect its output; resolve on exit. */
function startUp(env) {
  const dir = clusterDir();
  const log = join(dir, "fake.log");
  writeFileSync(log, "");
  const child = spawn(process.execPath, ["--import", TSX, DRIVER, dir], {
    env: { ...process.env, FAKE_LOG: log, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { out.stdout += d; });
  child.stderr.on("data", (d) => { out.stderr += d; });
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const waitFor = async (re, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!re.test(out.stdout + out.stderr)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${re}\n${out.stdout}\n${out.stderr}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const events = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const [bundle, pid, what] = l.split(" ");
    return { bundle, pid: Number(pid), what };
  });
  const channelDir = () => (out.stdout.match(/unix:\/\/(\S+)\/\w+\.\w+\.sock/) ?? [])[1];
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { child, out, exited, waitFor, events, channelDir, cleanup };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function allDead(pids, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (pids.some(alive)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

const fakePids = (up) => [...new Set(up.events().map((e) => e.pid))];

test("a second SIGINT during a slow teardown reports progress and keeps waiting — nothing is orphaned", async () => {
  const up = startUp({ FAKE_STOP_MS: "600" });
  try {
    await up.waitFor(/all bundles bound/);
    const dir = up.channelDir();
    up.child.kill("SIGINT");
    await up.waitFor(/SIGINT: stopping/);
    up.child.kill("SIGINT");
    const { code } = await up.exited;
    assert.match(up.out.stderr, /SIGINT again: still stopping .*orders \(pid \d+\)/, up.out.stderr);
    assert.equal(code, 0, up.out.stderr);
    assert.ok(await allDead(fakePids(up)), "every host runtime has exited");
    assert.deepEqual(up.events().filter((e) => e.what === "exit").map((e) => e.bundle), ["orders", "dolt"], "reverse order");
    assert.equal(existsSync(dir), false, "channel dir removed");
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});

test("SIGHUP stops the cluster through the same teardown", async () => {
  const up = startUp({});
  try {
    await up.waitFor(/all bundles bound/);
    up.child.kill("SIGHUP");
    const { code, signal } = await up.exited;
    assert.equal(signal, null, "SIGHUP did not kill up");
    assert.equal(code, 0, up.out.stderr);
    assert.ok(await allDead(fakePids(up)));
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});

test("an earlier bundle dying while a later one starts is noticed: stop everything, exit non-zero", async () => {
  const up = startUp({ FAKE_DOLT: "bind-then-die", FAKE_DIE_MS: "300", FAKE_ORDERS: "never-bind" });
  try {
    const { code } = await up.exited;
    assert.equal(code, 1, up.out.stdout + up.out.stderr);
    assert.match(up.out.stderr, /bundle "dolt" exited on its own with status 1/);
    assert.doesNotMatch(up.out.stdout, /all bundles bound/);
    assert.ok(await allDead(fakePids(up)), "orders was stopped");
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});

test("a run ending on its own still makes the exit non-zero when a signal also arrives", async () => {
  const up = startUp({ FAKE_ORDERS: "bind-then-die", FAKE_DIE_MS: "400", FAKE_STOP_MS: "800" });
  try {
    await up.waitFor(/all bundles bound/);
    await up.waitFor(/bundle "orders" exited on its own/);
    up.child.kill("SIGINT"); // arrives during dolt's slow teardown
    const { code } = await up.exited;
    assert.equal(code, 1, up.out.stderr);
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});

test("kill -9 of up: each host runtime sees stdin EOF and stops", async () => {
  const up = startUp({});
  let dir;
  try {
    await up.waitFor(/all bundles bound/);
    dir = up.channelDir();
    const pids = fakePids(up);
    up.child.kill("SIGKILL");
    await up.exited;
    assert.ok(await allDead(pids), "host runtimes exited after their supervisor died");
    assert.deepEqual(up.events().filter((e) => e.what === "eof").map((e) => e.bundle).sort(), ["dolt", "orders"]);
    // Nothing runs `up`'s teardown after kill -9, so its channel dir stays —
    // stated here rather than hidden; a later `up` never reuses it (each
    // invocation makes a fresh one).
    assert.equal(existsSync(dir), true);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    up.cleanup();
  }
});

test("a third signal SIGKILLs host runtimes that will not stop, and says their VMs may survive (f963e6)", async () => {
  const up = startUp({ FAKE_DOLT: "ignore-term", FAKE_ORDERS: "ignore-term" });
  try {
    await up.waitFor(/all bundles bound/);
    const pids = fakePids(up);
    up.child.kill("SIGINT");
    await up.waitFor(/SIGINT: stopping/);
    up.child.kill("SIGINT");
    await up.waitFor(/again: still stopping/);
    up.child.kill("SIGINT");
    const { code } = await up.exited;
    assert.equal(code, 1);
    assert.match(up.out.stderr, /SIGKILLed host runtimes .*krun workers — the VMs — may STILL BE RUNNING.*ley-line-open-f963e6/s);
    assert.ok(await allDead(pids));
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});

test("a stderr line written in several small pieces is relayed whole, never split", async () => {
  const up = startUp({ FAKE_ORDERS: "split-line-then-die" });
  try {
    const { code } = await up.exited;
    assert.equal(code, 1, up.out.stderr);
    const orders = up.out.stderr.split("\n").filter((l) => l.startsWith("[orders]"));
    assert.deepEqual(orders, [
      "[orders] cloister-host-runtime:   | seed: database did not answer",
      "[orders] cloister-host-runtime: the workload ran and failed",
    ]);
    // describeExit names the last WHOLE line (here flushed at end of stream).
    assert.match(up.out.stderr, /bundle "orders" exited on its own with status 1: cloister-host-runtime: the workload ran and failed\n/);
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});
