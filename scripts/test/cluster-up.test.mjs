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
import { main as importMain, parseImportArgs, registryReference } from "../../cli/commands/runtime-import.mjs";
import { planFromToml } from "../../cli/commands/runtime-plan.mjs";
import { carryRootfsFromPreviousLock } from "../../cli/lib/cluster/resolve-inputs.mjs";

const DEMO = new URL("../../tools/dolt-grpc-demo/microvm/cluster.toml", import.meta.url);
const DEMO_TOML = readFileSync(DEMO, "utf8");
const IMG = (c) => `sha256:${c.repeat(64)}`;
const RFS = (c) => `blake3-256:${c.repeat(64)}`;

// smol-toml gives array-of-table rows a null prototype; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ARM = "linux/arm64";
const AMD = "linux/amd64";
// What the host runtime's import-oci prints, reduced to what the CLI reads.
const imported = (c, platform = { os: "linux", architecture: "arm64" }) =>
  ({ rootfs: { algorithm: "blake3-256", value: c.repeat(64) }, image: { platform } });

// Fixture shorthand: `rootfs` (+ optional `rootfsImage`, `rootfsSymlinks`,
// `platform`) becomes ONE [[inputs.<b>.oci.rootfs]] row for linux/arm64; the
// row's image defaults to the pinned digest unless a test overrides it.
// `rows` passes rows through as written.
function ociRow({ rootfs, rootfsImage, rootfsSymlinks, platform = ARM, rows, ...rest }, hasImage) {
  if (rows) return { ...rest, rootfs: rows };
  if (rootfs === undefined) return rest;
  const row = { platform, digest: rootfs };
  const image = hasImage ? rootfsImage : rest.digest;
  if (image !== undefined) row.image = image;
  if (rootfsSymlinks !== undefined) row.symlinks = rootfsSymlinks;
  return { ...rest, rootfs: [row] };
}
function lockText(rows) {
  return stringifyToml({
    schema: "cloister/lockfile/v1",
    cluster: "t",
    version: "0.0.1",
    inputs: Object.fromEntries(Object.entries(rows).map(([b, oci]) => [b, { oci: {
      identifier: `x/${b}`,
      ...ociRow(oci, "rootfsImage" in oci),
    } }])),
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

test("recordRootfs writes a platform row beside the pin, omits the default symlink mode, and is idempotent", () => {
  const text = lockText({ dolt: { digest: IMG("a") } });
  const first = recordRootfs(text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse", platform: ARM });
  assert.equal(first.changed, true);
  assert.deepEqual(plain(parseToml(first.text).inputs.dolt.oci.rootfs), [{ platform: ARM, digest: RFS("b"), image: IMG("a") }]);
  // The TOML is an array of tables under the oci table.
  assert.match(first.text, /^\[\[inputs\.dolt\.oci\.rootfs\]\]$/m);
  const again = recordRootfs(first.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse", platform: ARM });
  assert.equal(again.changed, false);
  assert.equal(again.text, first.text);
  const resolved = recordRootfs(first.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("c"), symlinks: "resolve", platform: ARM });
  assert.equal(resolved.previous, RFS("b"));
  assert.deepEqual(plain(parseToml(resolved.text).inputs.dolt.oci.rootfs), [
    { platform: ARM, digest: RFS("c"), image: IMG("a"), symlinks: "resolve" },
  ]);
});

test("importing on one platform adds or replaces only that platform's row", () => {
  const text = lockText({ dolt: { digest: IMG("a"), rows: [{ platform: ARM, digest: RFS("b"), image: IMG("a") }] } });
  const amd = recordRootfs(text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("c"), symlinks: "refuse", platform: AMD });
  assert.equal(amd.previous, null);
  const both = plain(parseToml(amd.text).inputs.dolt.oci.rootfs);
  assert.deepEqual(both, [
    { platform: AMD, digest: RFS("c"), image: IMG("a") },
    { platform: ARM, digest: RFS("b"), image: IMG("a") },
  ]);
  const armAgain = recordRootfs(amd.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("d"), symlinks: "refuse", platform: ARM });
  assert.deepEqual(plain(parseToml(armAgain.text).inputs.dolt.oci.rootfs), [
    { platform: AMD, digest: RFS("c"), image: IMG("a") },
    { platform: ARM, digest: RFS("d"), image: IMG("a") },
  ], "the amd64 row is untouched");
  // A variant is kept exactly as LLO reported it. linux/arm64/v8 overlaps
  // linux/arm64 (one host selects both), so it REPLACES that row.
  const v8 = recordRootfs(text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("e"), symlinks: "refuse", platform: "linux/arm64/v8" });
  assert.deepEqual(plain(parseToml(v8.text).inputs.dolt.oci.rootfs), [{ platform: "linux/arm64/v8", digest: RFS("e"), image: IMG("a") }]);
});

test("a re-import replaces the old flat record with a platform row", () => {
  const legacy = stringifyToml({ inputs: { dolt: { oci: {
    identifier: "x/dolt", digest: IMG("a"), rootfs: RFS("b"), rootfsImage: IMG("a"), rootfsSymlinks: "resolve",
  } } } });
  const r = recordRootfs(legacy, { bundle: "dolt", image: IMG("a"), rootfs: RFS("c"), symlinks: "resolve", platform: ARM });
  assert.equal(r.previous, RFS("b"));
  assert.deepEqual(plain(parseToml(r.text).inputs.dolt.oci), {
    identifier: "x/dolt", digest: IMG("a"), rootfs: [{ platform: ARM, digest: RFS("c"), image: IMG("a"), symlinks: "resolve" }],
  });
});

const recordRefusals = [
  ["no pinned image", lockText({}), { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse", platform: ARM }, /cluster.lock.toml pins no image for bundle "dolt" \(\[inputs.dolt.oci\] digest\)/],
  ["a different image", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("c"), rootfs: RFS("b"), symlinks: "refuse", platform: ARM }, /--image sha256:c+ is not bundle "dolt"'s locked image sha256:a+/],
  ["a non-blake3 rootfs", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("a"), rootfs: IMG("b"), symlinks: "refuse", platform: ARM }, /the importer returned rootfs "sha256:b+", not a blake3-256 digest/],
  ["an unknown symlink mode", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "follow", platform: ARM }, /--symlinks must be one of refuse, resolve/],
  ["no platform from the importer", lockText({ dolt: { digest: IMG("a") } }), { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse", platform: null }, /the importer reported no platform for the rootfs it built \(null\); the rootfs was NOT recorded/],
];
for (const [label, text, rec, pattern] of recordRefusals) {
  test(`recordRootfs refuses by name: ${label}`, () => {
    assert.throws(() => recordRootfs(text, rec), pattern);
  });
}

test("carryRootfs keeps EVERY platform's row while the pin is unchanged, and drops them all when it moves", () => {
  const rows = [
    { platform: AMD, digest: RFS("c"), image: IMG("a") },
    { platform: ARM, digest: RFS("b"), image: IMG("a"), symlinks: "resolve" },
  ];
  const prev = { digest: IMG("a"), rootfs: rows };
  const kept = carryRootfs(prev, { identifier: "x", digest: IMG("a") });
  assert.deepEqual(kept, { identifier: "x", digest: IMG("a"), rootfs: rows });
  assert.notEqual(kept.rootfs, rows, "carried by value, not shared");
  assert.deepEqual(carryRootfs(prev, { identifier: "x", digest: IMG("e") }), { identifier: "x", digest: IMG("e") });
  // A fresh import in the new row is never overwritten by the old ones.
  const fresh = [{ platform: ARM, digest: RFS("f"), image: IMG("a") }];
  assert.deepEqual(carryRootfs(prev, { identifier: "x", digest: IMG("a"), rootfs: fresh }).rootfs, fresh);
  // The old flat record rides along unchanged, so plan refuses it by name.
  const legacy = { digest: IMG("a"), rootfs: RFS("b"), rootfsImage: IMG("a") };
  assert.deepEqual(carryRootfs(legacy, { identifier: "x", digest: IMG("a") }), { identifier: "x", ...legacy });
});

test("cluster resolve's lock rewrite carries a recorded rootfs forward (carryRootfsFromPreviousLock)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloister-carry-"));
  try {
    const path = join(dir, "cluster.lock.toml");
    writeFileSync(path, lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
    const doc = { inputs: { dolt: { oci: { identifier: "x/dolt", digest: IMG("a") } }, orders: { oci: { identifier: "x/orders", digest: IMG("e") } } } };
    carryRootfsFromPreviousLock(path, doc);
    assert.deepEqual(doc.inputs.dolt.oci.rootfs, [{ platform: ARM, digest: RFS("b"), image: IMG("a") }]);
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
  // prepareCas is the real CAS attach/override check; these import tests are
  // about the lock, so it is stubbed (it has its own tests).
  return { out, deps: { log: (m) => out.log.push(m), errLog: (m) => out.err.push(m), prepareCas: () => {} } };
}

test("runtime import --bundle derives --image from the lock, imports, and records the rootfs", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    const calls = [];
    const { out, deps } = capture();
    const code = await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/layouts/dolt"], {
      ...deps,
      importOci: (args) => { calls.push(args); return imported("b"); },
    });
    assert.equal(code, 0, out.err.join("\n"));
    assert.deepEqual(calls, [["import-oci", "--layout", "/layouts/dolt", "--image", IMG("a"), "--symlinks", "refuse"]]);
    assert.deepEqual(plain(parseToml(readFileSync(join(dir, "cluster.lock.toml"), "utf8")).inputs.dolt.oci.rootfs), [
      { platform: ARM, digest: RFS("b"), image: IMG("a") },
    ]);
    // Idempotent: a second import leaves the lock untouched and says so.
    // lint-allow-rawparse: byte comparison for idempotency, no matching.
    const before = readFileSync(join(dir, "cluster.lock.toml"), "utf8");
    const second = capture();
    await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/layouts/dolt"], {
      ...second.deps,
      importOci: () => (imported("b")),
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
  // --layout is optional: without it the pinned image is pulled from its registry.
  assert.equal(parseImportArgs(["--bundle", "d"]).layout, null);
  assert.throws(() => parseImportArgs(["--bundle", "d", "--layout", "/l", "--symlinks", "x"]), /--symlinks must be one of refuse, resolve/);
  assert.throws(() => parseImportArgs(["--bundle", "d", "--wat", "x"]), /unknown argument "--wat"/);
});

