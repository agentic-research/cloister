// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Placements, the channel-strength rail, and the forwarded kubernetes
// lowering (ADR-0070 §2–4), cloister-991e65.
//
// Run with:
//   node --import tsx --test cli/test/cluster/placements-k8s.test.mjs
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

import { parseTomlToCluster, checkableBundle } from "../../lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../lib/cluster/cluster-to-toml.mjs";
import { emitK8s, KNATIVE_WIRES, lowerK8s } from "../../lib/cluster/emit-k8s.mjs";
import { addressesIn, clusterService, containerStrings, WORKLOADS } from "../../lib/cluster/manifest-addresses.mjs";
import { BLESSED_LABELS } from "../../lib/app-protocol.mjs";
import { assertPortsAndConnections, edgeStrength, meetStrength, strengthOf } from "../../lib/cluster/connections.mjs";
import { emitK8sDir, main as clusterMain } from "../../commands/cluster.mjs";
import { planFromToml } from "../../commands/runtime-plan.mjs";
import { tableAdmits } from "../fixtures/platform-admits-table.mjs";

const ADMITS = tableAdmits({
  "linux/arm64": { admitted: ["linux/arm64", "linux/arm64/v8"], overlapping: ["linux/arm64", "linux/arm64/v8"] },
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  assert.deepEqual(c.bundles[0].placements, [{ env: "local", kind: "kubernetes", manifest: "dolt.yaml", ports: [] }]);
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

// ADR-0074 §6: any forwarded placement may be a connection end. It is checked,
// not lowered, and its strength is "none" unless an emitter enforces it.
test("a connection end placed cloudRun is accepted, with strength none", async () => {
  const cloudRunLocal =
    `[[bundles.placements]]\nenv = "local"\nkind = "cloudRun"\n\n[[bundles.placements]]\nenv = "staging"\nkind = "kubernetes"\nmanifest = "dolt.yaml"\n`;
  const unfloored = placeAs(DEMO_TOML, "dolt.yaml", cloudRunLocal).replace('minStrength = "policy"', 'minStrength = ""');
  await parseTomlToCluster(unfloored);
  // The floor still holds: nothing enforces a cloudRun end, so "policy" is not met.
  await assert.rejects(
    parseTomlToCluster(placeAs(DEMO_TOML, "dolt.yaml", cloudRunLocal)),
    /minStrength "policy" is not met — "orders" is placed "kubernetes" and "dolt" is placed "cloudRun", so the edge's strength is "none"/,
  );
});

test("an exposed port on a bundle placed only cloudRun is accepted", async () => {
  const t = placeAs(DEMO_TOML, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "cloudRun"\n`)
    .replace('minStrength = "policy"', 'minStrength = ""');
  await parseTomlToCluster(t);
});

test("an exposed port on a bundle with no placement that lowers or checks it fails the build", () => {
  const bundles = [{ name: "dolt", kind: "external", executionMode: "", ports: [{ name: "mysql", port: 3306, appProtocol: "art.mysql", expose: "cluster" }], placements: [{ env: "local", kind: "workerd", manifest: "" }] }];
  assert.throws(
    () => assertPortsAndConnections(bundles, []),
    /bundle "dolt" exposes port "mysql" but has no placement of kind microvm, kubernetes, knative or cloudRun \(declared: workerd\)/,
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
const ksvc = (name, { portName, containerPort = 8080, namespace = "platform", ports, env = [], visibility = "cluster-local" } = {}) => {
  const envRows = env.length ? `\n          env:\n${env.map(([k, v]) => `            - name: ${k}\n              ${v}`).join("\n")}` : "";
  const rows = ports ?? [`- containerPort: ${containerPort}${portName ? `\n              name: ${portName}` : ""}`];
  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${name}
${namespace ? `  namespace: ${namespace}\n` : ""}${visibility ? `  labels:\n    networking.knative.dev/visibility: ${visibility}\n` : ""}spec:
  template:
    spec:
      containers:
        - image: example.com/${name}:1
          name: app${envRows}
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
    /Knative Service "reconciler": port "http" is dialled on 8080 in cluster.toml, but a Knative Service is reached on port 80 inside the cluster \(its container port 8080 is not what a peer dials\)/],
  ["gRPC declared on a Service that serves http1",
    knToml({ appProtocol: "art.grpc" }), KN_MANIFESTS,
    /port "http" has appProtocol "art.grpc", which needs the container port named "h2c", but the Service serves http1 \(an unnamed container port is http1\)/],
  ["plain HTTP declared on a Service that serves h2c",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { portName: "h2c" }) },
    /port "http" has appProtocol "art.http", which needs the container port named "http1", but the Service serves h2c/],
  ["a protocol that is not HTTP",
    knToml({ appProtocol: "art.mysql" }), KN_MANIFESTS,
    /port "http" has appProtocol "art.mysql", which is not HTTP; a Knative Service serves HTTP only/],
  ["expose = edge on a Service labelled cluster-local",
    knToml({ workqueue: { expose: "edge" } }), KN_MANIFESTS,
    /Knative Service "workqueue": port "http" has expose = "edge", but the Service is labelled networking\.knative\.dev\/visibility: cluster-local, so it has no route from outside the cluster/],
  ["expose = cluster on a Service with a route from outside",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { visibility: "" }) },
    /Knative Service "reconciler": port "http" has expose = "cluster", but the Service is not labelled networking\.knative\.dev\/visibility: cluster-local\. Without it Knative gives the Service a route from outside the cluster/],
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
  // Two Services where one carries the bundle's name is a shared file, and is
  // read (see the shared-manifest tests below). Two with the SAME name is not.
  ["two Knative Services with the bundle's name in one manifest",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": `${ksvc("reconciler")}---\n${ksvc("reconciler", { namespace: "other" })}` },
    /must declare exactly one Knative Service \(serving\.knative\.dev; found 2\)\. With several in one manifest, the one named "reconciler" is used, and more than one is/],
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

test("a knative placement needs a manifest", async () => {
  await assert.rejects(
    parseTomlToCluster(knToml().replace('manifest = "reconciler.yaml"\n', "")),
    /bundle "reconciler" placement env "local": kind "knative" requires a manifest/,
  );
});

// kubernetes and knative share a cluster network, so an edge between them is
// lowered. What it is worth depends on its direction (ADR-0070 §2 amendment).
const CORE_RECONCILER = `apiVersion: v1\nkind: Service\nmetadata:\n  name: reconciler\nspec:\n  selector:\n    app: reconciler\n  ports:\n    - name: http\n      port: 80\n      appProtocol: art.http\n`;

test("knative → kubernetes: the target's policy admits the caller's Knative pods, and the edge is policy", async () => {
  const mixed = KN_HEAD + knBundle("workqueue") + knBundle("reconciler", { kind: "kubernetes" }) + knConnection("policy");
  const out = await lowerKn(mixed, { ...KN_MANIFESTS, "reconciler.yaml": CORE_RECONCILER });
  const policy = out.files.find((f) => f.path === "reconciler/20-networkpolicy.yaml").content;
  assert.match(policy, /namespaceSelector:\n\s+matchLabels:\n\s+kubernetes\.io\/metadata\.name: platform\n\s+podSelector:\n\s+matchLabels:\n\s+serving\.knative\.dev\/service: workqueue/);
  assert.equal(edgeStrength("knative", "kubernetes"), "policy");
  // A Knative caller with no namespace cannot be named in a policy.
  await assert.rejects(
    lowerKn(mixed, { ...KN_MANIFESTS, "workqueue.yaml": ksvc("workqueue", { namespace: "" }), "reconciler.yaml": CORE_RECONCILER }),
    /Knative Service "workqueue" states no metadata\.namespace, so no NetworkPolicy can name where its pods run/,
  );
});

test("kubernetes → knative: lowered, and worth nothing, because nothing fences a Knative Service from in-cluster callers", async () => {
  assert.equal(edgeStrength("kubernetes", "knative"), "none");
  const core = (name) => `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${name}\nspec:\n  selector:\n    app: ${name}\n  ports:\n    - name: http\n      port: 80\n      appProtocol: art.http\n`;
  const mixed = KN_HEAD + knBundle("workqueue", { kind: "kubernetes" }) + knBundle("reconciler") + knConnection("none");
  const out = await lowerKn(mixed, { ...KN_MANIFESTS, "workqueue.yaml": core("workqueue") });
  assert.deepEqual(out.checked.map((k) => [k.bundle, k.connectionsIn.map((c) => c.from)]), [["reconciler", ["workqueue"]]]);
  // And a floor above none fails the build, as for any edge into a knative bundle.
  await assert.rejects(
    parseTomlToCluster(KN_HEAD + knBundle("workqueue", { kind: "kubernetes" }) + knBundle("reconciler") + knConnection("policy")),
    /minStrength "policy" is not met — "workqueue" is placed "kubernetes" and "reconciler" is placed "knative", so the edge's strength is "none"/,
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
      'cloister cluster k8s: connection "reconcile" from "workqueue" to "reconciler": no env, args or command value names it',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── addresses a manifest's containers are told to dial (issue #311) ──────
//
// The strings an operator wrote into env, args and command are the manifest's
// own claim about the graph. They are held to the declared connections. The
// check reads addresses, not URLs: a DSN and a bare host:port count the same.

const withEnv = (...env) => ({ ...KN_MANIFESTS, "workqueue.yaml": ksvc("workqueue", { env }) });
const lit = (v) => `value: ${JSON.stringify(v)}`;

test("addressesIn finds a host in a URL, a bare host:port and a DSN, and never a password", () => {
  const hosts = (v) => addressesIn(v).filter((a) => a.hostPosition).map((a) => `${a.host}${a.port === null ? "" : `:${a.port}`}`);
  assert.deepEqual(hosts("http://reconciler.platform.svc"), ["reconciler.platform.svc:80"]);
  assert.deepEqual(hosts("https://reconciler.platform.svc.cluster.local/v1/run"), ["reconciler.platform.svc.cluster.local:443"]);
  assert.deepEqual(hosts("grpc://orders.shop.svc:50051"), ["orders.shop.svc:50051"]);
  assert.deepEqual(hosts("dns:///orders.shop.svc:50051"), ["orders.shop.svc:50051"]);
  assert.deepEqual(hosts("dolt.dolt.svc.cluster.local:3306"), ["dolt.dolt.svc.cluster.local:3306"]);
  assert.deepEqual(hosts("root:hunter2@tcp(dolt.dolt.svc:3306)/shop?parseTime=true"), ["dolt.dolt.svc:3306"]);
  assert.deepEqual(hosts("postgres://app:1234@db.data.svc:5432/app"), ["db.data.svc:5432"], "a number before @ is a password, not a port");
  assert.deepEqual(hosts("redis://cache"), ["cache"]);
  assert.deepEqual(hosts("HTTP://Reconciler.Platform.SVC"), ["reconciler.platform.svc:80"], "DNS names compare without case");
  // Not in host position: a plain word is not an address.
  assert.deepEqual(hosts("orders"), []);
  assert.deepEqual(hosts("--log-level=debug"), []);
  assert.deepEqual(clusterService("dolt.dolt.svc.cluster.local"), { service: "dolt", namespace: "dolt" });
  assert.deepEqual(clusterService("dolt.dolt.svc"), { service: "dolt", namespace: "dolt" });
  for (const host of ["dolt.dolt", "dolt.svc", "a.b.c.svc", "example.com", ".dolt.svc"]) assert.equal(clusterService(host), null, host);
});

test("containerStrings reads literal env, args and command from every workload kind, and nothing from valueFrom", () => {
  const pod = { initContainers: [{ name: "init", command: ["sh", "-c", "wait init.x.svc:1"] }], containers: [{ name: "app", args: ["--to", "a.x.svc:2"], env: [{ name: "LIT", value: "b.x.svc:3" }, { name: "SECRET", valueFrom: { secretKeyRef: { name: "s", key: "k" } } }, { name: "NUM", value: 5 }] }] };
  const nest = (path) => path.reduceRight((inner, key) => ({ [key]: inner }), pod);
  for (const w of WORKLOADS) {
    const obj = { apiVersion: w.group ? `${w.group}/v1` : "v1", kind: w.kind, ...nest(w.path) };
    const { strings, unread } = containerStrings([obj]);
    assert.deepEqual(
      strings.map((x) => `${x.container} ${x.where} ${x.value}`),
      ["init command sh", "init command -c", "init command wait init.x.svc:1", "app env LIT b.x.svc:3", "app args --to", "app args a.x.svc:2"],
      `${w.group}/${w.kind}`,
    );
    assert.deepEqual(unread, [{ container: "app", where: "env SECRET", kind: "Secret", name: "s" }], `${w.group}/${w.kind}`);
  }
  // An object of the same kind in another API group is not a workload.
  assert.deepEqual(containerStrings([{ apiVersion: "example.com/v1", kind: "Deployment", spec: { template: { spec: pod } } }]).strings, []);
});

// The environment is resolved in layers, and only the value that wins is one
// the container can dial.
const REF = (name) => "$" + `(${name})`;
const deployment = (container, extra = []) => [
  { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "app" }, spec: { template: { spec: { containers: [{ name: "app", ...container }] } } } },
  ...extra,
];
const configMap = (name, data) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name }, data });
const secret = (name, fields) => ({ apiVersion: "v1", kind: "Secret", metadata: { name }, ...fields });
const b64 = (text) => Buffer.from(text).toString("base64");
const resolved = (objects) => {
  const { strings, unread } = containerStrings(objects);
  return { strings: strings.map((x) => `${x.where} = ${x.value}`), unread: unread.map((u) => `${u.where} <- ${u.kind} ${u.name}`) };
};

test("env resolution: envFrom, then env, a later entry overriding an earlier one", () => {
  const out = resolved(deployment(
    {
      envFrom: [{ configMapRef: { name: "base" } }, { prefix: "DB_", secretRef: { name: "creds" } }, { configMapRef: { name: "override" } }],
      env: [{ name: "B", value: "from-env" }, { name: "D", value: "first" }, { name: "D", value: "second" }],
    },
    [configMap("base", { A: "base-a", B: "base-b", C: "base-c" }), configMap("override", { C: "override-c" }), secret("creds", { stringData: { HOST: "db.data.svc:5432" } })],
  ));
  assert.deepEqual(out.strings.sort(), [
    'env A (ConfigMap "base") = base-a',
    "env B = from-env",
    'env C (ConfigMap "override") = override-c',
    "env D = second",
    'env DB_HOST (Secret "creds") = db.data.svc:5432',
  ]);
  assert.deepEqual(out.unread, []);
});

test("env resolution: valueFrom reads one key of a ConfigMap or Secret in the manifest", () => {
  const out = resolved(deployment(
    {
      env: [
        { name: "FROM_CM", valueFrom: { configMapKeyRef: { name: "urls", key: "reconciler" } } },
        { name: "FROM_SECRET", valueFrom: { secretKeyRef: { name: "creds", key: "dsn" } } },
        { name: "PLAIN_WINS", valueFrom: { secretKeyRef: { name: "both", key: "k" } } },
        { name: "MISSING_KEY", valueFrom: { configMapKeyRef: { name: "urls", key: "absent" } } },
        { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
      ],
    },
    [
      configMap("urls", { reconciler: "http://reconciler.platform.svc" }),
      secret("creds", { data: { dsn: b64("app:pw@tcp(dolt.dolt.svc:3306)/shop") } }),
      secret("both", { data: { k: b64("encoded") }, stringData: { k: "plain" } }),
    ],
  ));
  assert.deepEqual(out.strings, [
    'env FROM_CM (ConfigMap "urls" key "reconciler") = http://reconciler.platform.svc',
    'env FROM_SECRET (Secret "creds" key "dsn") = app:pw@tcp(dolt.dolt.svc:3306)/shop',
    'env PLAIN_WINS (Secret "both" key "k") = plain',
  ]);
  assert.deepEqual(out.unread, [], "a key that is absent, and a field reference, hold no address and are not unread sources");
});

test("env resolution: a reference outside the manifest is unread, and still overrides", () => {
  const out = resolved(deployment(
    {
      envFrom: [{ configMapRef: { name: "base" } }, { secretRef: { name: "elsewhere" } }],
      env: [{ name: "URL", valueFrom: { secretKeyRef: { name: "vault", key: "url" } } }],
    },
    [configMap("base", { URL: "http://stale.platform.svc", KEEP: "kept" })],
  ));
  // URL's real value is in a Secret this cannot see. The ConfigMap's URL is
  // NOT what the container gets, so it must not be reported as in effect.
  assert.deepEqual(out.strings, ['env KEEP (ConfigMap "base") = kept']);
  assert.deepEqual(out.unread, ["envFrom <- Secret elsewhere", "env URL <- Secret vault"]);
});

test("env resolution: a variable reference expands from what is defined before it, and into args and command", () => {
  const out = resolved(deployment(
    {
      envFrom: [{ configMapRef: { name: "base" } }],
      env: [
        { name: "EARLY", value: `http://${REF("HOST")}:${REF("LATER")}` },
        { name: "LATER", value: "8080" },
        { name: "URL", value: `http://${REF("HOST")}:${REF("LATER")}/run` },
        { name: "ESCAPED", value: `$${REF("HOST")}` },
        { name: "UNKNOWN", value: `http://${REF("NOPE")}` },
      ],
      command: ["serve", `--peer=${REF("URL")}`],
      args: [`--db=${REF("HOST")}:3306`],
    },
    [configMap("base", { HOST: "reconciler.platform.svc" })],
  ));
  assert.deepEqual(out.strings, [
    'env HOST (ConfigMap "base") = reconciler.platform.svc',
    `env EARLY = http://reconciler.platform.svc:${REF("LATER")}`,
    "env LATER = 8080",
    "env URL = http://reconciler.platform.svc:8080/run",
    `env ESCAPED = ${REF("HOST")}`,
    `env UNKNOWN = http://${REF("NOPE")}`,
    "command = serve",
    "command = --peer=http://reconciler.platform.svc:8080/run",
    "args = --db=reconciler.platform.svc:3306",
  ]);
});

