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
const containerOf = (yaml) => objectsOf(yaml).find((o) => o.spec?.template).spec.template.spec.containers[0];

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
    await assert.rejects(lowerDir({ root: dir, env: "prod" }), /no bundle is placed "kubernetes" or "knative" for env "prod"/);
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

// ── Ports per placement, and the Knative emitter (ADR-0074 §7) ───────────────

// The same bundles, placed on Knative: a Knative Service is dialled on 80
// whatever its container listens on, so the placement row says so.
const KNATIVE = HAND
  .replace('[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "orders.yaml"', '[[bundles.ports]]\nname = "http"\nport = 9090\nappProtocol = "art.http"\nexpose = "cluster"\n\n[[bundles.placements]]\nenv = "local"\nkind = "knative"\nmanifest = "orders.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nport = 80')
  .replace('[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "payments.yaml"', '[[bundles.placements]]\nenv = "local"\nkind = "knative"\nmanifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nport = 80')
  .replace('minStrength = "policy"\n', "")
  // The job is left out: it is a Kubernetes Job, and its edge would cross placements.
  .replace(/\[\[bundles\]\]\nname = "nightly"[\s\S]*?manifest = "jobs\/nightly.yaml"\n/, "")
  .replace(/\[\[connections\]\]\nfrom = "nightly"[\s\S]*$/, "");

test("the same bundle lowers to a Knative Service: dialled on 80, listening on its own port", async () => {
  await inDir(KNATIVE, async (dir) => {
    const { written } = await lowerDir({ root: dir, env: "local" });
    assert.deepEqual(written, ["orders.yaml", "payments.yaml"]);
    const [payments] = objectsOf(readFileSync(join(dir, "payments.yaml"), "utf8"));
    assert.deepEqual([payments.apiVersion, payments.kind, payments.metadata.namespace], ["serving.knative.dev/v1", "Service", "payments"]);
    // expose = "cluster" is Knative's own label for no route from outside.
    assert.equal(payments.metadata.labels["networking.knative.dev/visibility"], "cluster-local");
    assert.deepEqual(payments.spec.template.spec.containers[0].ports, [{ name: "http1", containerPort: 8080 }]);
    // The address is the dialled one: port 80, which http implies.
    assert.deepEqual(containerOf(readFileSync(join(dir, "orders.yaml"), "utf8")).env[0], { name: "PAYMENTS_URL", value: "http://payments.payments.svc.cluster.local/v1" });
    assert.match(readFileSync(join(dir, "payments.yaml"), "utf8"), /# Peers dial it on port 80; its container listens on 8080\.\n# It has no route from outside the cluster \(networking\.knative\.dev\/visibility: cluster-local\)\.\n# Inside the cluster nothing enforces which caller may reach it/);
    // And the existing Knative check accepts it, tying the address to its connection.
    const checked = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(checked.files, []);
    assert.deepEqual(checked.checked.map((k) => [k.bundle, k.port, k.wire]), [["orders", 80, "http1"], ["payments", 80, "http1"]]);
    assert.deepEqual(checked.references.map((r) => [r.bundle, r.to, r.connections]), [["orders", "payments", ["payments"]]]);
  });
});

test("on Kubernetes a dialled port becomes the Service port, and the bundle's port the targetPort", async () => {
  const mapped = HAND.replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nport = 80');
  await inDir(mapped, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const objects = objectsOf(readFileSync(join(dir, "payments.yaml"), "utf8"));
    assert.deepEqual(objects[1].spec.ports, [{ name: "http", port: 80, targetPort: 8080, appProtocol: "art.http" }]);
    assert.deepEqual(objects[0].spec.template.spec.containers[0].ports, [{ name: "http", containerPort: 8080 }]);
    assert.equal(containerOf(readFileSync(join(dir, "orders.yaml"), "utf8")).env[0].value, "http://payments.payments.svc.cluster.local/v1");
    const written = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(written.references.map((r) => [r.bundle, r.to]), [["orders", "payments"], ["nightly", "payments"]]);
    // The NetworkPolicy admits the pod-side port, which is the targetPort.
    assert.match(readFileSync(join(dir, "k8s/payments/20-networkpolicy.yaml"), "utf8"), /port: 8080/);
  });
});