// ── runtime plan emits a runnable plan ───────────────────────────────────

const PLAN_OPTS = { workspace: "/w", controlSocket: "/tmp/c.sock", env: "local", channelDir: "/tmp/ch", dir: "demo", guestPlatform: () => ARM };

test("a microvm plan carries the recorded blake3 rootfs, never the sha256 image", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
  const p = await planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) });
  assert.equal(p.artifact.digest, RFS("b"));
  assert.equal(p.artifact.image, "x/dolt");
});

test("a microvm plan with no recorded rootfs is refused with the exact import command", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a") } }));
  await assert.rejects(
    // With nothing recorded, neither the CAS nor the host runtime is asked.
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => assert.fail("not consulted"), guestPlatform: () => assert.fail("not asked") }),
    (e) => {
      assert.match(e.message, /bundle "dolt" is a microvm bundle with no imported rootfs in cluster.lock.toml \(\[\[inputs.dolt.oci.rootfs\]\]\)\. Import its pinned image first:/);
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo [--layout <oci-layout-dir>]"), e.message);
      return true;
    },
  );
});

test("a recorded rootfs missing from the CAS is refused the same way, naming the CAS", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b"), rootfsSymlinks: "resolve" } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: false, casRoot: "/cas" }) }),
    (e) => {
      assert.match(e.message, /bundle "dolt"'s linux\/arm64 rootfs blake3-256:b+ is recorded in cluster.lock.toml but is not in the CAS \(\/cas\)/);
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo [--layout <oci-layout-dir>] --symlinks resolve"), e.message);
      return true;
    },
  );
});

