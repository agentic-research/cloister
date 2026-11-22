// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ADR-0083 §5: `--locked` starts or applies only a digest cluster.toml writes
// or cluster.lock.toml pins, and refuses the rest by name before anything
// starts or is written. It asks no registry what a tag names today.
//
// Run with: node --test cli/test/cluster/locked.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { composeServices, composeUp, lockedProblems } from "../../lib/cluster/compose-up.mjs";
import { lockedManifestProblems } from "../../lib/cluster/emit-k8s.mjs";
import { containerImages } from "../../lib/cluster/manifest-addresses.mjs";
import { generateClusterArtifacts } from "../../lib/cluster/generate.mjs";
import { lowerDir, main } from "../../commands/cluster.mjs";

const hex = (c) => c.repeat(64);
const A = `sha256:${hex("a")}`;
const B = `sha256:${hex("b")}`;
const quiet = { log: () => {}, errLog: () => {} };

async function inDir(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-locked-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bundle = (name, image) => `
[[bundles]]
name = "${name}"
kind = "external"
tier = "cluster"

[bundles.external]
image = "${image}"
`;
const toml = (...bundles) => `[metadata]\nname = "locked"\nversion = "0.1.0"\n\n[storage]\n${bundles.join("")}`;
const lock = (rows) => `schema = "cloister/lockfile/v1"\n${rows.map(([ref, digest]) => `\n[[images]]\nref = "${ref}"\ndigest = "${digest}"\n`).join("")}`;

/** Generate the committed compose file as `cluster generate` does, and return its services. */
async function committed(dir) {
  await generateClusterArtifacts({ root: dir, env: {}, warn: () => {} });
  return composeServices(readFileSync(join(dir, "cluster.compose.yaml"), "utf8")).services;
}

test("compose: every image pinned, by the declaration or the lock, and rendered as committed, passes", async () => {
  await inDir({ "cluster.toml": toml(bundle("api", "ghcr.io/acme/api:1.4"), bundle("db", `ghcr.io/acme/db@${B}`)), "cluster.lock.toml": lock([["ghcr.io/acme/api:1.4", A]]) }, async (dir) => {
    assert.deepEqual(await lockedProblems({ root: dir, committed: await committed(dir) }), []);
  });
});

test("compose: an image with no digest is refused by name, and a local build has no pin to give it", async () => {
  await inDir({ "cluster.toml": toml(bundle("api", "ghcr.io/acme/api:1.4"), bundle("router", "cloister:0.1.0")), "cluster.lock.toml": lock([["ghcr.io/acme/api:1.4", A]]) }, async (dir) => {
    const problems = await lockedProblems({ root: dir, committed: await committed(dir) });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^image cloister:0\.1\.0 \(service router\) is not pinned by digest\. --locked starts only a digest cluster\.toml writes or cluster\.lock\.toml pins/);
  });
});

test("compose: a committed file the lock has moved on from is refused, which is the lock out of date with the declaration", async () => {
  await inDir({ "cluster.toml": toml(bundle("api", "ghcr.io/acme/api:1.4")), "cluster.lock.toml": lock([["ghcr.io/acme/api:1.4", A]]) }, async (dir) => {
    const services = await committed(dir);
    writeFileSync(join(dir, "cluster.lock.toml"), lock([["ghcr.io/acme/api:1.4", B]]));
    const problems = await lockedProblems({ root: dir, committed: services });
    assert.deepEqual(problems, [
      `service api runs ghcr.io/acme/api:1.4@${A}, but cluster.toml and cluster.lock.toml render ghcr.io/acme/api:1.4@${B}. Run \`cloister cluster generate\` (ADR-0083 §5)`,
    ]);
  });
});

test("compose: a locked run is refused without cluster.toml to check against", async () => {
  await inDir({}, async (dir) => {
    const problems = await lockedProblems({ root: dir, committed: [] });
    assert.match(problems[0], /--locked checks cluster\.compose\.yaml against cluster\.toml and cluster\.lock\.toml, and .* has no cluster\.toml/);
  });
});

