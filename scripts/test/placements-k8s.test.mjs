// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Placements, the channel-strength rail, and the forwarded kubernetes
// lowering (ADR-0070 §2–4), cloister-991e65.
//
// Run with:
//   node --import tsx --test scripts/test/placements-k8s.test.mjs
//
// The fixture is the kind demo at tools/dolt-grpc-demo/k8s/: two bundles
// forwarded to kubernetes for env "local", joined by `orders-db`.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

import { parseTomlToCluster, checkableBundle } from "../../cli/lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../cli/lib/cluster/cluster-to-toml.mjs";
import { emitK8s, KNATIVE_WIRES, lowerK8s } from "../../cli/lib/cluster/emit-k8s.mjs";
import { BLESSED_LABELS } from "../../cli/lib/app-protocol.mjs";
import { meetStrength, strengthOf } from "../../cli/lib/cluster/connections.mjs";
import { emitK8sDir, main as clusterMain } from "../../cli/commands/cluster.mjs";
import { planFromToml } from "../../cli/commands/runtime-plan.mjs";
import { tableAdmits } from "./fixtures/platform-admits-table.mjs";

const ADMITS = tableAdmits({
  "linux/arm64": { admitted: ["linux/arm64", "linux/arm64/v8"], overlapping: ["linux/arm64", "linux/arm64/v8"] },
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = resolve(ROOT, "tools/dolt-grpc-demo/k8s");
const DEMO_TOML = readFileSync(join(DEMO, "cluster.toml"), "utf8");
const MANIFESTS = {
  "dolt.yaml": readFileSync(join(DEMO, "dolt.yaml"), "utf8"),
  "orders.yaml": readFileSync(join(DEMO, "orders.yaml"), "utf8"),
};

async function emit(toml = DEMO_TOML, manifests = MANIFESTS, env = "local") {
  const cluster = await parseTomlToCluster(toml);
  return emitK8s({
    bundles: cluster.bundles.map(checkableBundle),
    connections: cluster.connections,
    env,
    readManifest: (p) => {
      if (!(p in manifests)) throw new Error(`fixture has no ${p}`);
      return manifests[p];
    },
  });
}

function docs(text) {
  return parseAllDocuments(text).map((d) => d.toJS()).filter(Boolean);
}

/** Rewrite one bundle's placement row in the demo TOML. */
function placeAs(toml, manifest, replacement) {
  const row = `[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "${manifest}"\n`;
  assert.ok(toml.includes(row), `fixture lost its ${manifest} placement row`);
  return toml.replace(row, replacement);
}

const MICROVM = () => `[[bundles.placements]]\nenv = "local"\nkind = "microvm"\n`;

/** Make a bundle a microVM bundle (executionMode + entryPoint) in the demo TOML. */
function asMicrovm(toml, bundle, image) {
  return toml.replace(
    `[bundles.external]\nimage = "${image}"\n`,
    `[bundles.external]\nimage = "${image}"\nentryPoint = "/bin/${bundle}"\nexecutionMode = "microvm"\n`,
  );
}

const DOLT_IMAGE = "dolthub/dolt-sql-server:1.86.1@sha256:d492a79d22bc4bca51aa054293af95734a93ae005c22c80751148814379c8242";

// ── Strength rail (ADR-0070 §3) ──────────────────────────────────────────

test("strengthOf: microvm = capability, kubernetes = policy, everything else = none", () => {
  assert.equal(strengthOf("microvm"), "capability");
  assert.equal(strengthOf("kubernetes"), "policy");
  for (const k of ["workerd", "cloudRun", "", "anything"]) assert.equal(strengthOf(k), "none");
});

test("meetStrength is the weaker of the two ends", () => {
  assert.equal(meetStrength("capability", "capability"), "capability");
  assert.equal(meetStrength("capability", "policy"), "policy");
  assert.equal(meetStrength("policy", "none"), "none");
});

test("the demo (kubernetes ↔ kubernetes, minStrength policy) builds", async () => {
  const c = await parseTomlToCluster(DEMO_TOML);
  assert.equal(c.connections[0].minStrength, "policy");
  assert.deepEqual(c.bundles[0].placements, [{ env: "local", kind: "kubernetes", manifest: "dolt.yaml" }]);
});

test("kubernetes ↔ kubernetes does not meet minStrength capability, naming both placements", async () => {
  await assert.rejects(
    parseTomlToCluster(DEMO_TOML.replace('minStrength = "policy"', 'minStrength = "capability"')),
    /connection "orders-db" \(from "orders"\) env "local": minStrength "capability" is not met — "orders" is placed "kubernetes" and "dolt" is placed "kubernetes", so the edge's strength is "policy"/,
  );
});

function microvmBoth(minStrength) {
  let t = asMicrovm(DEMO_TOML, "dolt", DOLT_IMAGE);
  t = asMicrovm(t, "orders", "dolt-grpc-demo:dev");
  t = placeAs(t, "dolt.yaml", MICROVM());
  t = placeAs(t, "orders.yaml", MICROVM());
  return t.replace('minStrength = "policy"', `minStrength = "${minStrength}"`);
}

test("microvm ↔ microvm meets minStrength capability", async () => {
  const c = await parseTomlToCluster(microvmBoth("capability"));
  assert.equal(c.connections[0].minStrength, "capability");
});

test("microvm ↔ kubernetes does not meet capability (the meet is policy)", async () => {
  let t = asMicrovm(DEMO_TOML, "orders", "dolt-grpc-demo:dev");
  t = placeAs(t, "orders.yaml", MICROVM());
  t = t.replace('minStrength = "policy"', 'minStrength = "capability"');
  await assert.rejects(
    parseTomlToCluster(t),
    /"orders" is placed "microvm" and "dolt" is placed "kubernetes", so the edge's strength is "policy" \(the meet of capability and policy\)/,
  );
  // At "policy" the same cross-tier edge is legal in the graph…
  await parseTomlToCluster(t.replace('minStrength = "capability"', 'minStrength = "policy"'));
});

test("an unknown minStrength is refused", async () => {
  await assert.rejects(
    parseTomlToCluster(DEMO_TOML.replace('minStrength = "policy"', 'minStrength = "strong"')),
    /minStrength "strong" is not one of none, policy, capability/,
  );
});

// ── Placement checks ─────────────────────────────────────────────────────

const placementRefusals = [
  ["duplicate env",
    (t) => placeAs(t, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "dolt.yaml"\n\n[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "dolt.yaml"\n`),
    /bundle "dolt" declares a placement for env "local" more than once/],
  ["unknown kind",
    (t) => placeAs(t, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "nomad"\n`),
    /kind "nomad" is not one of microvm, workerd, kubernetes, knative, cloudRun/],
  ["microvm without executionMode microvm",
    (t) => placeAs(t, "dolt.yaml", MICROVM()),
    /kind "microvm" requires executionMode = "microvm" \(the bundle declares ""\) — the two must agree/],
  ["kubernetes without a manifest",
    (t) => placeAs(t, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\n`),
    /kind "kubernetes" requires a manifest/],
  ["a manifest on a constructed kind",
    (t) => placeAs(asMicrovm(t, "dolt", DOLT_IMAGE), "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "microvm"\nmanifest = "dolt.yaml"\n`),
    /kind "microvm" is constructed by cloister and takes no manifest/],
  ["an absolute manifest path",
    (t) => placeAs(t, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "/etc/dolt.yaml"\n`),
    /manifest "\/etc\/dolt.yaml" is absolute/],
  ["a manifest path escaping the cluster dir",
    (t) => placeAs(t, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "kubernetes"\nmanifest = "../dolt.yaml"\n`),
    /manifest "..\/dolt.yaml" has a ".." segment/],
  ["a connection end with no placement for the env",
    (t) => placeAs(t, "dolt.yaml", `[[bundles.placements]]\nenv = "staging"\nkind = "kubernetes"\nmanifest = "dolt.yaml"\n`),
    /bundle "dolt" is the target of connection "orders-db" but has no placement for env "local"/],
];

for (const [label, edit, pattern] of placementRefusals) {
  test(`toml-to-cluster refuses by name: placement ${label}`, async () => {
    await assert.rejects(parseTomlToCluster(edit(DEMO_TOML)), pattern);
  });
}

test("placements and minStrength round-trip through cluster-to-toml", async () => {
  const c = await parseTomlToCluster(DEMO_TOML);
  assert.deepEqual(await parseTomlToCluster(clusterToToml(c)), c);
});

// ── kubernetes emitter: positive ─────────────────────────────────────────

test("cluster k8s: files, unchanged manifests, and the exact NetworkPolicy objects", async () => {
  const files = await emit();
  assert.deepEqual(files.map((f) => f.path), [
    "dolt/00-namespace.yaml",
    "dolt/10-dolt.yaml",
    "dolt/20-networkpolicy.yaml",
    "orders/00-namespace.yaml",
    "orders/10-orders.yaml",
    "orders/20-networkpolicy.yaml",
  ]);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  // Forwarded means forwarded: byte-for-byte copies.
  assert.equal(byPath["dolt/10-dolt.yaml"], MANIFESTS["dolt.yaml"]);
  assert.equal(byPath["orders/10-orders.yaml"], MANIFESTS["orders.yaml"]);

  const managed = { "app.kubernetes.io/managed-by": "cloister" };
  assert.deepEqual(docs(byPath["dolt/00-namespace.yaml"]), [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: "dolt", labels: managed } },
  ]);
  const deny = (ns) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "cloister-default-deny-ingress", namespace: ns, labels: managed },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
  });
  assert.deepEqual(docs(byPath["dolt/20-networkpolicy.yaml"]), [
    deny("dolt"),
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "cloister-allow-orders-orders-db", namespace: "dolt", labels: managed },
      spec: {
        podSelector: { matchLabels: { app: "dolt" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "orders" } },
                podSelector: { matchLabels: { app: "orders" } },
              },
            ],
            ports: [{ protocol: "TCP", port: 3306 }],
          },
        ],
      },
    },
  ]);
  // Nothing connects TO orders, so its namespace only denies.
  assert.deepEqual(docs(byPath["orders/20-networkpolicy.yaml"]), [deny("orders")]);
});