test("a malformed recorded rootfs is refused", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: IMG("b") } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }),
    /bundle "dolt" records rootfs "sha256:b+" for linux\/arm64, which is not a blake3-256 digest/,
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
  assert.equal(importCommand("dolt", "."), "cloister runtime import --bundle dolt [--layout <oci-layout-dir>]");
  assert.equal(importCommand("dolt", "x", "resolve"), "cloister runtime import --bundle dolt --dir x [--layout <oci-layout-dir>] --symlinks resolve");
});

// ── cluster up supervision, with a fake host runtime ─────────────────────

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.exitCode = null;
  c.signalCode = null;
  c.stderr = new EventEmitter();
  c.killed = [];
  c.exit = (code, signal) => {
    c.exitCode = code;
    c.signalCode = signal;
    c.emit("exit", code, signal);
    c.stderr.emit("end");
    c.emit("close", code, signal);
  };
  c.kill = (sig) => { c.killed.push(sig); setImmediate(() => c.exit(128 + 15, null)); return true; };
  return c;
}

async function upHarness({ behave, events = [] }) {
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
      guestPlatform: () => ARM,
      // The demo publishes dolt.mysql and orders.grpc (expose = "edge"); the
      // real listeners are tested in edge-relay / cluster-up-process tests.
      openEdge: async (edges) => edges.map((edge) => {
        events.push(`reserve ${edge.bundle}.${edge.name}:${edge.port}`);
        return {
          edge,
          activate: () => events.push(`activate ${edge.bundle}.${edge.name}`),
          close: async () => { events.push(`close ${edge.bundle}.${edge.name}`); },
        };
      }),
      hostRuntime: { command: "/fake/cloister-host-runtime", env: {} },
      makeTemp: (prefix) => { channelDir = mkdtempSync(prefix); return channelDir; },
      exists: (p) => bound.has(p) || existsSync(p),
      signals,
      pollMs: 5,
      spawn: (_command, args) => {
        assert.deepEqual(args.slice(0, 2), ["run", "--stop-on-stdin-eof"], "supervised runs stop on stdin EOF");
        const plan = JSON.parse(readFileSync(args[2], "utf8"));
        events.push(`start ${plan.bundle}`);
        const child = fakeChild(1000 + children.length);
        const kill = child.kill;
        child.kill = (sig) => { events.push(`stop ${plan.bundle}`); return kill(sig); };
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

test("a bundle that exits before it is bound is reported by name and status; the rest are torn down", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, child, bound }) => {
      if (bundle === "dolt") { for (const p of bindPaths(plan)) bound.add(p); return; }
      child.stderr.emit("data", "cloister-host-runtime: the workload ran and failed: exit status: 2\n");
      child.exit(1, null);
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /bundle "orders" exited on its own with status 1: cloister-host-runtime: the workload ran and failed: exit status: 2\ncloister cluster up: "orders" ended on its own; stopped the rest/);
  assert.deepEqual(r.children.find((c) => c.bundle === "dolt").child.killed, ["SIGTERM"]);
  assert.equal(existsSync(r.channelDir), false);
});

