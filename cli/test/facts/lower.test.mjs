// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister cluster lower`: a rendered plan lowered to local Kubernetes
// manifests (ADR-0074 §5.3). Every test runs on the plan fixture the real tool
// wrote (test/fixtures/terraform/google-plan.show.json, from google-plan.tf).

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

import { emitK8sDir, main as clusterMain } from "../../commands/cluster.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { GOOGLE_MAPPING, GOOGLE_SPEC } from "../../lib/facts/cloudflare.mjs";
import { importFacts } from "../../lib/facts/import.mjs";
import { lowerCluster } from "../../lib/facts/lower.mjs";
import { buildReport } from "../../lib/facts/report.mjs";
import { configuredRows } from "../../lib/facts/terraform.mjs";
import { validateMapping } from "../../lib/facts/validate.mjs";

const PLAN = fileURLToPath(new URL("../../../test/fixtures/terraform/google-plan.show.json", import.meta.url));
const plan = () => JSON.parse(readFileSync(PLAN, "utf8"));
const lowered = () => lowerCluster(importFacts(plan()), { from: "prod", to: "local", name: "fixture" });
const objectsOf = (yaml) => parseAllDocuments(yaml).map((d) => d.toJS());
const containerOf = (files, bundle) => {
  const workload = objectsOf(files[`${bundle}.yaml`]).find((o) => o.kind === "Deployment" || o.kind === "Job");
  return workload.spec.template.spec.containers[0];
};

function inTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "cluster-lower-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a service becomes a Deployment and a Service, a job becomes a Job", () => {
  const { files } = lowered();
  assert.deepEqual(Object.keys(files).sort(), ["cluster.toml", "reconciler.yaml", "sweep.yaml", "workqueue.yaml"]);
  assert.deepEqual(objectsOf(files["reconciler.yaml"]).map((o) => o.kind), ["Deployment", "Service"]);
  assert.deepEqual(objectsOf(files["sweep.yaml"]).map((o) => o.kind), ["Job"]);
  const service = objectsOf(files["reconciler.yaml"])[1];
  assert.deepEqual(service.spec.ports, [{ name: "h2c", port: 8080, targetPort: 8080, appProtocol: "art.http2" }]);
  assert.equal(service.metadata.namespace, "reconciler");
});