const portRefusals = [
  ["a dialled port on a constructed placement", (t) => t.replace('kind = "kubernetes"\nmanifest = "payments.yaml"', 'kind = "workerd"\n\n[[bundles.placements.ports]]\nname = "http"\nport = 80').replace(/\[\[connections\]\][\s\S]*$/, "").replace(/\[\[bundles.external.env\]\]\nname = "(PAYMENTS_URL|TARGET)"\nconnection = "payments"\n(path = "\/v1"\n)?/g, ""),
    /bundle "payments" placement env "local": kind "workerd" takes no ports rows/],
  ["a dialled port for a port the bundle does not have", (t) => t.replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "grpc"\nport = 80'),
    /ports row names "grpc", which is not a port of bundle "payments" \(it declares: http\)/],
  ["a dialled port that is not a port number", (t) => t.replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nport = 0'),
    /ports row for "http" sets neither port nor expose, so it says nothing/],
  ["the same port dialled twice", (t) => t.replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nport = 80\n\n[[bundles.placements.ports]]\nname = "http"\nport = 81'),
    /ports row for "http" appears more than once/],
];
for (const [label, edit, pattern] of portRefusals) {
  test(`cluster.toml refuses by name: ${label}`, async () => {
    await assert.rejects(parseTomlToCluster(edit(HAND)), pattern);
  });
}

test("Knative lowering refuses what a Knative Service cannot be, and writes nothing when one bundle fails", async () => {
  // A job, placed knative by hand.
  const job = KNATIVE + '\n[[bundles]]\nname = "nightly"\nkind = "external"\ntier = "cluster"\n\n[bundles.external]\nimage = "example.com/nightly:1"\nruns = "job"\n\n[[bundles.placements]]\nenv = "local"\nkind = "knative"\nmanifest = "nightly.yaml"\n';
  await inDir(job, async (dir) => {
    await assert.rejects(lowerDir({ root: dir, env: "local" }), /bundle "nightly" runs = "job", and a Knative Service runs to serve requests/);
    // orders and payments come first and are fine, but nothing is half-written.
    assert.deepEqual(readdirSync(dir), ["cluster.toml"]);
  });
  await inDir(KNATIVE.replace('[[bundles.placements.ports]]\nname = "http"\nport = 80\n\n[[bundles]]\nname = "payments"', '[[bundles]]\nname = "payments"'), async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    // Lowered as declared; the existing check then says what is missing.
    await assert.rejects(emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") }), /port "http" is dialled on 9090 in cluster\.toml, but a Knative Service is reached on port 80.*Add a \[\[bundles\.placements\.ports\]\] row/);
  });
});

test("a draft placed on Knative sets each port's dialled number, and keeps a job on Kubernetes", async () => {
  const PLAN = fileURLToPath(new URL("../../../test/fixtures/terraform/google-plan.show.json", import.meta.url));
  const draft = draftCluster(importFacts(JSON.parse(readFileSync(PLAN, "utf8"))), { env: "prod", local: "local", localKind: "knative" });
  const cluster = await parseTomlToCluster(draft.toml);
  const local = (name) => cluster.bundles.find((b) => b.name === name).placements.find((p) => p.env === "local");
  assert.deepEqual([local("reconciler").kind, local("reconciler").ports], ["knative", [{ name: "h2c", port: 80, expose: "" }]]);
  assert.deepEqual([local("sweep").kind, local("sweep").ports], ["kubernetes", []]);
  assert.ok(draft.notes.some((n) => n === '"sweep": runs to completion, so it is placed "kubernetes" for "local", not "knative"'));
  assert.throws(() => draftCluster(importFacts(JSON.parse(readFileSync(PLAN, "utf8"))), { env: "prod", local: "local", localKind: "nomad" }), /--local-kind "nomad" is not one of kubernetes, knative/);
});

