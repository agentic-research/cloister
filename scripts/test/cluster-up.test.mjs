// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cluster.toml → running microVMs (cloister-991e65): the rootfs recorded in the
// lock, `runtime import --bundle`, the runnable plan, and `cluster up`'s start
// order, refusals and supervision. The live run is in the PR / README; these
// pin every refusal by name and the supervisor's behaviour with a fake spawn.
//
// Run with:
//   node --import tsx --test scripts/test/cluster-up.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";
import { startOrder, clusterUp, makeChannelDir, bindPaths } from "../../cli/lib/cluster/up.mjs";
import {
  carryRootfs,
  importCommand,
  isBlake3Digest,
  recordRootfs,
} from "../../cli/lib/runtime/rootfs-lock.mjs";
import { main as importMain, parseImportArgs } from "../../cli/commands/runtime-import.mjs";
import { planFromToml } from "../../cli/commands/runtime-plan.mjs";
import { carryRootfsFromPreviousLock } from "../../cli/lib/cluster/resolve-inputs.mjs";

const DEMO = new URL("../../tools/dolt-grpc-demo/microvm/cluster.toml", import.meta.url);
const DEMO_TOML = readFileSync(DEMO, "utf8");
const IMG = (c) => `sha256:${c.repeat(64)}`;
const RFS = (c) => `blake3-256:${c.repeat(64)}`;

function lockText(rows) {
  return stringifyToml({
    schema: "cloister/lockfile/v1",
    cluster: "t",
    version: "0.0.1",
    inputs: Object.fromEntries(Object.entries(rows).map(([b, oci]) => [b, { oci: { identifier: `x/${b}`, ...oci } }])),
  });
}

// ── start order (Part B) ─────────────────────────────────────────────────

test("start order: a connection's target starts before its source", async () => {
  const { order, skipped } = startOrder(await parseTomlToCluster(DEMO_TOML), "local");
  assert.deepEqual(order, ["dolt", "orders"]);
  assert.deepEqual(skipped, []);
});

test("start order is deterministic and independent of declaration order", async () => {
  // Declare orders first: dolt must still start first.
  const i = DEMO_TOML.indexOf("[[bundles]]\nname = \"orders\"");
  const j = DEMO_TOML.indexOf("[[connections]]");
  const doltStart = DEMO_TOML.indexOf("[[bundles]]\nname = \"dolt\"");
  const swapped = DEMO_TOML.slice(0, doltStart) + DEMO_TOML.slice(i, j) + DEMO_TOML.slice(doltStart, i) + DEMO_TOML.slice(j);
  const cluster = await parseTomlToCluster(swapped);
  assert.equal(cluster.bundles[0].name, "orders");
  assert.deepEqual(startOrder(cluster, "local").order, ["dolt", "orders"]);
});

test("a cycle of connections is refused by name, with its path", async () => {
  const cyclic = DEMO_TOML + `
[[connections]]
from = "dolt"
name = "dolt-calls-orders"
appProtocol = "art.grpc"

[[connections.targets]]
env = "local"
bundle = "orders"
port = "grpc"
`;
  const cluster = await parseTomlToCluster(cyclic);
  assert.throws(
    () => startOrder(cluster, "local"),
    /connections in env "local" form a cycle \(dolt → orders → dolt\): each end would have to be running before the other, so there is no start order/,
  );
});

test("kubernetes-placed and unplaced bundles are skipped, each with its reason", async () => {
  const toml = DEMO_TOML.replace(
    '[[connections]]',
    `[[bundles]]
name = "web"
kind = "external"
tier = "cluster"

[bundles.external]
image = "x/web"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "web.yaml"

[[bundles]]
name = "batch"
kind = "external"
tier = "cluster"

[bundles.external]
executionMode = "process"
executionModeRationale = "test"

[[connections]]`,
  );
  const { order, skipped } = startOrder(await parseTomlToCluster(toml), "local");
  assert.deepEqual(order, ["dolt", "orders"]);
  assert.deepEqual(skipped, [
    { name: "web", reason: 'placed "kubernetes" for env "local"; deploy it with `cloister cluster k8s --env local`' },
    { name: "batch", reason: 'no microvm placement for env "local"' },
  ]);
});