test("an address that arrives through a ConfigMap, a Secret or an expansion is held to the declarations like a literal", async () => {
  const viaConfigMap = `${ksvc("workqueue", { env: [["RECONCILER_URL", "valueFrom:\n                configMapKeyRef:\n                  name: urls\n                  key: reconciler"]] })}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: urls\n  namespace: platform\ndata:\n  reconciler: http://reconciler.platform.svc\n`;
  const good = await lowerKn(knToml(), { ...KN_MANIFESTS, "workqueue.yaml": viaConfigMap });
  assert.deepEqual(good.references, [
    { bundle: "workqueue", container: "app", where: 'env RECONCILER_URL (ConfigMap "urls" key "reconciler")', address: "reconciler.platform.svc:80", to: "reconciler", connections: ["reconcile"] },
  ]);
  assert.deepEqual(good.unreferenced, []);

  // The same reference, with the Secret holding the wrong port: refused, and the value is not printed.
  const viaSecret = `${ksvc("workqueue", { env: [["DSN", "valueFrom:\n                secretKeyRef:\n                  name: creds\n                  key: dsn"]] })}---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\n  namespace: platform\ndata:\n  dsn: ${b64("app:s3cret-value@tcp(reconciler.platform.svc:3306)/db")}\n`;
  await assert.rejects(lowerKn(knToml(), { ...KN_MANIFESTS, "workqueue.yaml": viaSecret }), (err) => {
    assert.match(err.message, /container "app" env DSN \(Secret "creds" key "dsn"\) names reconciler\.platform\.svc:3306 \(bundle "reconciler"\), but the declared connection "reconcile" reaches port 80/);
    assert.ok(!err.message.includes("s3cret-value"));
    return true;
  });

  // A literal that an env entry overrides is not what the container dials.
  const overridden = ksvc("workqueue", { env: [["URL", lit("http://datastore.platform.svc")], ["URL", lit("http://reconciler.platform.svc")]] });
  const three = await lowerKn(threeToml(), { ...KN_MANIFESTS, "workqueue.yaml": overridden, "datastore.yaml": ksvc("datastore") });
  assert.deepEqual(three.references.map((r) => r.to), ["reconciler"]);
});

