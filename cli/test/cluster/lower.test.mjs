// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister cluster lower`: a bundle, as cluster.toml declares it, lowered to
// the workload of one placement (ADR-0074 §7). cluster.toml is the only
// input: the same emitter serves a hand-written file and a drafted one.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

import { emitK8sDir, lowerDir, main as clusterMain } from "../../commands/cluster.mjs";
import { lowerEnvironment } from "../../commands/runtime-plan.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../lib/cluster/cluster-to-toml.mjs";
import { draftCluster } from "../../lib/facts/draft.mjs";
import { importFacts } from "../../lib/facts/import.mjs";

// Written by hand: no plan is involved in lowering.
const HAND = `
[metadata]
name = "shop"
version = "0.1.0"

[storage]

[[bundles]]
name = "orders"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/orders:1"
entryPoint = "/bin/orders"
args = ["serve"]

[[bundles.external.env]]
name = "PAYMENTS_URL"
connection = "payments"
path = "/v1"

[[bundles.external.env]]
name = "LOG_LEVEL"
value = "debug"

[[bundles.external.env]]
name = "DB_PASSWORD"
secret = "orders-db"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "orders.yaml"

[[bundles]]
name = "payments"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/payments:1"

[[bundles.ports]]
name = "http"
port = 8080
appProtocol = "art.http"
expose = "cluster"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "payments.yaml"

[[bundles]]
name = "nightly"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/nightly:1"
runs = "job"

[[bundles.external.env]]
name = "TARGET"
connection = "payments"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "jobs/nightly.yaml"

[[connections]]
from = "orders"
name = "payments"
appProtocol = "art.http"
minStrength = "policy"

[[connections.targets]]
env = "local"
bundle = "payments"
port = "http"

[[connections]]
from = "nightly"
name = "payments"
appProtocol = "art.http"

[[connections.targets]]
env = "local"
bundle = "payments"
port = "http"
`;

const objectsOf = (yaml) => parseAllDocuments(yaml).map((d) => d.toJS());
const containerOf = (yaml) => objectsOf(yaml).find((o) => o.kind !== "Service").spec.template.spec.containers[0];

function inDir(toml, run) {
  const dir = mkdtempSync(join(tmpdir(), "cluster-lower-"));
  writeFileSync(join(dir, "cluster.toml"), toml);
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a hand-written bundle is lowered: Deployment and Service, or a Job, at the path its placement names", async () => {
  await inDir(HAND, async (dir) => {
    const { written, kept } = await lowerDir({ root: dir, env: "local" });
    assert.deepEqual([written, kept], [["orders.yaml", "payments.yaml", "jobs/nightly.yaml"], []]);
    assert.deepEqual(objectsOf(readFileSync(join(dir, "payments.yaml"), "utf8")).map((o) => o.kind), ["Deployment", "Service"]);
    // orders exposes no port, so it has no Service; nightly runs to completion.
    assert.deepEqual(objectsOf(readFileSync(join(dir, "orders.yaml"), "utf8")).map((o) => o.kind), ["Deployment"]);
    assert.deepEqual(objectsOf(readFileSync(join(dir, "jobs/nightly.yaml"), "utf8")).map((o) => o.kind), ["Job"]);
    const service = objectsOf(readFileSync(join(dir, "payments.yaml"), "utf8"))[1];
    assert.deepEqual(service.spec.ports, [{ name: "http", port: 8080, targetPort: 8080, appProtocol: "art.http" }]);
  });
});