test("cluster k8s output is deterministic", async () => {
  assert.deepEqual(await emit(), await emit());
});

test("cluster k8s: a manifest that declares its own Namespace gets none added", async () => {
  const withNs = { ...MANIFESTS, "dolt.yaml": `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: dolt\n---\n${MANIFESTS["dolt.yaml"]}` };
  const files = await emit(DEMO_TOML, withNs);
  assert.equal(files.some((f) => f.path === "dolt/00-namespace.yaml"), false);
});

test("cluster k8s: the policy port is the Service's targetPort (the pod's port)", async () => {
  const named = { ...MANIFESTS, "dolt.yaml": MANIFESTS["dolt.yaml"].replace("targetPort: 3306", "targetPort: mysql") };
  const policy = docs((await emit(DEMO_TOML, named)).find((f) => f.path === "dolt/20-networkpolicy.yaml").content)[1];
  assert.deepEqual(policy.spec.ingress[0].ports, [{ protocol: "TCP", port: "mysql" }]);
});

// ── kubernetes emitter: refusals ─────────────────────────────────────────

const manifestRefusals = [
  ["missing Service port",
    (m) => m.replace("name: mysql\n      port: 3306", "name: sql\n      port: 3306"),
    /Service "dolt" port "mysql" is missing — bundle "dolt" declares port "mysql" \(3306\) with expose "cluster"/],
  ["Service port number mismatch",
    (m) => m.replace("port: 3306\n      targetPort", "port: 3307\n      targetPort"),
    /Service "dolt" port "mysql" has port 3307, but cluster.toml declares 3306/],
  ["appProtocol mismatch",
    (m) => m.replace("appProtocol: art.mysql", "appProtocol: mysql"),
    /Service "dolt" port "mysql" has appProtocol "mysql", but cluster.toml declares "art.mysql"/],
  ["an object in another namespace",
    (m) => m.replace("kind: Service\nmetadata:\n  name: dolt\n", "kind: Service\nmetadata:\n  name: dolt\n  namespace: db\n"),
    /Service "dolt" is in namespace "db", but bundle "dolt"'s objects must be in namespace "dolt"/],
  ["a conflicting Namespace object",
    (m) => `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: databases\n---\n${m}`,
    /declares Namespace "databases", but bundle "dolt" lives in namespace "dolt"/],
  ["two Services",
    (m) => `${m}---\napiVersion: v1\nkind: Service\nmetadata:\n  name: dolt-headless\nspec:\n  selector:\n    app: dolt\n`,
    /bundle "dolt" must declare exactly one core v1 Service \(found 2\)/],
  // An object is identified by API group and kind. A Knative Service shares
  // only the word "Service" with a core one: read as a core Service it was
  // refused for having no selector, which a Knative Service never has.
  ["a Knative Service beside the core Service",
    (m) => `${m}---\napiVersion: serving.knative.dev/v1\nkind: Service\nmetadata:\n  name: dolt-kn\nspec:\n  template:\n    spec:\n      containers:\n        - image: example.com/dolt\n`,
    /Knative Service "dolt-kn" \(serving\.knative\.dev\/v1\) cannot be a "kubernetes" placement\..*Place bundle "dolt" kind = "knative".*Or give it a Deployment and a core v1 Service/],
  ["a Knative Service in place of the core Service",
    (m) => m.replace("apiVersion: v1\nkind: Service", "apiVersion: serving.knative.dev/v1beta1\nkind: Service"),
    /Knative Service "dolt" \(serving\.knative\.dev\/v1beta1\) cannot be a "kubernetes" placement/],
  ["a Service of an unknown API group in place of the core Service",
    (m) => m.replace("apiVersion: v1\nkind: Service", "apiVersion: example.com/v1\nkind: Service"),
    /bundle "dolt" must declare exactly one core v1 Service \(found 0\)/],
  ["an object with no apiVersion",
    (m) => `${m}---\nkind: ConfigMap\nmetadata:\n  name: settings\n`,
    /every document must be a Kubernetes object with an apiVersion and a kind/],
  ["a Service with no selector",
    (m) => m.replace("spec:\n  selector:\n    app: dolt\n  ports:", "spec:\n  ports:"),
    /Service "dolt" has no spec.selector/],
  ["unparseable YAML",
    (m) => `${m}\n  : : [\n`,
    /bundle "dolt" manifest dolt.yaml: YAML parse error/],
];

for (const [label, edit, pattern] of manifestRefusals) {
  test(`cluster k8s refuses by name: ${label}`, async () => {
    await assert.rejects(emit(DEMO_TOML, { ...MANIFESTS, "dolt.yaml": edit(MANIFESTS["dolt.yaml"]) }), pattern);
  });
}

test("a connection end placed cloudRun fails the BUILD: a channel end must be microvm or kubernetes", async () => {
  // dolt keeps a kubernetes row (staging) so its exposed port is legal; in
  // env "local" it is placed cloudRun, which no emitter lowers.
  const t = placeAs(
    DEMO_TOML,
    "dolt.yaml",
    `[[bundles.placements]]\nenv = "local"\nkind = "cloudRun"\n\n[[bundles.placements]]\nenv = "staging"\nkind = "kubernetes"\nmanifest = "dolt.yaml"\n`,
  ).replace('minStrength = "policy"', 'minStrength = ""');
  await assert.rejects(
    parseTomlToCluster(t),
    /bundle "dolt" is the target of connection "orders-db" but is placed "cloudRun" for env "local"; a channel end must be placed microvm, kubernetes or knative/,
  );
});

test("an exposed port on a bundle with no microvm or kubernetes placement fails the build", async () => {
  const t = placeAs(DEMO_TOML, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "cloudRun"\n`);
  await assert.rejects(
    parseTomlToCluster(t),
    /bundle "dolt" exposes port "mysql" but has no placement of kind microvm, kubernetes or knative \(declared: cloudRun\)/,
  );
});

test("cluster k8s keeps its unlowered-kind refusal as defense in depth", () => {
  const bundles = [
    { name: "orders", kind: "external", executionMode: "", ports: [], placements: [{ env: "local", kind: "kubernetes", manifest: "orders.yaml" }] },
    { name: "dolt", kind: "external", executionMode: "", ports: [], placements: [{ env: "local", kind: "cloudRun", manifest: "" }] },
  ];
  const connections = [{ from: "orders", name: "orders-db", appProtocol: "art.mysql", minStrength: "", targets: [{ env: "local", bundle: "dolt", port: "mysql" }] }];
  assert.throws(
    () => emitK8s({ bundles, connections, env: "local", readManifest: () => "" }),
    /"dolt" is placed "cloudRun", which is not lowered yet/,
  );
});

test("cluster k8s refuses a cross-tier edge (kubernetes → microvm): it needs LLO's broker", async () => {
  let t = asMicrovm(DEMO_TOML, "dolt", DOLT_IMAGE);
  t = placeAs(t, "dolt.yaml", MICROVM());
  await assert.rejects(
    emit(t),
    /joins "orders" \(kubernetes\) to "dolt" \(microvm\): an edge across placements needs LLO's broker \(ley-line-open-e2c5ce\)/,
  );
});

// ── runtime plan sees placements too ─────────────────────────────────────

const lock = {
  inputs: Object.fromEntries(["dolt", "orders"].map((n) => [n, { oci: { identifier: `x/${n}`, digest: `sha256:${"a".repeat(64)}`, rootfs: [{ platform: "linux/arm64", digest: `blake3-256:${"b".repeat(64)}`, image: `sha256:${"a".repeat(64)}` }] } }])),
};
/** cluster.toml text → plan, through parseTomlToCluster (the only path). */
function plan(toml, bundle) {
  return planFromToml(toml, lock, {
    bundle, workspace: "/workspace", controlSocket: `/tmp/${bundle}.sock`, env: "local", channelDir: "/tmp/ch",
    rootfsInCas: () => ({ present: true, casRoot: "/cas" }), guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
  });
}

test("runtime plan refuses the microvm end of a cross-tier edge, naming the broker", async () => {
  let t = asMicrovm(DEMO_TOML, "orders", "dolt-grpc-demo:dev");
  t = placeAs(t, "orders.yaml", MICROVM());
  await assert.rejects(plan(t, "orders"), /joins "orders" \(microvm\) to "dolt" \(kubernetes\).*ley-line-open-e2c5ce/);
});

test("runtime plan refuses a bundle placed kubernetes, pointing at cluster k8s", async () => {
  let t = asMicrovm(DEMO_TOML, "dolt", DOLT_IMAGE);
  t = asMicrovm(t, "orders", "dolt-grpc-demo:dev");
  await assert.rejects(plan(t, "orders"), /bundle "orders" is placed "kubernetes" for env "local"; lower it with `cloister cluster k8s`/);
});

test("runtime plan lowers explicit microvm placements as before", async () => {
  const p = await plan(microvmBoth("capability"), "orders");
  assert.deepEqual(p.confinement.unixSocket.allow, [
    { path: "/tmp/ch/orders.grpc.sock", mode: "bind", guestPort: 50051 },
    { path: "/tmp/ch/dolt.mysql.sock", guestPort: 3306 },
  ]);
});

// ── CLI writer ───────────────────────────────────────────────────────────

test("cluster k8s writes the files, re-runs into the same --out, and refuses stale files", async () => {
  const out = mkdtempSync(join(tmpdir(), "cloister-k8s-"));
  try {
    const first = await emitK8sDir({ root: DEMO, env: "local", out });
    assert.deepEqual(first.bundles, ["dolt", "orders"]);
    assert.equal(readFileSync(join(out, "dolt/10-dolt.yaml"), "utf8"), MANIFESTS["dolt.yaml"]);
    await emitK8sDir({ root: DEMO, env: "local", out });
    mkdirSync(join(out, "old"), { recursive: true });
    writeFileSync(join(out, "old/stale.yaml"), "kind: ConfigMap\n");
    await assert.rejects(emitK8sDir({ root: DEMO, env: "local", out }), /holds files this run would not write \(old\/stale.yaml\)/);
    assert.ok(existsSync(join(out, "old/stale.yaml")), "a stale file is refused, never deleted");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("cluster k8s with no kubernetes placement for the env says so", async () => {
  const out = mkdtempSync(join(tmpdir(), "cloister-k8s-"));
  try {
    await assert.rejects(emitK8sDir({ root: DEMO, env: "gcp", out }), /no bundle is placed "kubernetes" or "knative" for env "gcp"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("cluster k8s refuses expose = \"edge\" by name: publishing outside the cluster is not lowered yet", async () => {
  const toml = DEMO_TOML.replace(/(name = "mysql"\nport = 3306\nappProtocol = "art.mysql"\n)expose = "cluster"/, '$1expose = "edge"');
  assert.notEqual(toml, DEMO_TOML, "fixture lost its mysql port row");
  await assert.rejects(
    emit(toml),
    /bundle "dolt" port "mysql" has expose = "edge", which `cluster k8s` does not lower yet \(a NodePort plus kind extraPortMappings; tracked with cloister-55424e\)/,
  );
});

// ── knative placement: checked, never lowered (issue #311) ───────────────
//
// A workqueue and the reconciler it calls, both Knative Services sharing one
// namespace. Strength belongs to the placement: knative is "none", so nothing
// is written for it, and an edge that demands more fails the build.

const KN_HEAD = DEMO_TOML.slice(0, DEMO_TOML.indexOf("[[bundles]]"));
const knBundle = (name, { port = 80, appProtocol = "art.http", expose = "cluster", kind = "knative", extraPorts = "" } = {}) => `
[[bundles]]
name = "${name}"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/${name}:1"

[[bundles.ports]]
name = "http"
port = ${port}
appProtocol = "${appProtocol}"
expose = "${expose}"
${extraPorts}
[[bundles.placements]]
env = "local"
kind = "${kind}"
manifest = "${name}.yaml"
`;
const knConnection = (minStrength, appProtocol = "art.http") => `
[[connections]]
from = "workqueue"
name = "reconcile"
appProtocol = "${appProtocol}"
${minStrength === null ? "" : `minStrength = "${minStrength}"\n`}
[[connections.targets]]
env = "local"
bundle = "reconciler"
port = "http"
`;
const knToml = ({ minStrength = "none", reconciler = {}, workqueue = {}, appProtocol = "art.http" } = {}) =>
  KN_HEAD + knBundle("workqueue", workqueue) + knBundle("reconciler", { appProtocol, ...reconciler }) + knConnection(minStrength, appProtocol);
const ksvc = (name, { portName, containerPort = 8080, namespace = "platform", ports } = {}) => {
  const rows = ports ?? [`- containerPort: ${containerPort}${portName ? `\n              name: ${portName}` : ""}`];
  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${name}
${namespace ? `  namespace: ${namespace}\n` : ""}spec:
  template:
    spec:
      containers:
        - image: example.com/${name}:1
          ports:
            ${rows.join("\n            ")}
`;
};
const KN_MANIFESTS = { "workqueue.yaml": ksvc("workqueue"), "reconciler.yaml": ksvc("reconciler") };
async function lowerKn(toml = knToml(), manifests = KN_MANIFESTS) {
  const cluster = await parseTomlToCluster(toml);
  return lowerK8s({
    bundles: cluster.bundles.map(checkableBundle),
    connections: cluster.connections,
    env: "local",
    readManifest: (p) => manifests[p],
  });
}

test("strengthOf: knative is none, so its edges never report a strength nothing enforces", () => {
  assert.equal(strengthOf("knative"), "none");
  assert.equal(meetStrength(strengthOf("knative"), strengthOf("kubernetes")), "none");
});

test("knative ↔ knative at minStrength none (or unset): checked, and nothing is written", async () => {
  for (const minStrength of ["none", null]) {
    const { files, checked } = await lowerKn(knToml({ minStrength }));
    assert.deepEqual(files, [], "no file, namespace or policy for a knative placement");
    assert.deepEqual(checked, [
      { bundle: "workqueue", service: "workqueue", namespace: "platform", wire: "http1", port: 80,
        connectionsIn: [], connectionsOut: [{ name: "reconcile", to: "reconciler" }] },
      { bundle: "reconciler", service: "reconciler", namespace: "platform", wire: "http1", port: 80,
        connectionsIn: [{ name: "reconcile", from: "workqueue" }], connectionsOut: [] },
    ]);
  }
});

test("a knative edge that demands policy fails the BUILD by name", async () => {
  await assert.rejects(
    parseTomlToCluster(knToml({ minStrength: "policy" })),
    /connection "reconcile" \(from "workqueue"\) env "local": minStrength "policy" is not met — "workqueue" is placed "knative" and "reconciler" is placed "knative", so the edge's strength is "none"/,
  );
});

test("several knative bundles may share a namespace: the one-per-bundle rule is about where policy is written", async () => {
  const { checked } = await lowerKn();
  assert.deepEqual(checked.map((c) => c.namespace), ["platform", "platform"]);
  const bare = await lowerKn(knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { namespace: "" }) });
  assert.equal(bare.checked[1].namespace, "");
});

const knativeRefusals = [
  ["a declared port that is not the port a peer dials",
    knToml({ reconciler: { port: 8080 } }), KN_MANIFESTS,
    /Knative Service "reconciler": port "http" is declared as 8080 in cluster.toml, but a Knative Service is reached on port 80 inside the cluster \(its container port 8080 is not what a peer dials\)/],
  ["gRPC declared on a Service that serves http1",
    knToml({ appProtocol: "art.grpc" }), KN_MANIFESTS,
    /port "http" has appProtocol "art.grpc", which needs the container port named "h2c", but the Service serves http1 \(an unnamed container port is http1\)/],
  ["plain HTTP declared on a Service that serves h2c",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { portName: "h2c" }) },
    /port "http" has appProtocol "art.http", which needs the container port named "http1", but the Service serves h2c/],
  ["a protocol that is not HTTP",
    knToml({ appProtocol: "art.mysql" }), KN_MANIFESTS,
    /port "http" has appProtocol "art.mysql", which is not HTTP; a Knative Service serves HTTP only/],
  ["expose = edge",
    knToml({ workqueue: { expose: "edge" } }), KN_MANIFESTS,
    /Knative Service "workqueue": port "http" has expose = "edge", which is not checked for a knative placement/],
  ["two exposed ports",
    knToml({ workqueue: { extraPorts: `\n[[bundles.ports]]\nname = "admin"\nport = 9090\nappProtocol = "art.http"\nexpose = "cluster"\n` } }), KN_MANIFESTS,
    /bundle "workqueue" declares 2 exposed ports \(http, admin\); a Knative Service serves exactly one/],
  ["a Knative Service with two container ports",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { ports: ["- containerPort: 8080", "- containerPort: 9090"] }) },
    /Knative Service "reconciler" declares 2 container ports; a Knative Service serves exactly one/],
  ["a container port name Knative does not read",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { portName: "grpc" }) },
    /names its container port "grpc"; Knative reads only "http1" or "h2c" there/],
  ["a core Service under a knative placement",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": `apiVersion: v1\nkind: Service\nmetadata:\n  name: reconciler\nspec:\n  selector:\n    app: reconciler\n` },
    /bundle "reconciler" is placed "knative" and must declare exactly one Knative Service \(serving\.knative\.dev; found 0\)\. It declares a core v1 Service: place it kind = "kubernetes"/],
  ["two Knative Services in one bundle's manifest",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": `${ksvc("reconciler")}---\n${ksvc("reconciler-b")}` },
    /must declare exactly one Knative Service \(serving\.knative\.dev; found 2\)/],
];
for (const [label, toml, manifests, pattern] of knativeRefusals) {
  test(`cluster k8s refuses a knative bundle by name: ${label}`, async () => {
    await assert.rejects(lowerKn(toml, manifests), pattern);
  });
}

