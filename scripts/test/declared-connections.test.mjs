// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Declared ports + connections (ADR-0069 §1–2) and their microvm lowering to
// confinement/v1 §6 grants (ADR-0070 §4), cloister-991e65.
//
// Run with:
//   node --import tsx --test scripts/test/declared-connections.test.mjs
//
// The fixture mirrors a two-bundle demo that ran live: `orders` dials `dolt`
// over art.mysql, and `orders` serves art.grpc itself. The expected `orders`
// allow[] is byte-for-byte the hand-written plan that worked on a live guest.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../cli/lib/cluster/cluster-to-toml.mjs";
import { lowerChannelGrants } from "../../cli/lib/cluster/connections.mjs";
import { parsePlanArgs, planFromToml } from "../../cli/commands/runtime-plan.mjs";
import { tableAdmits } from "./fixtures/platform-admits-table.mjs";

const ADMITS = tableAdmits({
  "linux/arm64": { admitted: ["linux/arm64", "linux/arm64/v8"], overlapping: ["linux/arm64", "linux/arm64/v8"] },
});

const CH = "/tmp/cloister-host-runtime/ch";

function fixtureToml({ extraOrdersPorts = "", connections, doltMode = "microvm", ordersMode = "microvm" } = {}) {
  const conn = connections ?? `
[[connections]]
from = "orders"
name = "orders-db"
appProtocol = "art.mysql"

[[connections.targets]]
env = "local"
bundle = "dolt"
port = "mysql"
`;
  return `
[metadata]
name = "connections-fixture"
version = "0.0.1"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "dolt"
kind = "external"
tier = "cluster"

[bundles.external]
entryPoint = "/usr/local/bin/dolt"
executionMode = "${doltMode}"

[[bundles.ports]]
name = "mysql"
port = 3306
appProtocol = "art.mysql"
expose = "cluster"

[[bundles]]
name = "orders"
kind = "external"
tier = "cluster"

[bundles.external]
entryPoint = "/usr/local/bin/orders"
executionMode = "${ordersMode}"

[[bundles.ports]]
name = "grpc"
port = 50051
appProtocol = "art.grpc"
expose = "cluster"
${extraOrdersPorts}
${conn}
`;
}

const lock = {
  inputs: Object.fromEntries(
    ["dolt", "orders"].map((name) => [
      name,
      // `rootfs` rows are what `runtime import --bundle` records, one per
      // platform; a microvm plan runs this host's, never the sha256 image
      // (cloister-991e65, cloister-1c4ef5).
      { oci: { identifier: `ghcr.io/example/${name}`, digest: `sha256:${"a".repeat(64)}`, rootfs: [{ platform: "linux/arm64", digest: `blake3-256:${"b".repeat(64)}`, image: `sha256:${"a".repeat(64)}` }] } },
    ]),
  ),
};

/** cluster.toml text → plan, through the full parseTomlToCluster pipeline. */
function plan(toml, bundle, extra = {}) {
  return planFromToml(toml, lock, {
    rootfsInCas: () => ({ present: true, casRoot: "/cas" }), guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
    bundle,
    workspace: "/workspace",
    controlSocket: `/tmp/${bundle}.sock`,
    env: "local",
    channelDir: CH,
    ...extra,
  });
}

// ── Build-time checks (toml-to-cluster) ──────────────────────────────────

test("toml-to-cluster accepts the fixture and carries ports + connections", async () => {
  const cluster = await parseTomlToCluster(fixtureToml());
  assert.deepEqual(cluster.bundles.find((b) => b.name === "dolt").ports, [
    { name: "mysql", port: 3306, appProtocol: "art.mysql", expose: "cluster" },
  ]);
  assert.deepEqual(cluster.connections, [
    {
      from: "orders",
      name: "orders-db",
      appProtocol: "art.mysql",
      minStrength: "",
      targets: [{ env: "local", bundle: "dolt", port: "mysql" }],
    },
  ]);
});

test("toml-to-cluster defaults ports and connections to []", async () => {
  const cluster = await parseTomlToCluster(`
[metadata]
name = "bare"
version = "0.0.1"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "a"
kind = "external"
tier = "cluster"
[bundles.external]
`);
  assert.deepEqual(cluster.connections, []);
  assert.deepEqual(cluster.bundles[0].ports, []);
});