test("an env row is written by what it is: a literal, an address for this placement, a secret reference", async () => {
  await inDir(HAND, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const orders = readFileSync(join(dir, "orders.yaml"), "utf8");
    assert.deepEqual(containerOf(orders), {
      name: "orders",
      image: "example.com/orders:1",
      command: ["/bin/orders"],
      args: ["serve"],
      env: [
        { name: "PAYMENTS_URL", value: "http://payments.payments.svc.cluster.local:8080/v1" },
        { name: "LOG_LEVEL", value: "debug" },
        { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "orders-db", key: "latest" } } },
      ],
    });
    assert.match(orders, /# Written for this placement:\n# {3}- env PAYMENTS_URL: the address of connection "payments", with "\/v1" appended\n/);
    assert.match(orders, /# For you to provide:\n# {3}- env DB_PASSWORD: create Secret "orders-db" with key "latest" in namespace "orders"/);
    assert.match(readFileSync(join(dir, "payments.yaml"), "utf8"), /admits only its declared callers: orders, nightly\./);
  });
});

test("what lower writes is accepted by cluster k8s, which ties each written address to its connection", async () => {
  await inDir(HAND, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const written = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(written.references.map((r) => [r.bundle, r.where, r.to, r.connections]), [
      ["orders", "env PAYMENTS_URL", "payments", ["payments"]],
      ["nightly", "env TARGET", "payments", ["payments"]],
    ]);
    assert.deepEqual(written.unreferenced, []);
    assert.ok(written.files.includes("payments/20-networkpolicy.yaml"));
  });
});

test("a manifest that exists is never overwritten", async () => {
  await inDir(HAND, async (dir) => {
    writeFileSync(join(dir, "orders.yaml"), "# mine\n");
    const { written, kept } = await lowerDir({ root: dir, env: "local" });
    assert.deepEqual([written, kept], [["payments.yaml", "jobs/nightly.yaml"], ["orders.yaml"]]);
    assert.equal(readFileSync(join(dir, "orders.yaml"), "utf8"), "# mine\n");
    // Running again writes nothing.
    assert.deepEqual((await lowerDir({ root: dir, env: "local" })).written, []);
  });
});

const refusals = [
  ["an env row with a value and a connection", (t) => t.replace('name = "PAYMENTS_URL"\n', 'name = "PAYMENTS_URL"\nvalue = "x"\n'),
    /bundle "orders" env "PAYMENTS_URL" sets value and connection: a variable's value comes from exactly one of value, connection or secret/],
  ["a binding to a connection the bundle does not declare", (t) => t.replace('connection = "payments"\npath', 'connection = "ledger"\npath'),
    /bundle "orders" env "PAYMENTS_URL" is bound to connection "ledger", but bundle "orders" declares no connection of that name \(it declares: payments\)/],
  ["a path without a connection", (t) => t.replace('name = "LOG_LEVEL"\n', 'name = "LOG_LEVEL"\npath = "/x"\n'),
    /bundle "orders" env "LOG_LEVEL" sets path without connection/],
  ["a secretKey without a secret", (t) => t.replace('name = "LOG_LEVEL"\n', 'name = "LOG_LEVEL"\nsecretKey = "k"\n'),
    /bundle "orders" env "LOG_LEVEL" sets secretKey without secret/],
  ["a run mode that is not one", (t) => t.replace('runs = "job"', 'runs = "cron"'), /bundle "nightly": runs "cron" is not one of service, job/],
  ["a job that exposes a port", (t) => t.replace('image = "example.com/payments:1"', 'image = "example.com/payments:1"\nruns = "job"'),
    /bundle "payments" runs = "job" but exposes port "http": a job runs to completion/],
  ["a non-string connection", (t) => t.replace('connection = "payments"\npath', 'connection = 1\npath'), /env "PAYMENTS_URL": connection must be a string/],
];
for (const [label, edit, pattern] of refusals) {
  test(`cluster.toml refuses by name: ${label}`, async () => {
    await assert.rejects(parseTomlToCluster(edit(HAND)), pattern);
  });
}

test("the new fields survive the canonical round trip, and unused ones are not written", async () => {
  const cluster = await parseTomlToCluster(HAND);
  const canonical = clusterToToml(cluster);
  assert.deepEqual(await parseTomlToCluster(canonical), cluster);
  assert.match(canonical, /connection = "payments"\nname = "PAYMENTS_URL"\npath = "\/v1"\n/);
  assert.match(canonical, /name = "LOG_LEVEL"\nvalue = "debug"\n/);
  assert.ok(!/(connection|path|secret|secretKey|runs) = ""/.test(canonical), canonical);
  assert.match(canonical, /runs = "job"/);
});

test("lowering refuses what it cannot write, by name", async () => {
  // An address across placements: payments is not on Kubernetes in this env.
  const split = HAND.replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements]]\nenv = "edge"\nkind = "cloudRun"')
    .replace('[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "orders.yaml"', '[[bundles.placements]]\nenv = "edge"\nkind = "kubernetes"\nmanifest = "orders.yaml"')
    .replace('minStrength = "policy"\n\n[[connections.targets]]\nenv = "local"', '\n[[connections.targets]]\nenv = "edge"');
  await inDir(split, async (dir) => {
    await assert.rejects(lowerDir({ root: dir, env: "edge" }), /bundle "orders" env "PAYMENTS_URL": connection "payments" reaches "payments", which is placed "cloudRun" for env "edge"/);
  });
  await inDir(HAND.replace('secret = "orders-db"', 'secret = "Orders_DB"'), async (dir) => {
    await assert.rejects(lowerDir({ root: dir, env: "local" }), /secret "Orders_DB" key "latest" cannot name a Kubernetes Secret and key/);
  });
  await inDir(HAND, async (dir) => {
    await assert.rejects(lowerDir({ root: dir, env: "prod" }), /no bundle is placed "kubernetes" for env "prod"/);
  });
});