test("the channel dir is created under /tmp and returned by its real path (macOS /tmp is a symlink)", () => {
  const made = [];
  const dir = makeChannelDir((prefix) => { made.push(prefix); return "/tmp/cloister-up-abc"; }, (p) => `/private${p}`);
  assert.deepEqual(made, ["/tmp/cloister-up-"]);
  assert.equal(dir, "/private/tmp/cloister-up-abc");
  // A real one: owner-only, and short enough that a socket path fits sun_path.
  const real = makeChannelDir();
  try {
    assert.equal(real, realpathSync(real));
    assert.ok(Buffer.byteLength(join(real, "orders.grpc.sock")) <= 103);
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

// ── the lock records the rootfs (Part A) ─────────────────────────────────

test("recordRootfs writes rootfs beside the pin, omits the default symlink mode, and is idempotent", () => {
  const text = lockText({ dolt: { digest: IMG("a") } });
  const first = recordRootfs(text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse" });
  assert.equal(first.changed, true);
  const oci = parseToml(first.text).inputs.dolt.oci;
  assert.equal(oci.rootfs, RFS("b"));
  assert.equal("rootfsSymlinks" in oci, false);
  const again = recordRootfs(first.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse" });
  assert.equal(again.changed, false);
  assert.equal(again.text, first.text);
  const resolved = recordRootfs(first.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("c"), symlinks: "resolve" });
  assert.equal(resolved.previous, RFS("b"));
  assert.equal(parseToml(resolved.text).inputs.dolt.oci.rootfsSymlinks, "resolve");
});

const recordRefusals = [
  ["no pinned image", lockText({}), { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse" }, /cluster.lock.toml pins no image for bundle "dolt" \(\[inputs.dolt.oci\] digest\)/],
  ["a different image", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("c"), rootfs: RFS("b"), symlinks: "refuse" }, /--image sha256:c+ is not bundle "dolt"'s locked image sha256:a+/],
  ["a non-blake3 rootfs", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("a"), rootfs: IMG("b"), symlinks: "refuse" }, /the importer returned rootfs "sha256:b+", not a blake3-256 digest/],
  ["an unknown symlink mode", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "follow" }, /--symlinks must be one of refuse, resolve/],
];
for (const [label, text, rec, pattern] of recordRefusals) {
  test(`recordRootfs refuses by name: ${label}`, () => {
    assert.throws(() => recordRootfs(text, rec), pattern);
  });
}

test("carryRootfs keeps the rootfs while the image digest is unchanged, drops it when the image moves", () => {
  const prev = { digest: IMG("a"), rootfs: RFS("b"), rootfsSymlinks: "resolve" };
  assert.deepEqual(carryRootfs(prev, { identifier: "x", digest: IMG("a") }), {
    identifier: "x", digest: IMG("a"), rootfs: RFS("b"), rootfsSymlinks: "resolve",
  });
  assert.deepEqual(carryRootfs(prev, { identifier: "x", digest: IMG("c") }), { identifier: "x", digest: IMG("c") });
});

test("cluster resolve's lock rewrite carries a recorded rootfs forward (carryRootfsFromPreviousLock)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloister-carry-"));
  try {
    const path = join(dir, "cluster.lock.toml");
    writeFileSync(path, lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
    const doc = { inputs: { dolt: { oci: { identifier: "x/dolt", digest: IMG("a") } }, orders: { oci: { identifier: "x/orders", digest: IMG("e") } } } };
    carryRootfsFromPreviousLock(path, doc);
    assert.equal(doc.inputs.dolt.oci.rootfs, RFS("b"));
    assert.equal(doc.inputs.orders.oci.rootfs, undefined, "a new image digest drops the stale rootfs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isBlake3Digest is exact", () => {
  assert.equal(isBlake3Digest(RFS("a")), true);
  for (const bad of [IMG("a"), `blake3-256:${"A".repeat(64)}`, `blake3-256:${"a".repeat(63)}`, ""]) {
    assert.equal(isBlake3Digest(bad), false, bad);
  }
});

// ── runtime import --bundle ──────────────────────────────────────────────

function importFixture(oci) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-import-"));
  writeFileSync(join(dir, "cluster.lock.toml"), lockText(oci === null ? {} : { dolt: oci }));
  return dir;
}
function capture() {
  const out = { log: [], err: [] };
  return { out, deps: { log: (m) => out.log.push(m), errLog: (m) => out.err.push(m) } };
}

test("runtime import --bundle derives --image from the lock, imports, and records the rootfs", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    const calls = [];
    const { out, deps } = capture();
    const code = await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/layouts/dolt"], {
      ...deps,
      importOci: (args) => { calls.push(args); return { rootfs: { algorithm: "blake3-256", value: "b".repeat(64) } }; },
    });
    assert.equal(code, 0, out.err.join("\n"));
    assert.deepEqual(calls, [["import-oci", "--layout", "/layouts/dolt", "--image", IMG("a"), "--symlinks", "refuse"]]);
    assert.equal(parseToml(readFileSync(join(dir, "cluster.lock.toml"), "utf8")).inputs.dolt.oci.rootfs, RFS("b"));
    // Idempotent: a second import leaves the lock untouched and says so.
    // lint-allow-rawparse: byte comparison for idempotency, no matching.
    const before = readFileSync(join(dir, "cluster.lock.toml"), "utf8");
    const second = capture();
    await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/layouts/dolt"], {
      ...second.deps,
      importOci: () => ({ rootfs: { algorithm: "blake3-256", value: "b".repeat(64) } }),
    });
    assert.match(second.out.log.join("\n"), /already recorded/);
    assert.equal(readFileSync(join(dir, "cluster.lock.toml"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime import --bundle refuses a different --image BEFORE importing anything", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    let called = false;
    const { out, deps } = capture();
    const code = await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l", "--image", IMG("c")], {
      ...deps,
      importOci: () => { called = true; return {}; },
    });
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.match(out.err.join("\n"), /--image sha256:c+ is not bundle "dolt"'s locked image sha256:a+; the rootfs recorded in the lock must come from the pinned image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime import --bundle refuses a bundle the lock does not pin, and a missing lock", async () => {
  const dir = importFixture(null);
  try {
    const { out, deps } = capture();
    assert.equal(await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], { ...deps, importOci: () => assert.fail("no import") }), 1);
    assert.match(out.err.join("\n"), /cluster.lock.toml pins no image for bundle "dolt"/);
    const empty = mkdtempSync(join(tmpdir(), "cloister-nolock-"));
    const second = capture();
    assert.equal(await importMain(["--bundle", "dolt", "--dir", empty, "--layout", "/l"], second.deps), 1);
    assert.match(second.out.err.join("\n"), /no cluster.lock.toml in .*; --bundle records into the cluster's lock/);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime import argument refusals", () => {
  assert.throws(() => parseImportArgs(["--layout", "/l"]), /--bundle is required/);
  assert.throws(() => parseImportArgs(["--bundle", "d"]), /--layout <oci-layout-dir> is required/);
  assert.throws(() => parseImportArgs(["--bundle", "d", "--layout", "/l", "--symlinks", "x"]), /--symlinks must be one of refuse, resolve/);
  assert.throws(() => parseImportArgs(["--bundle", "d", "--wat", "x"]), /unknown argument "--wat"/);
});

// ── runtime plan emits a runnable plan ───────────────────────────────────

const PLAN_OPTS = { workspace: "/w", controlSocket: "/tmp/c.sock", env: "local", channelDir: "/tmp/ch", dir: "demo" };

test("a microvm plan carries the recorded blake3 rootfs, never the sha256 image", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
  const p = await planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) });
  assert.equal(p.artifact.digest, RFS("b"));
  assert.equal(p.artifact.image, "x/dolt");
});

