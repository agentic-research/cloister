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
import { emitK8s } from "../../cli/lib/cluster/emit-k8s.mjs";
import { meetStrength, strengthOf } from "../../cli/lib/cluster/connections.mjs";
import { emitK8sDir } from "../../cli/commands/cluster.mjs";
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
    /kind "nomad" is not one of microvm, workerd, kubernetes, cloudRun/],
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
    /bundle "dolt" must declare exactly one Service \(found 2\)/],
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
    /bundle "dolt" is the target of connection "orders-db" but is placed "cloudRun" for env "local"; a channel end must be placed microvm or kubernetes/,
  );
});

test("an exposed port on a bundle with no microvm or kubernetes placement fails the build", async () => {
  const t = placeAs(DEMO_TOML, "dolt.yaml", `[[bundles.placements]]\nenv = "local"\nkind = "cloudRun"\n`);
  await assert.rejects(
    parseTomlToCluster(t),
    /bundle "dolt" exposes port "mysql" but has no placement of kind microvm or kubernetes \(declared: cloudRun\)/,
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
    await assert.rejects(emitK8sDir({ root: DEMO, env: "gcp", out }), /no bundle is placed "kubernetes" for env "gcp"/);
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