test("the right wire passes: gRPC on h2c, and a vendor label is not checked", async () => {
  await lowerKn(knToml({ appProtocol: "art.grpc" }), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { portName: "h2c" }) });
  await lowerKn(knToml({ appProtocol: "x-example-rpc" }), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { portName: "h2c" }) });
});

test("every blessed appProtocol label is placed in the Knative wire table", () => {
  assert.deepEqual(Object.keys(KNATIVE_WIRES).sort(), [...BLESSED_LABELS].sort());
});

test("a knative placement needs a manifest, and an edge between knative and kubernetes is refused", async () => {
  await assert.rejects(
    parseTomlToCluster(knToml().replace('manifest = "reconciler.yaml"\n', "")),
    /bundle "reconciler" placement env "local": kind "knative" requires a manifest/,
  );
  const mixed = KN_HEAD + knBundle("workqueue") + knBundle("reconciler", { kind: "kubernetes" }) + knConnection("none");
  const core = `apiVersion: v1\nkind: Service\nmetadata:\n  name: reconciler\nspec:\n  selector:\n    app: reconciler\n  ports:\n    - name: http\n      port: 80\n      appProtocol: art.http\n`;
  await assert.rejects(
    lowerKn(mixed, { ...KN_MANIFESTS, "reconciler.yaml": core }),
    /connection "reconcile" \(from "workqueue"\) env "local" joins "workqueue" \(knative\) to "reconciler" \(kubernetes\): a kubernetes bundle is fenced by NetworkPolicies that select pods/,
  );
});

test("cluster k8s on a knative-only cluster reports the check and leaves --out untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-kn-"));
  try {
    writeFileSync(join(root, "cluster.toml"), knToml());
    for (const [name, text] of Object.entries(KN_MANIFESTS)) writeFileSync(join(root, name), text);
    const out = join(root, "out");
    const lines = [];
    const code = await clusterMain(["k8s", "--dir", root, "--env", "local", "--out", out], { log: (l) => lines.push(l), errLog: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join("\n"));
    assert.equal(existsSync(out), false, "nothing is written for a knative placement");
    assert.deepEqual(lines, [
      'cloister cluster k8s: checked "workqueue" (knative, strength "none"): reached at workqueue.platform.svc:80 (http1); nothing written',
      'cloister cluster k8s: checked "reconciler" (knative, strength "none"): reached at reconciler.platform.svc:80 (http1); nothing written',
      '  connection "reconcile" from "workqueue": checked, not enforced',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