test("a microvm plan with no recorded rootfs is refused with the exact import command", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a") } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => assert.fail("not consulted") }),
    (e) => {
      assert.match(e.message, /bundle "dolt" is a microvm bundle with no imported rootfs in cluster.lock.toml \(\[inputs.dolt.oci\] rootfs\)/);
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo --layout <oci-layout-dir>"), e.message);
      return true;
    },
  );
});

test("a recorded rootfs missing from the CAS is refused the same way, naming the CAS", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b"), rootfsSymlinks: "resolve" } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: false, casRoot: "/cas" }) }),
    (e) => {
      assert.match(e.message, /bundle "dolt"'s rootfs blake3-256:b+ is recorded in cluster.lock.toml but is not in the CAS \(\/cas\)/);
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo --layout <oci-layout-dir> --symlinks resolve"), e.message);
      return true;
    },
  );
});

test("a malformed recorded rootfs is refused", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: IMG("b") } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }),
    /bundle "dolt" records rootfs "sha256:b+", which is not a blake3-256 digest/,
  );
});

test("a process-mode plan keeps the image digest (unchanged behaviour)", async () => {
  const toml = `
[metadata]
name = "p"
version = "0.0.1"
[storage]
doStoragePath = "/data/do"
[[bundles]]
name = "batch"
kind = "external"
tier = "cluster"
[bundles.external]
entryPoint = "/bin/batch"
executionMode = "process"
executionModeRationale = "test"
`;
  const lock = parseToml(lockText({ batch: { digest: IMG("a") } }));
  const p = await planFromToml(toml, lock, { ...PLAN_OPTS, bundle: "batch" });
  assert.equal(p.artifact.digest, IMG("a"));
});

test("importCommand spells --dir and a non-default symlink mode only when needed", () => {
  assert.equal(importCommand("dolt", "."), "cloister runtime import --bundle dolt --layout <oci-layout-dir>");
  assert.equal(importCommand("dolt", "x", "resolve"), "cloister runtime import --bundle dolt --dir x --layout <oci-layout-dir> --symlinks resolve");
});

// ── cluster up supervision, with a fake host runtime ─────────────────────

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.exitCode = null;
  c.signalCode = null;
  c.stderr = new EventEmitter();
  c.killed = [];
  c.exit = (code, signal) => { c.exitCode = code; c.signalCode = signal; c.emit("exit", code, signal); };
  c.kill = (sig) => { c.killed.push(sig); setImmediate(() => c.exit(128 + 15, null)); return true; };
  return c;
}