test("a plan with services and a job lowers whole to Knative: the job is a Kubernetes Job that calls a Knative Service", async () => {
  const PLAN = fileURLToPath(new URL("../../../test/fixtures/terraform/google-plan.show.json", import.meta.url));
  const draft = draftCluster(importFacts(JSON.parse(readFileSync(PLAN, "utf8"))), { env: "prod", local: "local", localKind: "knative" });
  await inDir(draft.toml, async (dir) => {
    const { written } = await lowerDir({ root: dir, env: "local" });
    assert.deepEqual(written, ["reconciler.yaml", "workqueue.yaml", "sweep.yaml"]);
    assert.deepEqual(objectsOf(readFileSync(join(dir, "sweep.yaml"), "utf8")).map((o) => o.kind), ["Job"]);
    // The job dials the Knative Service where a peer dials it: port 80.
    assert.deepEqual(containerOf(readFileSync(join(dir, "sweep.yaml"), "utf8")).env, [{ name: "TARGET", value: "http://reconciler.reconciler.svc.cluster.local" }]);
    const checked = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(checked.references.map((r) => [r.bundle, r.to]).sort(), [["sweep", "reconciler"], ["workqueue", "reconciler"]]);
    assert.deepEqual(checked.unreferenced, []);
  });
});

test("a Knative bundle exposed at the edge is lowered with a route from outside, and says so", async () => {
  const edge = KNATIVE.replace('expose = "cluster"\n\n[[bundles.placements]]\nenv = "local"\nkind = "knative"\nmanifest = "payments.yaml"', 'expose = "edge"\n\n[[bundles.placements]]\nenv = "local"\nkind = "knative"\nmanifest = "payments.yaml"');
  assert.notEqual(edge, KNATIVE);
  await inDir(edge, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const text = readFileSync(join(dir, "payments.yaml"), "utf8");
    assert.equal(objectsOf(text)[0].metadata.labels["networking.knative.dev/visibility"], undefined);
    assert.match(text, /# It has a route from outside the cluster \(expose = "edge"\)\./);
    await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
  });
});

// The input of the kind smoke (dev/lowered-kind.sh, its own CI job). That job
// needs a cluster and so does not run in `task lint`; this keeps its input
// from rotting where a cluster-less gate can see it.
test("the kind smoke's cluster.toml lowers and passes cluster k8s, with the graph the smoke observes", async () => {
  const input = readFileSync(fileURLToPath(new URL("../../../test/e2e/lowered-kind/cluster.toml", import.meta.url)), "utf8");
  await inDir(input, async (dir) => {
    const { written } = await lowerDir({ root: dir, env: "local" });
    assert.deepEqual(written, ["server.yaml", "caller.yaml", "probe.yaml", "stranger.yaml"]);
    const checked = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    // caller by an env binding, probe by a literal address in an argument.
    assert.deepEqual(checked.references.map((r) => [r.bundle, r.where, r.to]), [["caller", "env SERVER_URL", "server"], ["probe", "args", "server"]]);
    // The smoke's two claims, as policy: caller and probe are admitted, and stranger is not.
    const policy = readFileSync(join(dir, "k8s/server/20-networkpolicy.yaml"), "utf8");
    assert.deepEqual([...policy.matchAll(/kubernetes\.io\/metadata\.name: (\S+)/g)].map((m) => m[1]), ["caller", "probe"]);
    assert.ok(!policy.includes("stranger"));
    // The smoke reads the caller's address back from this field.
    assert.equal(containerOf(readFileSync(join(dir, "caller.yaml"), "utf8")).env[0].value, "http://server.server.svc.cluster.local:8080");
    // And the script names the same bundles this file declares.
    const script = readFileSync(fileURLToPath(new URL("../../../dev/lowered-kind.sh", import.meta.url)), "utf8");
    for (const bundle of ["server", "caller", "stranger", "probe"]) assert.ok(script.includes(bundle), `dev/lowered-kind.sh does not mention "${bundle}"`);
  });
});

// ── expose per placement (ADR-0074 §7) ───────────────────────────────────────