test("a run that ends on its own after everything is bound ends `up` non-zero", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, child, bound }) => {
      for (const p of bindPaths(plan)) bound.add(p);
      if (bundle === "orders") setTimeout(() => child.exit(1, null), 20);
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /bundle "orders" exited on its own with status 1\ncloister cluster up: "orders" ended on its own; stopped the rest/);
});

test("cluster up refuses a missing rootfs before starting anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-up-test-"));
  try {
    writeFileSync(join(root, "cluster.toml"), DEMO_TOML);
    writeFileSync(join(root, "cluster.lock.toml"), lockText({ dolt: { digest: IMG("a") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
    let spawned = 0;
    await assert.rejects(
      clusterUp({ root, env: "local", deps: {
        log: () => {}, errLog: () => {}, rootfsInCas: () => ({ present: true, casRoot: "/cas" }), guestPlatform: () => ARM,
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
  assert.ok(r.log.some((l) => /stopped at its wall-clock ceiling .*ley-line-open-e6b1bb/.test(l)), "the bound banner says so");
});

// ── review fixes 7, 8, 10, 11 ─────────────────────────────────────────────

test("a rootfs row imported from a different image than the current pin is refused (row image)", async () => {
  // A hand-edited pin: digest moved to IMG("c"), the rootfs still came from IMG("a").
  const lock = parseToml(lockText({ dolt: { digest: IMG("c"), rootfs: RFS("b"), rootfsImage: IMG("a") } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }),
    (e) => {
      assert.match(e.message, /bundle "dolt"'s linux\/arm64 rootfs blake3-256:b+ was imported from sha256:a+ \(\[\[inputs.dolt.oci.rootfs\]\] image\), but the lock now pins sha256:c+/);
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo [--layout <oci-layout-dir>]"), e.message);
      return true;
    },
  );
});

test("a rootfs row with no recorded image is refused: it is bound to no image", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b"), rootfsImage: undefined } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }),
    /was imported from an unrecorded image/,
  );
});

test("a hand-edited row symlinks is refused before it is echoed into a command", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b"), rootfsSymlinks: "x; rm -rf ~" } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: false, casRoot: "/cas" }) }),
    /\[\[inputs.dolt.oci.rootfs\]\] row 1 records symlinks = "x; rm -rf ~"; it must be one of refuse, resolve/,
  );
});

test("a bundle pinned only through [[inputs.<input>.ociBundles]] is refused by name, not treated as unpinned", async () => {
  const lock = {
    schema: "cloister/lockfile/v1",
    inputs: { producer: { ociBundles: [{ bundle: "dolt", identifier: "x/dolt", digest: IMG("a") }] } },
  };
  const pattern = /bundle "dolt" is pinned through \[\[inputs.producer.ociBundles\]\] \(a multi-image producer\), which runtime import \/ runtime plan \/ cluster up do not support yet/;
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }),
    pattern,
  );
  const dir = mkdtempSync(join(tmpdir(), "cloister-import-"));
  try {
    writeFileSync(join(dir, "cluster.lock.toml"), stringifyToml(lock));
    const { out, deps } = capture();
    assert.equal(await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], { ...deps, importOci: () => assert.fail("no import") }), 1);
    assert.match(out.err.join("\n"), pattern);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime import re-reads the lock after importing and refuses if the pin moved meanwhile", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    const lockPath = join(dir, "cluster.lock.toml");
    const { out, deps } = capture();
    const code = await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], {
      ...deps,
      importOci: () => {
        // A resolve lands while the (slow) import runs.
        writeFileSync(lockPath, lockText({ dolt: { digest: IMG("c") } }));
        return imported("b");
      },
    });
    assert.equal(code, 1);
    assert.match(out.err.join("\n"), /bundle "dolt"'s pin changed in cluster.lock.toml while importing \(was sha256:a+\); the rootfs was NOT recorded/);
    const after = parseToml(readFileSync(lockPath, "utf8")).inputs.dolt.oci;
    assert.equal(after.digest, IMG("c"));
    assert.equal(after.rootfs, undefined, "nothing recorded against the new pin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime import records the pinned image in the row beside the rootfs", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    const { deps } = capture();
    await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], {
      ...deps,
      importOci: () => (imported("b")),
    });
    const oci = parseToml(readFileSync(join(dir, "cluster.lock.toml"), "utf8")).inputs.dolt.oci;
    assert.equal(oci.rootfs[0].image, IMG("a"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spawn failure is reported without a pid, and the rest are stopped", async () => {
  const r = await upHarness({
    behave: ({ bundle, plan, child, bound }) => {
      if (bundle === "dolt") { for (const p of bindPaths(plan)) bound.add(p); return; }
      child.pid = undefined;
      child.emit("error", new Error("spawn ENOENT"));
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /bundle "orders" could not be started: spawn ENOENT/);
  assert.doesNotMatch(r.log.join("\n"), /pid undefined/);
});

// ── registry source (cloister-727354) ─────────────────────────────────────

test("runtime import --bundle with no --layout pulls the pinned identifier@digest from its registry", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    const calls = [];
    const { out, deps } = capture();
    const code = await importMain(["--bundle", "dolt", "--dir", dir, "--symlinks", "resolve"], {
      ...deps,
      importOci: (args) => { calls.push(args); return imported("b"); },
    });
    assert.equal(code, 0, out.err.join("\n"));
    assert.deepEqual(calls, [["import-oci", "--from-registry", `x/dolt@${IMG("a")}`, "--symlinks", "resolve"]]);
    const oci = plain(parseToml(readFileSync(join(dir, "cluster.lock.toml"), "utf8")).inputs.dolt.oci);
    assert.deepEqual(oci.rootfs, [{ platform: ARM, digest: RFS("b"), image: IMG("a"), symlinks: "resolve" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registry pull is refused for an identifier carrying a tag or digest, or an unpinned image", () => {
  assert.equal(registryReference("d", { identifier: "ghcr.io:443/o/app", digest: IMG("a") }), `ghcr.io:443/o/app@${IMG("a")}`,
    "a registry port is not a tag");
  assert.throws(() => registryReference("d", { identifier: "o/app:1.2", digest: IMG("a") }), /carries a tag or digest of its own/);
  assert.throws(() => registryReference("d", { identifier: `o/app@${IMG("b")}`, digest: IMG("a") }), /carries a tag or digest of its own/);
  assert.throws(() => registryReference("d", { identifier: "o/app", digest: "" }), /not pinned by an immutable sha256 digest .* never pulled/);
  assert.throws(() => registryReference("d", { identifier: "", digest: IMG("a") }), /has no \[inputs.d.oci\] identifier/);
});

// ── one rootfs row per platform (cloister-1c4ef5) ─────────────────────────

const TWO_PLATFORMS = {
  dolt: { digest: IMG("a"), rows: [
    { platform: AMD, digest: RFS("c"), image: IMG("a") },
    { platform: ARM, digest: RFS("b"), image: IMG("a") },
  ] },
  orders: { digest: IMG("e"), rows: [{ platform: ARM, digest: RFS("d"), image: IMG("e") }] },
};

test("plan selects the row for the host runtime's guest platform, under one pin", async () => {
  const lock = parseToml(lockText(TWO_PLATFORMS));
  const seen = [];
  const inCas = (hex) => { seen.push(hex); return { present: true, casRoot: "/cas" }; };
  const arm = await planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: inCas, guestPlatform: () => ARM });
  assert.equal(arm.artifact.digest, RFS("b"));
  const amd = await planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: inCas, guestPlatform: () => AMD });
  assert.equal(amd.artifact.digest, RFS("c"));
  assert.deepEqual(seen, ["b".repeat(64), "c".repeat(64)], "the CAS check is of the selected row");
  // A host platform with no variant admits a recorded variant (LLO's rule).
  const v8 = parseToml(lockText({ dolt: { digest: IMG("a"), rows: [{ platform: "linux/arm64/v8", digest: RFS("f"), image: IMG("a") }] } }));
  assert.equal((await planFromToml(DEMO_TOML, v8, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: inCas })).artifact.digest, RFS("f"));
});