async function upHarness({ behave }) {
  const root = mkdtempSync(join(tmpdir(), "cloister-up-test-"));
  writeFileSync(join(root, "cluster.toml"), DEMO_TOML);
  writeFileSync(join(root, "cluster.lock.toml"), lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
  const bound = new Set();
  const children = [];
  const log = [];
  const err = [];
  const signals = new EventEmitter();
  let channelDir;
  const code = await clusterUp({
    root,
    env: "local",
    deps: {
      log: (m) => log.push(m),
      errLog: (m) => err.push(m),
      rootfsInCas: () => ({ present: true, casRoot: "/cas" }),
      hostRuntime: { command: "/fake/cloister-host-runtime", env: {} },
      makeTemp: (prefix) => { channelDir = mkdtempSync(prefix); return channelDir; },
      exists: (p) => bound.has(p) || existsSync(p),
      signals,
      pollMs: 5,
      spawn: (cmd, args) => {
        const plan = JSON.parse(readFileSync(args[1], "utf8"));
        const child = fakeChild(1000 + children.length);
        children.push({ bundle: plan.bundle, plan, child });
        setImmediate(() => behave({ bundle: plan.bundle, plan, child, bound, signals }));
        return child;
      },
    },
  });
  rmSync(root, { recursive: true, force: true });
  return { code, children, log, err, channelDir };
}

test("cluster up starts in order, waits for each bind socket, and stops in reverse on SIGINT", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, bound, signals }) => {
      for (const p of bindPaths(plan)) bound.add(p);
      if (bundle === "orders") setTimeout(() => signals.emit("SIGINT", "SIGINT"), 20);
    },
  });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.deepEqual(r.children.map((c) => c.bundle), ["dolt", "orders"]);
  assert.ok(r.log.some((l) => /orders\.grpc \(art\.grpc\): unix:\/\/.*\/orders\.grpc\.sock$/.test(l)), r.log.join("\n"));
  const stops = r.log.filter((l) => l.startsWith("cloister cluster up: stopped"));
  assert.deepEqual(stops.map((l) => l.match(/"(\w+)"/)[1]), ["orders", "dolt"], "reverse start order");
  assert.equal(existsSync(r.channelDir), false, "the channel dir is removed on exit");
});

test("a bundle that exits before it is ready is reported by name and status; the rest are torn down", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, child, bound }) => {
      if (bundle === "dolt") { for (const p of bindPaths(plan)) bound.add(p); return; }
      child.stderr.emit("data", "cloister-host-runtime: the workload ran and failed: exit status: 2\n");
      child.exit(1, null);
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /bundle "orders" exited on its own with status 1: cloister-host-runtime: the workload ran and failed: exit status: 2 — before it was ready; stopped the rest/);
  assert.deepEqual(r.children.find((c) => c.bundle === "dolt").child.killed, ["SIGTERM"]);
  assert.equal(existsSync(r.channelDir), false);
});

test("a run that ends on its own after everything is ready ends `up` non-zero", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, child, bound }) => {
      for (const p of bindPaths(plan)) bound.add(p);
      if (bundle === "orders") setTimeout(() => child.exit(1, null), 20);
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /bundle "orders" exited on its own with status 1; stopped the rest/);
});

test("cluster up refuses a missing rootfs before starting anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-up-test-"));
  try {
    writeFileSync(join(root, "cluster.toml"), DEMO_TOML);
    writeFileSync(join(root, "cluster.lock.toml"), lockText({ dolt: { digest: IMG("a") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
    let spawned = 0;
    await assert.rejects(
      clusterUp({ root, env: "local", deps: {
        log: () => {}, errLog: () => {}, rootfsInCas: () => ({ present: true, casRoot: "/cas" }),
        hostRuntime: { command: "/fake", env: {} }, spawn: () => { spawned += 1; },
      } }),
      /bundle "dolt" is a microvm bundle with no imported rootfs/,
    );
    assert.equal(spawned, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run stopped at its wall-clock ceiling (host runtime status 124) is reported as the ceiling, not a failure", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, child, bound }) => {
      for (const p of bindPaths(plan)) bound.add(p);
      if (bundle === "orders") setTimeout(() => child.exit(124, null), 20);
    },
  });
  assert.equal(r.code, 124);
  const text = r.err.join("\n");
  assert.match(text, /bundle "orders" reached its wall-clock ceiling and was stopped by the runtime — not a workload failure \(services cannot ask for "no ceiling" yet: ley-line-open-e6b1bb\)/);
  assert.doesNotMatch(text, /exited on its own/);
  assert.ok(r.log.some((l) => /stopped at its wall-clock ceiling .*ley-line-open-e6b1bb/.test(l)), "the ready banner says so");
});