test("cluster-to-toml round-trips ports + connections, and omits them when empty", async () => {
  const cluster = await parseTomlToCluster(fixtureToml());
  const again = await parseTomlToCluster(clusterToToml(cluster));
  assert.deepEqual(again, cluster);

  const bare = await parseTomlToCluster(fixtureToml({ connections: "" }).replaceAll(/\[\[bundles\.ports\]\][^[]*/g, ""));
  const text = clusterToToml(bare);
  assert.doesNotMatch(text, /^ports\b|\[\[bundles\.ports\]\]/m);
  assert.doesNotMatch(text, /^connections\b|\[\[connections\]\]/m);
});

const refusals = [
  ["duplicate port name", { extraOrdersPorts: `
[[bundles.ports]]
name = "grpc"
port = 50052
appProtocol = "art.grpc"
expose = "cluster"
` }, /declares port name "grpc" more than once/],
  ["port 0", { extraOrdersPorts: `
[[bundles.ports]]
name = "admin"
port = 0
appProtocol = "art.http"
` }, /port "admin": port must be 1-65535/],
  ["duplicate port number", { extraOrdersPorts: `
[[bundles.ports]]
name = "grpc-alt"
port = 50051
appProtocol = "art.grpc"
` }, /declares port number 50051 twice/],
  ["bad expose", { extraOrdersPorts: `
[[bundles.ports]]
name = "admin"
port = 9000
appProtocol = "art.http"
expose = "public"
` }, /expose "public" is not one of none, cluster, edge/],
  ["bad port appProtocol", { extraOrdersPorts: `
[[bundles.ports]]
name = "admin"
port = 9000
appProtocol = "http"
` }, /port "admin": appProtocol/],
  ["port name with a dot", { extraOrdersPorts: `
[[bundles.ports]]
name = "a.b"
port = 9000
appProtocol = "art.http"
` }, /a port name contains "\."/],
];
const connRefusals = [
  ["from is undeclared", `from = "nope"`, /from "nope" is not a declared bundle/],
  ["no targets", null, /declares no targets/],
  ["duplicate env", `env2`, /declares env "local" more than once/],
  ["target undeclared", `bundle = "ghost"`, /target bundle "ghost" is not declared/],
  ["target is from", `bundle = "orders"`, /is the connection's own from bundle/],
  ["unknown target port", `port = "pg"`, /declares no port named "pg"/],
  ["appProtocol mismatch", `appProtocol = "art.grpc"`, /does not match port "dolt.mysql" appProtocol "art.mysql"/],
  ["bad connection appProtocol", `appProtocol = "mysql"`, /connection "orders-db" \(from "orders"\): appProtocol/],
];

for (const [label, opts, pattern] of refusals) {
  test(`toml-to-cluster refuses by name: ${label}`, async () => {
    await assert.rejects(parseTomlToCluster(fixtureToml(opts)), pattern);
  });
}

function connToml(variant) {
  const head = { from: "orders", name: "orders-db", appProtocol: "art.mysql" };
  const target = { env: "local", bundle: "dolt", port: "mysql" };
  let targets = [target];
  if (variant === null) targets = [];
  else if (variant === "env2") targets = [target, target];
  else {
    const [k, v] = variant.split(" = ");
    const value = JSON.parse(v);
    if (k in head) head[k] = value;
    else target[k] = value;
  }
  const lines = ["[[connections]]", ...Object.entries(head).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)];
  for (const t of targets) {
    lines.push("", "[[connections.targets]]", ...Object.entries(t).map(([k, v]) => `${k} = ${JSON.stringify(v)}`));
  }
  return lines.join("\n") + "\n";
}

for (const [label, variant, pattern] of connRefusals) {
  test(`toml-to-cluster refuses by name: connection ${label}`, async () => {
    await assert.rejects(parseTomlToCluster(fixtureToml({ connections: connToml(variant) })), pattern);
  });
}

test("toml-to-cluster refuses a duplicate (from, name)", async () => {
  const c = connToml("appProtocol = \"art.mysql\"");
  await assert.rejects(
    parseTomlToCluster(fixtureToml({ connections: c + "\n" + c })),
    /connection "orders-db" \(from "orders"\) is declared more than once/,
  );
});

test("toml-to-cluster refuses a connection to an expose=\"none\" port", async () => {
  const toml = fixtureToml().replace('expose = "cluster"', 'expose = "none"');
  await assert.rejects(parseTomlToCluster(toml), /port "dolt.mysql" has expose "none"/);
});

// ── Emitter (cloister runtime plan) ──────────────────────────────────────

test("orders plan: bind its exposed port, then connect to dolt — the live allow[]", async () => {
  const p = await plan(fixtureToml(), "orders");
  assert.deepEqual(p.confinement.unixSocket.allow, [
    { path: `${CH}/orders.grpc.sock`, mode: "bind", guestPort: 50051 },
    { path: `${CH}/dolt.mysql.sock`, guestPort: 3306 },
  ]);
  // The connect grant carries no `mode`: the host-runtime parser defaults it
  // to "" (connect), the narrow grant.
  assert.equal("mode" in p.confinement.unixSocket.allow[1], false);
});

test("two separately emitted plans join on one socket path, with no broker", async () => {
  const toml = fixtureToml();
  const dolt = (await plan(toml, "dolt")).confinement.unixSocket.allow;
  const orders = (await plan(toml, "orders")).confinement.unixSocket.allow;
  const bind = dolt.find((g) => g.mode === "bind" && g.guestPort === 3306);
  const connect = orders.find((g) => g.mode === undefined);
  assert.ok(bind && connect);
  assert.equal(connect.path, bind.path);
  assert.equal(connect.guestPort, bind.guestPort);
  assert.deepEqual(dolt, [{ path: `${CH}/dolt.mysql.sock`, mode: "bind", guestPort: 3306 }]);
});

// ── One fixture shared with the Rust parser (S5) ──────────────────────────
//
// test/fixtures/runtime-plan/*.plan.json are the emitter's exact output for
// this fixture. rs/crates/host-runtime/tests/emitted_plan_fixtures.rs loads
// the SAME files and runs LaunchPlan validation + carried_confinement, so a
// drift between the JS emitter and the Rust parser fails a test on one side.
// Regenerate with UPDATE_FIXTURES=1 after an intended change.

const FIXTURE_OPTS = {
  workspace: "/tmp/cloister-ws",
  env: "local",
  channelDir: CH,
};
for (const bundle of ["dolt", "orders"]) {
  test(`emitted ${bundle} plan equals test/fixtures/runtime-plan/${bundle}.plan.json byte for byte`, async () => {
    const p = await planFromToml(fixtureToml(), lock, {
      ...FIXTURE_OPTS,
      rootfsInCas: () => ({ present: true, casRoot: "/cas" }), guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
      bundle,
      controlSocket: `/tmp/cloister-host-runtime/${bundle}.sock`,
    });
    const json = `${JSON.stringify(p, null, 2)}\n`;
    const url = new URL(`../../test/fixtures/runtime-plan/${bundle}.plan.json`, import.meta.url);
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(url, json);
    assert.equal(json, readFileSync(url, "utf8"));
  });
}

test("grant order is deterministic: ports then connections, each in declaration order", async () => {
  const toml = fixtureToml({
    extraOrdersPorts: `
[[bundles.ports]]
name = "metrics"
port = 9090
appProtocol = "art.http"
expose = "none"

[[bundles.ports]]
name = "admin"
port = 9091
appProtocol = "art.http"
expose = "edge"
`,
  });
  const first = (await plan(toml, "orders")).confinement.unixSocket.allow;
  const second = (await plan(toml, "orders")).confinement.unixSocket.allow;
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((g) => g.path), [
    `${CH}/orders.grpc.sock`,
    `${CH}/orders.admin.sock`, // metrics is expose="none": no channel
    `${CH}/dolt.mysql.sock`,
  ]);
});