test("a reference to a Secret outside the manifest is reported as unread, not as a missing address", async () => {
  const { unread, unreferenced } = await lowerKn(knToml(), withEnv(["RECONCILER_URL", "valueFrom:\n                secretKeyRef:\n                  name: urls\n                  key: reconciler"]));
  assert.deepEqual(unread, [{ bundle: "workqueue", container: "app", where: "env RECONCILER_URL", kind: "Secret", name: "urls" }]);
  assert.deepEqual(unreferenced, [{ name: "reconcile", from: "workqueue", to: "reconciler" }]);
});

test("an address that names a declared connection's target is evidence, in any spelling", async () => {
  for (const value of [
    "http://reconciler.platform.svc",
    "http://reconciler.platform.svc.cluster.local:80/run",
    "reconciler.platform.svc:80",
    "http://reconciler.platform",
    "http://reconciler",
    "reconciler:80",
    "user:pw@tcp(reconciler.platform.svc:80)/x",
  ]) {
    const { references, unreferenced } = await lowerKn(knToml(), withEnv(["RECONCILER_URL", lit(value)]));
    assert.equal(references.length, 1, value);
    assert.deepEqual({ ...references[0], address: undefined }, { bundle: "workqueue", container: "app", where: "env RECONCILER_URL", address: undefined, to: "reconciler", connections: ["reconcile"] }, value);
    assert.deepEqual(unreferenced, [], value);
  }
});