const OPEN_PLAN = () => {
  const doc = JSON.parse(readFileSync(fileURLToPath(new URL("../../../test/fixtures/terraform/google-plan.show.json", import.meta.url)), "utf8"));
  // Cloud Run's default: reachable from outside.
  for (const r of doc.planned_values.root_module.resources) if (r.type === "google_cloud_run_v2_service") r.values.ingress = "INGRESS_TRAFFIC_ALL";
  return doc;
};

test("a service that is public in the plan is drafted edge there and cluster on the second cluster, and lowers", async () => {
  const draft = draftCluster(importFacts(OPEN_PLAN()), { env: "prod", local: "local" });
  const cluster = await parseTomlToCluster(draft.toml);
  const reconciler = cluster.bundles.find((b) => b.name === "reconciler");
  assert.equal(reconciler.ports[0].expose, "edge");
  assert.deepEqual(reconciler.placements.find((p) => p.env === "local").ports, [{ name: "h2c", port: 0, expose: "cluster" }]);
  assert.ok(draft.notes.some((n) => /"reconciler": its ingress is INGRESS_TRAFFIC_ALL.*For "local" it is drafted expose = "cluster": internal there$/.test(n)), draft.notes.join("\n"));
  // The whole flow, which an edge port on kubernetes would have stopped.
  await inDir(draft.toml, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const written = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    assert.deepEqual(written.unreferenced, []);
    assert.ok(written.files.includes("reconciler/20-networkpolicy.yaml"));
  });
});

test("without the placement row, an edge port on kubernetes is still refused, and says what to add", async () => {
  const draft = draftCluster(importFacts(OPEN_PLAN()), { env: "prod", local: "local" });
  const bare = draft.toml.replaceAll('\n[[bundles.placements.ports]]\nname = "h2c"\nexpose = "cluster"\n', "\n").replaceAll('\n[[bundles.placements.ports]]\nname = "http1"\nexpose = "cluster"\n', "\n");
  assert.notEqual(bare, draft.toml);
  await inDir(bare, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    await assert.rejects(emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") }), /has expose = "edge", which `cluster k8s` does\s+not lower yet/);
  });
});

test("on Knative the placement's expose decides the visibility label", async () => {
  const draft = draftCluster(importFacts(OPEN_PLAN()), { env: "prod", local: "local", localKind: "knative" });
  await inDir(draft.toml, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const [service] = objectsOf(readFileSync(join(dir, "reconciler.yaml"), "utf8"));
    // Public in the plan, internal here: the label that keeps it off outside routes.
    assert.equal(service.metadata.labels["networking.knative.dev/visibility"], "cluster-local");
    await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
  });
});

const exposeRefusals = [
  ["a placement expose that is not one", 'expose = "public"', /port "http" expose "public" is not one of cluster, edge/],
  ["a placement expose of none", 'expose = "none"', /port "http" expose "none" is not one of cluster, edge/],
];
for (const [label, row, pattern] of exposeRefusals) {
  test(`cluster.toml refuses by name: ${label}`, async () => {
    await assert.rejects(parseTomlToCluster(HAND.replace('manifest = "payments.yaml"', `manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\n${row}`)), pattern);
  });
}

test("a placement cannot open a port the bundle keeps to itself, and the fields a row does not set are not written", async () => {
  const closed = HAND.replace('expose = "cluster"', 'expose = "none"').replace(/\[\[connections\]\][\s\S]*$/, "").replace(/\[\[bundles.external.env\]\]\nname = "(PAYMENTS_URL|TARGET)"\nconnection = "payments"\n(path = "\/v1"\n)?/g, "")
    .replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nexpose = "edge"');
  await assert.rejects(parseTomlToCluster(closed), /port "http" has expose = "none" on the bundle, so no placement can open it/);
  const both = HAND.replace('manifest = "payments.yaml"', 'manifest = "payments.yaml"\n\n[[bundles.placements.ports]]\nname = "http"\nexpose = "edge"');
  const canonical = clusterToToml(await parseTomlToCluster(both));
  assert.match(canonical, /\[\[bundles\.placements\.ports\]\]\nexpose = "edge"\nname = "http"\n/);
  assert.ok(!/\nport = 0\n/.test(canonical));
});