test("a bundle with no declarations emits no unixSocket key", async () => {
  const toml = fixtureToml({ connections: "" }).replaceAll(/\[\[bundles\.ports\]\][^[]*/g, "");
  const p = await plan(toml, "orders");
  assert.equal("unixSocket" in p.confinement, false);
});

test("--env with no matching target is refused, naming the connection and env", async () => {
  await assert.rejects(
    plan(fixtureToml(), "orders", { env: "gcp" }),
    /connection "orders-db" \(from "orders"\) declares no target for env "gcp"/,
  );
});

test("a guestPort presented twice in one plan is refused, with the no-auto-shift reason", async () => {
  const toml = fixtureToml({
    extraOrdersPorts: `
[[bundles.ports]]
name = "local-mysql"
port = 3306
appProtocol = "art.mysql"
expose = "cluster"
`,
  });
  await assert.rejects(plan(toml, "orders"), /guestPort 3306 is presented by two grants[\s\S]*no workload env/);
});

test("a socket path over 103 bytes is refused, naming it", async () => {
  const long = `/tmp/${"c".repeat(90)}`;
  await assert.rejects(plan(fixtureToml(), "orders", { channelDir: long }), /over the 103-byte macOS sun_path limit: \/tmp\/c+\/orders\.grpc\.sock/);
});

// ── Endpoint rules are build-time (S1 / N1) ──────────────────────────────

test("cluster:toml refuses an exposed port on a process bundle", async () => {
  await assert.rejects(
    parseTomlToCluster(fixtureToml({ ordersMode: "process", connections: "" })),
    /bundle "orders" exposes port "grpc" but has executionMode "process" and no placements; channels are lowered only for "microvm" bundles/,
  );
});

test("cluster:toml refuses a connection whose target is a process bundle", async () => {
  const toml = fixtureToml({ doltMode: "process" }).replace('expose = "cluster"', 'expose = "none"');
  // dolt's only port is now unexposed, so the target-port check fires first;
  // keep it exposed and the port check names dolt as an endpoint instead.
  await assert.rejects(parseTomlToCluster(fixtureToml({ doltMode: "process" })), /bundle "dolt" exposes port "mysql" but has executionMode "process"/);
  await assert.rejects(parseTomlToCluster(toml), /port "dolt.mysql" has expose "none"/);
});

test("cluster:toml refuses an outbound connection from a process bundle", async () => {
  const toml = fixtureToml({ ordersMode: "process" }).replace(
    'name = "grpc"\nport = 50051\nappProtocol = "art.grpc"\nexpose = "cluster"',
    'name = "grpc"\nport = 50051\nappProtocol = "art.grpc"\nexpose = "none"',
  );
  await assert.rejects(parseTomlToCluster(toml), /bundle "orders" is the from of connection "orders-db" but has executionMode "process"/);
});

const WORKERD_DIALLER = `
[[bundles]]
name = "edge-worker"
kind = "workerd"
tier = "cluster"

[bundles.workerd]
entryPoint = "src/bundles/edge/index.ts"
`;

test("ADR-0069 §3: a workerd bundle with an art.mysql connection is refused at cluster:toml", async () => {
  const toml = fixtureToml({
    connections: `${WORKERD_DIALLER}
[[connections]]
from = "edge-worker"
name = "db"
appProtocol = "art.mysql"

[[connections.targets]]
env = "local"
bundle = "dolt"
port = "mysql"
`,
  });
  await assert.rejects(
    parseTomlToCluster(toml),
    /bundle "edge-worker" is the from of connection "db" but is a workerd bundle; .*ADR-0069 §3 forbids a SQL-wire connection/,
  );
});

test("N1: a port with expose = \"none\" stays allowed on any bundle, workerd included", async () => {
  const toml = fixtureToml({
    connections: `${WORKERD_DIALLER}
[[bundles.ports]]
name = "metrics"
port = 9090
appProtocol = "art.http"
expose = "none"
`,
  });
  const c = await parseTomlToCluster(toml);
  assert.equal(c.bundles.find((b) => b.name === "edge-worker").ports[0].expose, "none");
});

test("the emitter keeps its process refusal as defense in depth", () => {
  const bundles = [{ name: "orders", kind: "external", executionMode: "process", ports: [{ name: "grpc", port: 50051, appProtocol: "art.grpc", expose: "cluster" }] }];
  assert.throws(
    () => lowerChannelGrants(bundles, [], { bundle: "orders", env: "local", channelDir: CH }),
    /executionMode is "process": confinement\/v1 §6 guestPort presentation is microVM-only \(LLO\)/,
  );
});

// ── runtime plan validates the whole file (S2) ───────────────────────────

const typos = [
  ["a typo'd port key (expsoe)", (t) => t.replace('expose = "cluster"', 'expsoe = "cluster"'), /cluster schema validation failed/],
  ["a duplicate bundle name", (t) => t.replace('name = "orders"', 'name = "dolt"'), /bundle name "dolt" is declared more than once/],
  ["a string port", (t) => t.replace("port = 3306", 'port = "3306"'), /cluster schema validation failed/],
  ["a misspelled [[connection]] table", (t) => t.replace("[[connections]]", "[[connection]]").replace("[[connections.targets]]", "[[connection.targets]]"), /cluster schema validation failed[\s\S]*connection/],
];
for (const [label, edit, pattern] of typos) {
  test(`runtime plan refuses ${label}, exactly as cluster:toml does`, async () => {
    const toml = edit(fixtureToml());
    await assert.rejects(parseTomlToCluster(toml), pattern);
    await assert.rejects(plan(toml, "orders"), pattern);
  });
}

// ── Hand-written §6 grants are refused (S2b) ─────────────────────────────

test("confinement.unixSocket written by hand is refused by cluster:toml and by runtime plan", async () => {
  const toml = fixtureToml().replace(
    '[bundles.external]\nentryPoint = "/usr/local/bin/orders"',
    '[bundles.confinement.unixSocket]\nallow = [{ path = "/tmp/x.sock", mode = "bind", guestPort = 1 }]\n\n[bundles.external]\nentryPoint = "/usr/local/bin/orders"',
  );
  const pattern = /bundle "orders" declares confinement.unixSocket by hand\. §6 grants are derived from \[\[bundles\.ports\]\] and \[\[connections\]\]/;
  await assert.rejects(parseTomlToCluster(toml), pattern);
  await assert.rejects(plan(toml, "orders"), pattern);
});

// ── Bundle names that hold a channel end are DNS labels (S3) ─────────────

for (const [bad, why] of [["Orders", /contains "O"/], ["orders_svc", /contains "_"/], ["-orders", /starts or ends with a hyphen/]]) {
  test(`a channel-endpoint bundle named ${JSON.stringify(bad)} is refused, saying why`, async () => {
    const toml = fixtureToml().replaceAll('"orders"', JSON.stringify(bad));
    await assert.rejects(
      parseTomlToCluster(toml),
      new RegExp(`bundle "${bad.replace("-", "\\-")}" exposes port "grpc", so its name must be a DNS label[\\s\\S]*case-insensitive filesystem[\\s\\S]*${why.source}`),
    );
  });
}

// ── Duplicate edges (N2) ─────────────────────────────────────────────────

test("two connections reaching the same (bundle, port) in one env are a duplicate edge", async () => {
  const second = `
[[connections]]
from = "orders"
name = "orders-db-2"
appProtocol = "art.mysql"

[[connections.targets]]
env = "local"
bundle = "dolt"
port = "mysql"
`;
  await assert.rejects(
    parseTomlToCluster(fixtureToml() + second),
    /connections "orders-db" and "orders-db-2" \(from "orders"\) both reach "dolt.mysql" in env "local" — a duplicate edge/,
  );
});

test("parsePlanArgs: --env and --channel-dir default, and --channel-dir must be canonical", () => {
  const base = ["orders", "--workspace", "/repo"];
  const opts = parsePlanArgs(base);
  assert.equal(opts.env, "local");
  assert.equal(opts.channelDir, CH);
  const set = parsePlanArgs([...base, "--env", "gcp", "--channel-dir", "/tmp/ch"]);
  assert.equal(set.env, "gcp");
  assert.equal(set.channelDir, "/tmp/ch");
  assert.throws(() => parsePlanArgs([...base, "--channel-dir", "rel/ch"]), /--channel-dir must be absolute/);
  assert.throws(() => parsePlanArgs([...base, "--channel-dir", "/tmp/../ch"]), /--channel-dir must be a canonical/);
});

test("N3: --channel-dir with a trailing slash is refused (the digest commits to the path string)", () => {
  assert.throws(
    () => parsePlanArgs(["orders", "--workspace", "/repo", "--channel-dir", "/tmp/ch/"]),
    /--channel-dir must be a canonical absolute path \(no trailing slash\)/,
  );
});

// ── Round-trip pruning (N4) ──────────────────────────────────────────────

test("N4: cluster-to-toml drops only empty scalars from port/connection rows, never nested values", () => {
  const text = clusterToToml({
    metadata: { name: "n4", version: "0.0.1" },
    bundles: [{
      name: "a", kind: { external: {} }, tier: "cluster",
      ports: [{ name: "p", port: 1, appProtocol: "", expose: "", future: { nested: ["x"] }, flag: false }],
    }],
    wires: [],
    connections: [{ from: "a", name: "c", appProtocol: "art.tcp", minStrength: "", targets: [{ env: "local", bundle: "b", port: "p", extra: { k: 1 } }] }],
  });
  const parsed = JSON.parse(JSON.stringify(parseToml(text))); // plain prototypes
  assert.deepEqual(parsed.bundles[0].ports[0], { flag: false, future: { nested: ["x"] }, name: "p", port: 1 });
  assert.deepEqual(parsed.connections[0], {
    appProtocol: "art.tcp", from: "a", name: "c",
    targets: [{ bundle: "b", env: "local", extra: { k: 1 }, port: "p" }],
  });
});