const DATASTORE = knBundle("datastore");
const threeToml = () => KN_HEAD + knBundle("workqueue") + knBundle("reconciler") + DATASTORE + knConnection("none");
const three = (...env) => ({ ...withEnv(...env), "datastore.yaml": ksvc("datastore") });

const addressRefusals = [
  ["an address naming a bundle with no declared connection (the wrong service)",
    threeToml(), three(["RECONCILER_URL", lit("http://datastore.platform.svc")]),
    /bundle "workqueue" manifest workqueue.yaml: container "app" env RECONCILER_URL names datastore\.platform\.svc:80 \(bundle "datastore"\), but cluster.toml declares no connection from "workqueue" to "datastore" for env "local"/],
  ["the wrong service by its short name",
    threeToml(), three(["RECONCILER_URL", lit("http://datastore")]),
    /env RECONCILER_URL names datastore:80 \(bundle "datastore"\), but cluster.toml declares no connection/],
  ["the right service on the wrong port",
    knToml(), withEnv(["RECONCILER_URL", lit("http://reconciler.platform.svc:8080")]),
    /env RECONCILER_URL names reconciler\.platform\.svc:8080 \(bundle "reconciler"\), but the declared connection "reconcile" reaches port 80/],
  ["a non-HTTP address on the wrong port",
    knToml(), withEnv(["DSN", lit("app:s3cret-value@tcp(reconciler.platform.svc:3306)/db")]),
    /env DSN names reconciler\.platform\.svc:3306 \(bundle "reconciler"\), but the declared connection "reconcile" reaches port 80/],
  ["https, whose default port is not the declared one",
    knToml(), withEnv(["RECONCILER_URL", lit("https://reconciler.platform.svc")]),
    /names reconciler\.platform\.svc:443 \(bundle "reconciler"\), but the declared connection "reconcile" reaches port 80/],
  ["a connection declared only in the other direction",
    knToml(), { ...KN_MANIFESTS, "reconciler.yaml": ksvc("reconciler", { env: [["CALLBACK", lit("http://workqueue.platform.svc")]] }) },
    /bundle "reconciler" manifest reconciler.yaml: container "app" env CALLBACK names workqueue\.platform\.svc:80 \(bundle "workqueue"\), but cluster.toml declares no connection from "reconciler" to "workqueue"/],
];
for (const [label, toml, manifests, pattern] of addressRefusals) {
  test(`cluster k8s refuses by name: ${label}`, async () => {
    await assert.rejects(lowerKn(toml, manifests), (err) => {
      assert.match(err.message, pattern);
      assert.ok(!err.message.includes("s3cret-value"), "the value is never printed, only the host and port");
      return true;
    });
  });
}