test("a microVM plan refuses a binding it does not lower, and never starts without the variable", () => {
  assert.throws(
    () => lowerEnvironment("orders", [{ name: "LOG_LEVEL", value: "debug" }, { name: "DB_PASSWORD", value: "", secret: "orders-db" }]),
    /bundle "orders" environment variable "DB_PASSWORD" is bound to secret "orders-db"; `runtime plan` does not lower a secret binding for a microVM yet/,
  );
  assert.throws(
    () => lowerEnvironment("orders", [{ name: "PAYMENTS_URL", value: "", connection: "payments" }]),
    /is bound to connection "payments"; `runtime plan` does not lower a connection binding for a microVM yet/,
  );
  // A literal row, with the new fields empty as the parser leaves them, is unchanged.
  assert.deepEqual(lowerEnvironment("orders", [{ name: "A", value: "1", connection: "", path: "", secret: "", secretKey: "" }]), [{ name: "A", value: "1" }]);
});

test("plan to running manifests in three commands, on the plan the real tool wrote", async () => {
  const PLAN = fileURLToPath(new URL("../../../test/fixtures/terraform/google-plan.show.json", import.meta.url));
  const draft = draftCluster(importFacts(JSON.parse(readFileSync(PLAN, "utf8"))), { env: "prod", local: "local", name: "fixture" });
  await inDir(draft.toml, async (dir) => {
    const lines = [];
    const code = await clusterMain(["lower", "--dir", dir, "--env", "local"], { log: (l) => lines.push(l), errLog: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(readdirSync(dir).sort(), ["cluster.toml", "reconciler.yaml", "sweep.yaml", "workqueue.yaml"]);
    assert.deepEqual(containerOf(readFileSync(join(dir, "workqueue.yaml"), "utf8")).env, [
      { name: "RECONCILER_URL", value: "http://reconciler.reconciler.svc.cluster.local:8080" },
      { name: "LOG_LEVEL", value: "info" },
      { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db-password", key: "latest" } } },
    ]);
    const written = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(written.references.map((r) => [r.bundle, r.to]), [["workqueue", "reconciler"], ["sweep", "reconciler"]]);
    for (const file of readdirSync(dir, { recursive: true })) {
      if (String(file).endsWith(".yaml") || String(file).endsWith(".toml")) assert.ok(!readFileSync(join(dir, String(file)), "utf8").includes("FIXTURE-SENSITIVE-VALUE"), String(file));
    }
  });
});