test("no row for this host's platform is refused with the import command, naming what is recorded", async () => {
  const lock = parseToml(lockText(TWO_PLATFORMS));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "orders", rootfsInCas: () => assert.fail("not consulted"), guestPlatform: () => AMD }),
    (e) => {
      assert.match(e.message, /bundle "orders" is a microvm bundle with no imported rootfs for this host's guest platform linux\/amd64 in cluster.lock.toml \(\[\[inputs.orders.oci.rootfs\]\]\) \(it records linux\/arm64\)\. Import its pinned image on this host:/);
      assert.ok(e.message.endsWith("cloister runtime import --bundle orders --dir demo [--layout <oci-layout-dir>]"), e.message);
      return true;
    },
  );
});

test("the old flat rootfs shape is refused by name with the re-import command, never migrated", async () => {
  const lock = { inputs: { dolt: { oci: {
    identifier: "x/dolt", digest: IMG("a"), rootfs: RFS("b"), rootfsImage: IMG("a"), rootfsSymlinks: "resolve",
  } } } };
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => assert.fail("not consulted"), guestPlatform: () => assert.fail("not consulted") }),
    (e) => {
      assert.match(e.message, /bundle "dolt" records its rootfs in the old flat shape \(\[inputs.dolt.oci\] rootfs = "…" \/ rootfsImage\), which does not say which platform it is for, so it is not migrated/);
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo [--layout <oci-layout-dir>] --symlinks resolve"), e.message);
      return true;
    },
  );
});