test("a cluster name that is no placed bundle is reported and not refused; a secret reference is not read", async () => {
  const { references, unreferenced } = await lowerKn(knToml(), withEnv(
    ["RECONCILER_URL", lit("http://reconcilr.platform.svc")],
    ["METRICS", lit("http://prometheus.monitoring.svc:9090")],
    ["FROM_SECRET", "valueFrom:\n                secretKeyRef:\n                  name: urls\n                  key: datastore"],
    ["PUBLIC", lit("https://example.com/api")],
    ["SELF", lit("http://workqueue.platform.svc")],
    ["NAME", lit("reconciler")],
  ));
  assert.deepEqual(references, [
    { bundle: "workqueue", container: "app", where: "env RECONCILER_URL", address: "reconcilr.platform.svc:80", to: null, connections: [] },
    { bundle: "workqueue", container: "app", where: "env METRICS", address: "prometheus.monitoring.svc:9090", to: null, connections: [] },
  ]);
  // The typo means nothing named the declared target: both facts are reported.
  assert.deepEqual(unreferenced, [{ name: "reconcile", from: "workqueue", to: "reconciler" }]);
});

test("a short name resolves only in the source's own namespace", async () => {
  const elsewhere = { ...withEnv(["URL", lit("http://reconciler")]), "reconciler.yaml": ksvc("reconciler", { namespace: "other" }) };
  const { references } = await lowerKn(knToml(), elsewhere);
  assert.deepEqual(references, [], "reconciler lives in another namespace, so the bare name is not it");
});

