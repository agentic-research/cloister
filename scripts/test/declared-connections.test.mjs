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
import { parse as parseToml } from "smol-toml";

import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../cli/lib/cluster/cluster-to-toml.mjs";
import { buildLaunchPlan, parsePlanArgs } from "../../cli/commands/runtime-plan.mjs";

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
      { oci: { identifier: `ghcr.io/example/${name}`, digest: `sha256:${"a".repeat(64)}` } },
    ]),
  ),
};

function plan(toml, bundle, extra = {}) {
  return buildLaunchPlan(parseToml(toml), lock, {
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

test("orders plan: bind its exposed port, then connect to dolt — the live allow[]", () => {
  const p = plan(fixtureToml(), "orders");
  assert.deepEqual(p.confinement.unixSocket.allow, [
    { path: `${CH}/orders.grpc.sock`, mode: "bind", guestPort: 50051 },
    { path: `${CH}/dolt.mysql.sock`, guestPort: 3306 },
  ]);
  // The connect grant carries no `mode`: the host-runtime parser defaults it
  // to "" (connect), the narrow grant.
  assert.equal("mode" in p.confinement.unixSocket.allow[1], false);
});

test("two separately emitted plans join on one socket path, with no broker", () => {
  const toml = fixtureToml();
  const dolt = plan(toml, "dolt").confinement.unixSocket.allow;
  const orders = plan(toml, "orders").confinement.unixSocket.allow;
  const bind = dolt.find((g) => g.mode === "bind" && g.guestPort === 3306);
  const connect = orders.find((g) => g.mode === undefined);
  assert.ok(bind && connect);
  assert.equal(connect.path, bind.path);
  assert.equal(connect.guestPort, bind.guestPort);
  assert.deepEqual(dolt, [{ path: `${CH}/dolt.mysql.sock`, mode: "bind", guestPort: 3306 }]);
});

test("grant order is deterministic: ports then connections, each in declaration order", () => {
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
  const first = plan(toml, "orders").confinement.unixSocket.allow;
  const second = plan(toml, "orders").confinement.unixSocket.allow;
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((g) => g.path), [
    `${CH}/orders.grpc.sock`,
    `${CH}/orders.admin.sock`, // metrics is expose="none": no channel
    `${CH}/dolt.mysql.sock`,
  ]);
});

test("a bundle with no declarations emits no unixSocket key (plans stay byte-identical)", () => {
  const toml = fixtureToml({ connections: "" }).replaceAll(/\[\[bundles\.ports\]\][^[]*/g, "");
  const p = plan(toml, "orders");
  assert.equal("unixSocket" in p.confinement, false);
});

test("--env with no matching target is refused, naming the connection and env", () => {
  assert.throws(
    () => plan(fixtureToml(), "orders", { env: "gcp" }),
    /connection "orders-db" \(from "orders"\) declares no target for env "gcp"/,
  );
});

test("a guestPort presented twice in one plan is refused, with the no-auto-shift reason", () => {
  const toml = fixtureToml({
    extraOrdersPorts: `
[[bundles.ports]]
name = "local-mysql"
port = 3306
appProtocol = "art.mysql"
expose = "cluster"
`,
  });
  assert.throws(() => plan(toml, "orders"), /guestPort 3306 is presented by two grants[\s\S]*no workload env/);
});

test("a socket path over 103 bytes is refused, naming it", () => {
  const long = `/tmp/${"c".repeat(90)}`;
  assert.throws(() => plan(fixtureToml(), "orders", { channelDir: long }), /over the 103-byte macOS sun_path limit: \/tmp\/c+\/orders\.grpc\.sock/);
});

test("a process bundle with declared ports or connections is refused: guestPort is microVM-only", () => {
  assert.throws(
    () => plan(fixtureToml({ ordersMode: "process" }), "orders"),
    /executionMode is "process": confinement\/v1 §6 guestPort presentation is microVM-only \(LLO\)/,
  );
});

test("a connection whose target is not a microvm bundle is refused", () => {
  assert.throws(
    () => plan(fixtureToml({ doltMode: "process" }), "orders"),
    /target bundle "dolt" is not a microvm bundle/,
  );
});

test("the emitter applies the build-time checks to the raw cluster.toml it reads", () => {
  const toml = fixtureToml().replace('appProtocol = "art.mysql"\n\n[[connections.targets]]', 'appProtocol = "art.grpc"\n\n[[connections.targets]]');
  assert.throws(() => plan(toml, "orders"), /does not match port "dolt.mysql"/);
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