test("two rows a host platform both admits are refused, not guessed between", async () => {
  const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rows: [
    { platform: ARM, digest: RFS("b"), image: IMG("a") },
    { platform: "linux/arm64/v8", digest: RFS("c"), image: IMG("a") },
  ] } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }),
    /bundle "dolt" records more than one rootfs this host's guest platform linux\/arm64 runs \(linux\/arm64, linux\/arm64\/v8\); keep one/,
  );
});

test("malformed rows are refused by row: bad platform, repeated platform, not a list", async () => {
  const cases = [
    [[{ platform: "arm64", digest: RFS("b"), image: IMG("a") }], /row 1 has platform "arm64", not os\/architecture\[\/variant\]/],
    [[{ platform: ARM, digest: RFS("b"), image: IMG("a") }, { platform: ARM, digest: RFS("c"), image: IMG("a") }], /row 2 repeats platform linux\/arm64/],
  ];
  for (const [rows, pattern] of cases) {
    const lock = parseToml(lockText({ dolt: { digest: IMG("a"), rows } }));
    await assert.rejects(planFromToml(DEMO_TOML, lock, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }), pattern);
  }
  const notList = { inputs: { dolt: { oci: { identifier: "x/dolt", digest: IMG("a"), rootfs: { platform: ARM } } } } };
  await assert.rejects(planFromToml(DEMO_TOML, notList, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) }), /rootfs must be a list of rows/);
});