test("env is sorted: a constant is carried, an address is rewritten, a secret is referenced, a variable is not written", () => {
  const { files, notes } = lowered();
  // Read from the configuration: the provider marks this whole env block
  // sensitive in the planned values, because one element of it is.
  assert.deepEqual(containerOf(files, "workqueue").env, [
    { name: "RECONCILER_URL", value: "http://reconciler.reconciler.svc.cluster.local:8080" },
    { name: "LOG_LEVEL", value: "info" },
    { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db-password", key: "latest" } } },
  ]);
  assert.deepEqual(containerOf(files, "workqueue").args, ["--workers", "4"]);
  assert.deepEqual(containerOf(files, "sweep").env, [{ name: "TARGET", value: "http://reconciler.reconciler.svc.cluster.local:8080" }]);
  // What is not written is named, with where it comes from, in the file and in the notes.
  assert.match(files["workqueue.yaml"], /# NOT in this file, because the plan does not hold it:\n# {3}- env API_TOKEN: taken from var\.api_token, which this plan does not resolve\n/);
  assert.match(files["workqueue.yaml"], /# {3}- the VALUE of env DB_PASSWORD: create Secret "db-password" with key "latest" in namespace "workqueue"/);
  assert.match(files["workqueue.yaml"], /# Rewritten for this cluster:\n# {3}- env RECONCILER_URL: the address of "reconciler"/);
  assert.ok(notes.some((n) => n === '"workqueue": not written: env API_TOKEN: taken from var.api_token, which this plan does not resolve'));
});

test("no sensitive value reaches any file, and the printed report never carries what a workload is started with", () => {
  const { files } = lowered();
  assert.ok(readFileSync(PLAN, "utf8").includes("FIXTURE-SENSITIVE-VALUE"));
  for (const [path, content] of Object.entries(files)) assert.ok(!content.includes("FIXTURE-SENSITIVE-VALUE"), path);
  const report = JSON.stringify(buildReport(importFacts(plan()), undefined));
  assert.ok(!report.includes('"run"') && !report.includes("--workers") && !report.includes("LOG_LEVEL"));
});

test("the plan's access rows are stated beside the local rule that replaces them", () => {
  const { files } = lowered();
  assert.match(files["reconciler.yaml"], /# In the plan, these may call it: invoker serviceAccount:workqueue@example-project\.iam\.gserviceaccount\.com\.\n# Here, `cluster k8s` admits only its declared callers: workqueue, sweep\.\n/);
});

test("what lower writes is accepted by the parser and by cluster k8s, which ties each rewritten address to a declared connection", async () => {
  await inTempDir(async (dir) => {
    for (const [path, content] of Object.entries(lowered().files)) writeFileSync(join(dir, path), content);
    const cluster = await parseTomlToCluster(readFileSync(join(dir, "cluster.toml"), "utf8"));
    assert.deepEqual(cluster.bundles.map((b) => b.placements.map((p) => `${p.env}:${p.kind}`)), Array(3).fill(["prod:cloudRun", "local:kubernetes"]));
    const written = await emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") });
    // The same check an operator's manifest gets: each address names a bundle, on a declared connection.
    assert.deepEqual(written.references.map((r) => [r.bundle, r.where, r.to, r.connections]), [
      ["workqueue", "env RECONCILER_URL", "reconciler", ["reconciler"]],
      ["sweep", "env TARGET", "reconciler", ["reconciler"]],
    ]);
    assert.deepEqual(written.unreferenced, []);
    assert.ok(written.files.includes("reconciler/20-networkpolicy.yaml"));
    // The plan itself still evidences every connection for the env it describes.
    const findings = buildReport(importFacts(plan()), cluster, { env: "prod" }).findings.filter((f) => f.connection);
    assert.deepEqual(findings.map((f) => f.kind), ["evidenced", "evidenced"]);
  });
});

test("a bundle that exposes no port needs no Service; one that does still needs exactly one", async () => {
  await inTempDir(async (dir) => {
    const files = lowered().files;
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    // sweep is a Job with no port and no Service: accepted above. Take reconciler's Service away:
    writeFileSync(join(dir, "reconciler.yaml"), files["reconciler.yaml"].split("---\n")[0]);
    await assert.rejects(emitK8sDir({ root: dir, env: "local", out: join(dir, "k8s") }), /bundle "reconciler" must declare exactly one core v1 Service \(found 0\)/);
  });
});

test("a state document is refused: it does not say where a value is taken from", () => {
  const state = { format_version: "1.0", values: { root_module: { resources: [] } } };
  assert.throws(() => lowerCluster(importFacts(state), { from: "prod", to: "local" }), /lowering needs a rendered PLAN/);
  assert.throws(() => lowerCluster(importFacts(plan()), { from: "prod", to: "prod" }), /--from and --to are both "prod"/);
});

test("an address whose target has no drafted connection is not written, and says so", () => {
  const doc = plan();
  // Point workqueue at the job instead: a job listens on nothing, so there is
  // no port to draft a connection to and no address to rewrite to.
  const workqueue = doc.configuration.root_module.resources.find((r) => r.address === "google_cloud_run_v2_service.workqueue");
  Object.assign(workqueue, JSON.parse(JSON.stringify(workqueue).replaceAll("google_cloud_run_v2_service.reconciler", "google_cloud_run_v2_job.sweep")));
  const { files } = lowerCluster(importFacts(doc), { from: "prod", to: "local" });
  assert.match(files["workqueue.yaml"], /# {3}- env RECONCILER_URL: the address of "sweep" \(Cloud Run jobs\), which has no drafted connection to rewrite it to/);
  assert.ok(!containerOf(files, "workqueue").env.some((e) => e.name === "RECONCILER_URL"));
});

test("configuredRows reads constants and what a value is taken from, never a planned value", () => {
  const expressions = { template: [{ containers: [{ env: [
    { name: { constant_value: "A" }, value: { constant_value: "x" } },
    { name: { constant_value: "B" }, value: { references: ["t.n.attr", "t.n", "var.v"] } },
    { name: { constant_value: "C" }, value_source: [{ secret_key_ref: [{ secret: { constant_value: "s" } }] }] },
    { name: { constant_value: "D" }, value: { constant_value: ["not", "a", "scalar"] } },
  ] }] }] };
  assert.deepEqual(configuredRows(expressions, "template.containers.env", ["name", "value", "value_source.secret_key_ref.secret"]), [
    { name: { constant: "A" }, value: { constant: "x" } },
    { name: { constant: "B" }, value: { references: ["t.n"], unresolved: ["var.v"] } },
    { name: { constant: "C" }, "value_source.secret_key_ref.secret": { constant: "s" } },
    { name: { constant: "D" } },
  ]);
  assert.deepEqual(configuredRows({}, "template.containers.env", ["name"]), []);
});

test("the mapping's configured fields and run keys are held to the provider spec", () => {
  const edited = (edit) => {
    const mapping = structuredClone(GOOGLE_MAPPING);
    edit(mapping.types.google_cloud_run_v2_service);
    return () => validateMapping(mapping, GOOGLE_SPEC);
  };
  edited(() => {})();
  assert.throws(edited((e) => { e.configLists[0].fields.push("nope"); }), /unknown attribute "google_cloud_run_v2_service\.template\.containers\.env\.nope"/);
  assert.throws(edited((e) => { e.report.bundle.runs = "daemon"; }), /"runs" must be "service" or "job"/);
  assert.throws(edited((e) => { e.report.bundle.env.value = "other"; }), /env value "other" is not a field of configured list "env"/);
  assert.throws(edited((e) => { e.report.bundle.args.strings = "image"; }), /bundle args needs a "list" the entry reads and a "strings" attribute/);
});

test("cluster lower writes into a new directory only, refuses a tracked plan, and names what it needs", async () => {
  await inTempDir(async (dir) => {
    cpSync(PLAN, join(dir, "plan.json"));
    const run = async (args, deps = {}) => {
      const lines = [];
      const code = await clusterMain(["lower", ...args], { log: (l) => lines.push(l), errLog: (l) => lines.push(l), isGitTracked: () => false, ...deps });
      return { code, text: lines.join("\n") };
    };
    const args = ["--terraform", join(dir, "plan.json"), "--from", "prod", "--to", "local", "--out", join(dir, "out")];
    const ok = await run(args);
    assert.equal(ok.code, 0, ok.text);
    assert.deepEqual(readdirSync(join(dir, "out")).sort(), ["cluster.toml", "reconciler.yaml", "sweep.yaml", "workqueue.yaml"]);
    assert.match(ok.text, /3 bundles, 2 connections, for env "local"/);
    assert.match(ok.text, /next: cloister cluster k8s --dir .* --env local --out /);
    // A second run would replace files someone may have edited.
    const again = await run(args);
    assert.equal(again.code, 2);
    assert.match(again.text, /is not empty\. Lowered files are meant to be edited, so they are never overwritten/);
    assert.match((await run(args.slice(0, 6))).text, /--out <dir> is required/);
    assert.match((await run(["--terraform", join(dir, "plan.json"), "--to", "local", "--out", join(dir, "o2")])).text, /--from <env> is required/);
    assert.match((await run([...args.slice(0, 6), "--out", join(dir, "o3")], { isGitTracked: () => true })).text, /is tracked by git/);
  });
});