test("compose: a refused locked run asks the engine nothing and starts nothing", async () => {
  await inDir({ "cluster.toml": toml(bundle("router", "cloister:0.1.0")) }, async (dir) => {
    await committed(dir);
    const asked = [];
    let started = false;
    const errors = [];
    const code = await composeUp(
      { root: dir, file: join(dir, "cluster.compose.yaml"), compose: ["docker", "compose"], detach: true, locked: true },
      { exec: (bin, args) => { asked.push([bin, ...args].join(" ")); return { status: 1, stdout: "", stderr: "" }; }, spawn: () => { started = true; }, log: () => {}, errLog: (l) => errors.push(l), env: {} },
    );
    assert.equal(code, 1);
    assert.equal(started, false);
    assert.deepEqual(asked, [], "a locked refusal is decided from the files alone");
    assert.match(errors.join("\n"), /image cloister:0\.1\.0 \(service router\) is not pinned by digest/);
    assert.equal(errors.at(-1), "cloister cluster up: nothing was started");
  });
});

test("kubernetes: every init and app container's image is read, from every workload kind", () => {
  const objects = [
    { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" }, spec: { template: { spec: {
      initContainers: [{ name: "migrate", image: "ghcr.io/acme/migrate:1" }],
      containers: [{ name: "web", image: `ghcr.io/acme/web:1@${A}` }],
    } } } },
    { apiVersion: "batch/v1", kind: "CronJob", metadata: { name: "nightly" }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "job", image: "busybox" }] } } } } } },
    { apiVersion: "v1", kind: "Service", metadata: { name: "web" }, spec: {} },
  ];
  assert.deepEqual(containerImages(objects), [
    { workload: 'Deployment "web"', container: "migrate", image: "ghcr.io/acme/migrate:1" },
    { workload: 'Deployment "web"', container: "web", image: `ghcr.io/acme/web:1@${A}` },
    { workload: 'CronJob "nightly"', container: "job", image: "busybox" },
  ]);
});

test("kubernetes: an image with no digest, or a digest other than the lock's pin for its bundle, is refused", () => {
  const manifests = [{ bundle: "web", path: "web.yaml", images: [
    { workload: 'Deployment "web"', container: "web", image: `ghcr.io/acme/web:1@${A}` },
    { workload: 'Deployment "web"', container: "proxy", image: `ghcr.io/acme/proxy@${B}` },
    { workload: 'Deployment "web"', container: "debug", image: "busybox:1" },
  ] }];
  const declared = new Map([["web", "ghcr.io/acme/web:1"]]);
  assert.deepEqual(lockedManifestProblems({ manifests, declared, images: new Map([["ghcr.io/acme/web:1", A]]) }), [
    'web.yaml: Deployment "web" container "debug" runs busybox:1, which is not pinned by digest. --locked applies only a digest cluster.toml writes or cluster.lock.toml pins (ADR-0083 §5)',
  ]);
  const moved = lockedManifestProblems({ manifests: [{ ...manifests[0], images: manifests[0].images.slice(0, 2) }], declared, images: new Map([["ghcr.io/acme/web:1", B]]) });
  assert.deepEqual(moved, [
    `web.yaml: Deployment "web" container "web" runs ghcr.io/acme/web:1@${A}, but cluster.lock.toml pins ghcr.io/acme/web:1@${B} for bundle "web". Lower it again, or update the manifest (ADR-0083 §5)`,
  ]);
});

const LOWER = `[metadata]
name = "shop"
version = "0.1.0"

[storage]

[[bundles]]
name = "orders"
kind = "external"
tier = "cluster"

[bundles.external]
image = "example.com/orders:1"

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "orders.yaml"
`;

test("`cluster k8s --locked` refuses a manifest lowered before its image was pinned, and writes nothing", async () => {
  await inDir({ "cluster.toml": LOWER }, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const out = join(dir, "out");
    const errors = [];
    assert.equal(await main(["k8s", "--out", out, "--dir", dir, "--locked"], { log: () => {}, errLog: (l) => errors.push(l) }), 1);
    assert.match(errors[0], /^cloister cluster k8s: orders\.yaml: Deployment "orders" container "orders" runs example\.com\/orders:1, which is not pinned by digest/);
    assert.equal(errors.at(-1), "cloister cluster k8s: nothing was written");
    assert.equal(existsSync(out) && readdirSync(out).length > 0, false);

    // Pinned and lowered again, it applies.
    writeFileSync(join(dir, "cluster.lock.toml"), lock([["example.com/orders:1", A]]));
    rmSync(join(dir, "orders.yaml"));
    await lowerDir({ root: dir, env: "local" });
    mkdirSync(out, { recursive: true });
    assert.equal(await main(["k8s", "--out", out, "--dir", dir, "--locked"], quiet), 0);
    assert.ok(readdirSync(out).length > 0);
  });
});