test("the kubernetes demo: its args name the database, which is the declared connection", async () => {
  const cluster = await parseTomlToCluster(DEMO_TOML);
  const opts = { bundles: cluster.bundles.map(checkableBundle), connections: cluster.connections, env: "local" };
  const { references, unreferenced } = lowerK8s({ ...opts, readManifest: (p) => MANIFESTS[p] });
  assert.deepEqual(references, [
    { bundle: "orders", container: "orders", where: "args", address: "dolt.dolt.svc.cluster.local:3306", to: "dolt", connections: ["orders-db"] },
  ]);
  assert.deepEqual(unreferenced, []);
  // The wrong port in the same argument fails the build; so does a peer with no declared edge.
  const edit = (from, to) => ({ ...MANIFESTS, "orders.yaml": MANIFESTS["orders.yaml"].replace(from, to) });
  assert.throws(
    () => lowerK8s({ ...opts, readManifest: (p) => edit("svc.cluster.local:3306", "svc.cluster.local:3307")[p] }),
    /bundle "orders" manifest orders.yaml: container "orders" args names dolt\.dolt\.svc\.cluster\.local:3307 \(bundle "dolt"\), but the declared connection "orders-db" reaches port 3306/,
  );
  assert.throws(
    () => lowerK8s({ ...opts, readManifest: (p) => ({ ...MANIFESTS, "dolt.yaml": MANIFESTS["dolt.yaml"].replace('value: "%"', 'value: "orders.orders.svc:50051"') })[p] }),
    /bundle "dolt" manifest dolt.yaml: container "dolt" env DOLT_ROOT_HOST names orders\.orders\.svc:50051 \(bundle "orders"\), but cluster.toml declares no connection from "dolt" to "orders"/,
  );
});

