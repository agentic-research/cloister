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
import { connect, createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";

const HERE = import.meta.dirname;
const DRIVER = join(HERE, "fixtures/cluster-up/driver.mjs");
const DEMO_TOML = readFileSync(join(HERE, "../../tools/dolt-grpc-demo/microvm/cluster.toml"), "utf8");
const TSX = import.meta.resolve("tsx");

// The demo publishes its ports on fixed host ports (expose = "edge"). These
// tests must not bind the host's 3306/50051, so the default cluster keeps
// them socket-only; the edge tests below publish on free ports instead.
const SOCKET_ONLY_TOML = DEMO_TOML.replace(/^expose = "edge".*$/gm, 'expose = "cluster"');

function clusterDir(toml = SOCKET_ONLY_TOML) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-up-proc-"));
  writeFileSync(join(dir, "cluster.toml"), toml);
  const row = (img, rfs) => ({ identifier: "x", digest: img, rootfs: [{ platform: "linux/arm64", digest: rfs, image: img }] });
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
function startUp(env, toml) {
  const dir = clusterDir(toml);
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

// ── expose = "edge": a real relay in a real `up` (cloister-991e65) ─────────

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen({ host: "127.0.0.1", port: 0 }, r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** The demo, publishing dolt.mysql and orders.grpc on the given host ports. */
function edgeToml(mysql, grpc) {
  assert.ok(DEMO_TOML.includes("port = 3306") && DEMO_TOML.includes("port = 50051"));
  return DEMO_TOML.replace("port = 3306", `port = ${mysql}`).replace("port = 50051", `port = ${grpc}`);
}

/** TCP to 127.0.0.1:port: send, half-close, collect until close. Rejects on ECONNREFUSED. */
function exchange(port, text) {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let got = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.end(text));
    s.on("data", (d) => { got += d; });
    s.on("error", reject);
    s.on("close", () => resolve(got));
  });
}

async function portFree(port, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = createServer();
    const ok = await new Promise((r) => {
      s.once("error", () => r(false));
      s.listen({ host: "127.0.0.1", port, exclusive: true }, () => r(true));
    });
    if (ok) { await new Promise((r) => s.close(r)); return true; }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("edge: host TCP reaches the bundle's bind socket, and SIGINT closes the relay and frees the port", async () => {
  const [mysql, grpc] = [await freePort(), await freePort()];
  const up = startUp({ FAKE_DOLT: "echo", FAKE_ORDERS: "echo" }, edgeToml(mysql, grpc));
  try {
    await up.waitFor(/all bundles bound/);
    assert.match(up.out.stdout, new RegExp(`edge: 127\\.0\\.0\\.1:${mysql} → dolt\\.mysql \\(art\\.mysql\\)`));
    assert.equal(await exchange(mysql, "select 1"), "select 1", "TCP → relay → dolt's bind socket → back");
    assert.equal(await exchange(grpc, "grpc bytes"), "grpc bytes");
    up.child.kill("SIGINT");
    const { code } = await up.exited;
    assert.equal(code, 0, up.out.stderr);
    assert.match(up.out.stdout, new RegExp(`closed edge listeners \\(127\\.0\\.0\\.1:${mysql}, 127\\.0\\.0\\.1:${grpc}\\)`));
    await assert.rejects(exchange(mysql, "x"), /ECONNREFUSED/);
    assert.ok(await portFree(mysql) && await portFree(grpc), "both host ports are free");
    assert.ok(await allDead(fakePids(up)), "every host runtime has exited");
  } finally {
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});

test("edge: kill -9 of up leaves no listener (the OS closes its sockets) and no host runtime", async () => {
  const [mysql, grpc] = [await freePort(), await freePort()];
  const up = startUp({ FAKE_DOLT: "echo", FAKE_ORDERS: "echo" }, edgeToml(mysql, grpc));
  try {
    await up.waitFor(/all bundles bound/);
    assert.equal(await exchange(mysql, "ping"), "ping");
    up.child.kill("SIGKILL");
    const { signal } = await up.exited;
    assert.equal(signal, "SIGKILL");
    assert.ok(await portFree(mysql) && await portFree(grpc), "both host ports are free");
    assert.ok(await allDead(fakePids(up)), "each host runtime stopped on stdin EOF");
  } finally {
    up.cleanup();
  }
});

test("edge: a busy host port is refused by name before any bundle starts", async () => {
  const [mysql, grpc] = [await freePort(), await freePort()];
  const holder = createServer();
  await new Promise((r) => holder.listen({ host: "127.0.0.1", port: grpc }, r));
  const up = startUp({}, edgeToml(mysql, grpc));
  try {
    const { code } = await up.exited;
    assert.notEqual(code, 0);
    assert.match(up.out.stderr, new RegExp(`host port 127\\.0\\.0\\.1:${grpc} is already in use, and bundle "orders" port "grpc" \\(expose = "edge"\\) publishes on it\\. Nothing was started\\.`));
    assert.deepEqual(up.events(), [], "no host runtime was spawned");
    assert.ok(await portFree(mysql), "the port reserved before the refusal was released");
  } finally {
    holder.close();
    up.child.kill("SIGKILL");
    up.cleanup();
  }
});