test("runtime import on one platform keeps the other platform's row; a pin change then drops them all", async () => {
  const dir = importFixture({ digest: IMG("a"), rows: [{ platform: AMD, digest: RFS("c"), image: IMG("a") }] });
  try {
    const lockPath = join(dir, "cluster.lock.toml");
    const { out, deps } = capture();
    assert.equal(await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], { ...deps, importOci: () => imported("b") }), 0, out.err.join("\n"));
    assert.match(out.log.join("\n"), /dolt \(linux\/arm64\): sha256:a+ → blake3-256:b+; recorded in/);
    assert.deepEqual(plain(parseToml(readFileSync(lockPath, "utf8")).inputs.dolt.oci.rootfs), [
      { platform: AMD, digest: RFS("c"), image: IMG("a") },
      { platform: ARM, digest: RFS("b"), image: IMG("a") },
    ]);
    // A regeneration that keeps the pin keeps both; one that moves it drops both.
    const keep = { inputs: { dolt: { oci: { identifier: "x/dolt", digest: IMG("a") } } } };
    carryRootfsFromPreviousLock(lockPath, keep);
    assert.equal(keep.inputs.dolt.oci.rootfs.length, 2);
    const moved = { inputs: { dolt: { oci: { identifier: "x/dolt", digest: IMG("f") } } } };
    carryRootfsFromPreviousLock(lockPath, moved);
    assert.equal(moved.inputs.dolt.oci.rootfs, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime import records nothing when the importer reports no platform", async () => {
  const dir = importFixture({ digest: IMG("a") });
  try {
    // lint-allow-rawparse: byte comparison, no matching.
    const before = readFileSync(join(dir, "cluster.lock.toml"), "utf8");
    const { out, deps } = capture();
    const code = await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], {
      ...deps,
      importOci: () => ({ rootfs: { algorithm: "blake3-256", value: "b".repeat(64) }, image: {} }),
    });
    assert.equal(code, 1);
    assert.match(out.err.join("\n"), /the importer reported no platform for the rootfs it built \(null\); the rootfs was NOT recorded/);
    assert.equal(readFileSync(join(dir, "cluster.lock.toml"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #291 review fixes ─────────────────────────────────────────────────────

test("the no-row remedy carries the recorded rows' common --symlinks, or lists them when they disagree", async () => {
  const same = parseToml(lockText({ dolt: { digest: IMG("a"), rows: [
    { platform: ARM, digest: RFS("b"), image: IMG("a"), symlinks: "resolve" },
    { platform: "linux/riscv64", digest: RFS("c"), image: IMG("a"), symlinks: "resolve" },
  ] } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, same, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => assert.fail("not consulted"), guestPlatform: () => AMD }),
    (e) => {
      assert.ok(e.message.endsWith("cloister runtime import --bundle dolt --dir demo [--layout <oci-layout-dir>] --symlinks resolve"), e.message);
      return true;
    },
  );
  const differ = parseToml(lockText({ dolt: { digest: IMG("a"), rows: [
    { platform: ARM, digest: RFS("b"), image: IMG("a"), symlinks: "resolve" },
    { platform: "linux/riscv64", digest: RFS("c"), image: IMG("a") },
  ] } }));
  await assert.rejects(
    planFromToml(DEMO_TOML, differ, { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => assert.fail("not consulted"), guestPlatform: () => AMD }),
    (e) => {
      assert.ok(e.message.includes("cloister runtime import --bundle dolt --dir demo [--layout <oci-layout-dir>] --symlinks <policy>\n"), e.message);
      assert.match(e.message, /The recorded rows disagree on --symlinks: linux\/arm64 used resolve; linux\/riscv64 used refuse$/);
      return true;
    },
  );
});

test("an import replaces every row its platform overlaps, so a variant mismatch is repairable", async () => {
  // linux/arm64/v8 recorded; the importer now reports linux/arm64. Exact-string
  // keying would add a second row that plan refuses as ambiguous forever.
  const text = lockText({ dolt: { digest: IMG("a"), rows: [
    { platform: "linux/arm64/v8", digest: RFS("b"), image: IMG("a") },
    { platform: AMD, digest: RFS("c"), image: IMG("a") },
    { platform: "linux/arm/v7", digest: RFS("d"), image: IMG("a") },
  ] } });
  const r = recordRootfs(text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("e"), symlinks: "refuse", platform: ARM });
  assert.equal(r.previous, RFS("b"));
  const rows = plain(parseToml(r.text).inputs.dolt.oci.rootfs);
  assert.deepEqual(rows, [
    { platform: AMD, digest: RFS("c"), image: IMG("a") },
    { platform: "linux/arm/v7", digest: RFS("d"), image: IMG("a") },
    { platform: ARM, digest: RFS("e"), image: IMG("a") },
  ], "amd64 and arm/v7 are kept; only the overlapping arm64/v8 row is replaced");
  // And plan, which refused the two-row state, now selects the one row.
  const plan = await planFromToml(DEMO_TOML, parseToml(r.text), { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => ({ present: true, casRoot: "/cas" }) });
  assert.equal(plan.artifact.digest, RFS("e"));
  // Non-overlapping variants of one architecture stay separate rows.
  const v6 = recordRootfs(r.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("f"), symlinks: "refuse", platform: "linux/arm/v6" });
  assert.deepEqual(plain(parseToml(v6.text).inputs.dolt.oci.rootfs).map((x) => x.platform), [AMD, "linux/arm/v6", "linux/arm/v7", ARM]);
  // Re-recording the identical row is still a no-op.
  assert.equal(recordRootfs(r.text, { bundle: "dolt", image: IMG("a"), rootfs: RFS("e"), symlinks: "refuse", platform: ARM }).changed, false);
});

test("rows mixed with flat keys are refused by name at import and at plan, never collapsed", async () => {
  const mixed = stringifyToml({ inputs: { dolt: { oci: {
    identifier: "x/dolt", digest: IMG("a"), rootfsImage: IMG("a"),
    rootfs: [{ platform: AMD, digest: RFS("c"), image: IMG("a") }],
  } } } });
  const pattern = /bundle "dolt" records BOTH \[\[inputs\.dolt\.oci\.rootfs\]\] rows and the old flat key\(s\) rootfsImage in \[inputs\.dolt\.oci\]\. A lock holds one shape; the rows are the current one\. Remove rootfsImage from \[inputs\.dolt\.oci\] by hand/;
  assert.throws(
    () => recordRootfs(mixed, { bundle: "dolt", image: IMG("a"), rootfs: RFS("b"), symlinks: "refuse", platform: ARM }),
    pattern,
  );
  await assert.rejects(
    planFromToml(DEMO_TOML, parseToml(mixed), { ...PLAN_OPTS, bundle: "dolt", rootfsInCas: () => assert.fail("not consulted"), guestPlatform: () => assert.fail("not asked") }),
    pattern,
  );
  // Through the real import command: refused, and the lock is untouched.
  const dir = mkdtempSync(join(tmpdir(), "cloister-import-"));
  try {
    writeFileSync(join(dir, "cluster.lock.toml"), mixed);
    const { out, deps } = capture();
    assert.equal(await importMain(["--bundle", "dolt", "--dir", dir, "--layout", "/l"], { ...deps, importOci: () => imported("b") }), 1);
    assert.match(out.err.join("\n"), pattern);
    assert.equal(readFileSync(join(dir, "cluster.lock.toml"), "utf8"), mixed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── expose = "edge" in cluster up (cloister-991e65) ───────────────────────

test("edge ports are reserved before anything starts, relay after their bundle is bound, and close before any run stops", async () => {
  const events = [];
  const r = await upHarness({
    events,
    behave: ({ bundle, plan, bound, signals }) => {
      for (const p of bindPaths(plan)) bound.add(p);
      if (bundle === "orders") setTimeout(() => signals.emit("SIGINT", "SIGINT"), 20);
    },
  });
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.deepEqual(events, [
    "reserve dolt.mysql:3306",
    "reserve orders.grpc:50051",
    "start dolt",
    "activate dolt.mysql",
    "start orders",
    "activate orders.grpc",
    "close dolt.mysql",
    "close orders.grpc",
    "stop orders",
    "stop dolt",
  ]);
  const out = r.log.join("\n");
  assert.match(out, /cloister cluster up: edge: 127\.0\.0\.1:3306 → dolt\.mysql \(art\.mysql\) \(reachable by anything on this host\)/);
  assert.match(out, /^  edge: 127\.0\.0\.1:50051 → orders\.grpc \(art\.grpc\)$/m);
  assert.match(out, /closed edge listeners \(127\.0\.0\.1:3306, 127\.0\.0\.1:50051\)/);
});

test("a busy edge port stops up before any bundle starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-up-test-"));
  try {
    writeFileSync(join(root, "cluster.toml"), DEMO_TOML);
    writeFileSync(join(root, "cluster.lock.toml"), lockText({ dolt: { digest: IMG("a"), rootfs: RFS("b") }, orders: { digest: IMG("c"), rootfs: RFS("d") } }));
    let spawned = 0;
    await assert.rejects(
      clusterUp({ root, env: "local", deps: {
        log: () => {}, errLog: () => {}, rootfsInCas: () => ({ present: true, casRoot: "/cas" }), guestPlatform: () => ARM,
        openEdge: async () => { throw new Error('host port 127.0.0.1:3306 is already in use, and bundle "dolt" port "mysql" (expose = "edge") publishes on it. Nothing was started.'); },
        hostRuntime: { command: "/fake", env: {} }, spawn: () => { spawned += 1; },
      } }),
      /bundle "dolt" port "mysql" \(expose = "edge"\) publishes on it\. Nothing was started\./,
    );
    assert.equal(spawned, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