test("cluster k8s prints what the manifests' addresses say", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloister-kn-"));
  try {
    writeFileSync(join(root, "cluster.toml"), knToml());
    const manifests = withEnv(["RECONCILER_URL", lit("http://reconciler.platform.svc")], ["METRICS", lit("http://prometheus.monitoring.svc:9090")]);
    for (const [name, text] of Object.entries(manifests)) writeFileSync(join(root, name), text);
    const lines = [];
    const code = await clusterMain(["k8s", "--dir", root, "--env", "local", "--out", join(root, "out")], { log: (l) => lines.push(l), errLog: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(lines.slice(3), [
      'cloister cluster k8s: "workqueue" container "app" env RECONCILER_URL names reconciler.platform.svc:80: connection "reconcile"',
      'cloister cluster k8s: "workqueue" container "app" env METRICS names prometheus.monitoring.svc:9090, which is no bundle placed here; not checked',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── manifests as they really arrive (found by running real ones) ─────────
//
// `kubectl get ksvc -o yaml` wraps what it finds in a `v1` List, and one
// exported file usually holds a whole stack. Neither was read at first.

const asList = (...docs) => {
  const items = docs.flatMap((text) => parseAllDocuments(text).map((d) => d.toJS()).filter(Boolean));
  return `apiVersion: v1\nkind: List\nmetadata:\n  resourceVersion: ""\nitems: ${JSON.stringify(items)}\n`;
};
const shared = (file) => knToml().replaceAll('manifest = "workqueue.yaml"', `manifest = "${file}"`).replaceAll('manifest = "reconciler.yaml"', `manifest = "${file}"`);

test("a kubectl List export is unwrapped, and bundles sharing one file each take the Service with their name", async () => {
  const stack = asList(ksvc("workqueue", { env: [["RECONCILER_URL", lit("http://reconciler.platform.svc")]] }), ksvc("reconciler"));
  const { checked, references, unreferenced } = await lowerKn(shared("stack.yaml"), { "stack.yaml": stack });
  assert.deepEqual(checked.map((c) => `${c.bundle}=${c.service}`), ["workqueue=workqueue", "reconciler=reconciler"]);
  // The address is in workqueue's container. It is not also read as reconciler's
  // own, which would be reconciler naming itself and say nothing.
  assert.deepEqual(references.map((r) => `${r.bundle} -> ${r.to}`), ["workqueue -> reconciler"]);
  assert.deepEqual(unreferenced, []);
  // The same two services as plain documents in one file.
  const plain = await lowerKn(shared("stack.yaml"), { "stack.yaml": `${ksvc("workqueue")}---\n${ksvc("reconciler")}` });
  assert.deepEqual(plain.checked.map((c) => c.service), ["workqueue", "reconciler"]);
});

test("another bundle's container in a shared file is not read as this bundle's", async () => {
  // reconciler's container names workqueue. No connection is declared that
  // way round, so it is refused as reconciler's, not blamed on workqueue.
  const stack = `${ksvc("workqueue")}---\n${ksvc("reconciler", { env: [["CALLBACK", lit("http://workqueue.platform.svc")]] })}`;
  await assert.rejects(
    lowerKn(shared("stack.yaml"), { "stack.yaml": stack }),
    /bundle "reconciler" manifest stack.yaml: container "app" env CALLBACK names workqueue\.platform\.svc:80 \(bundle "workqueue"\), but cluster.toml declares no connection from "reconciler" to "workqueue"/,
  );
});

test("several Knative Services and none named after the bundle is refused, naming what is there", async () => {
  const stack = `${ksvc("workqueue")}---\n${ksvc("recon")}`;
  await assert.rejects(
    lowerKn(shared("stack.yaml"), { "stack.yaml": stack }),
    /bundle "reconciler" is placed "knative" and must declare exactly one Knative Service \(serving\.knative\.dev; found 2\)\. With several in one manifest, the one named "reconciler" is used, and none is \(found: "workqueue", "recon"\)/,
  );
  await assert.rejects(lowerKn(knToml(), { ...KN_MANIFESTS, "reconciler.yaml": "apiVersion: v1\nkind: List\n" }), /a List with no items/);
});

test("a kubernetes placement reads a List export too", async () => {
  const cluster = await parseTomlToCluster(DEMO_TOML);
  const wrapped = { "dolt.yaml": asList(MANIFESTS["dolt.yaml"]), "orders.yaml": asList(MANIFESTS["orders.yaml"]) };
  const { files, references } = lowerK8s({ bundles: cluster.bundles.map(checkableBundle), connections: cluster.connections, env: "local", readManifest: (p) => wrapped[p] });
  assert.equal(files.length, 6);
  assert.deepEqual(references.map((r) => r.connections), [["orders-db"]]);
});
