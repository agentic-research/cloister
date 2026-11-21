// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ADR-0083 §4: `cloister cluster up` resolves each compose image when it
// starts it, records it on the container, and prints a digest that moved.
// Against a fake engine; dev/compose-up-images.mjs runs the same against a
// real one.
//
// Run with: node --test cli/test/cluster/compose-up.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  IMAGE_LABELS, composeServices, composeUp, contentTag, engineFor, previousRecords, resolveRunImages, staleTags,
} from "../../lib/cluster/compose-up.mjs";
import { main } from "../../commands/cluster.mjs";

const hex = (c) => c.repeat(64);
const ID_A = `sha256:${hex("a")}`;
const ID_B = `sha256:${hex("b")}`;
const MANIFEST = `sha256:${hex("c")}`;

/**
 * An engine that holds `images` (ref → inspect row), can pull `pulls`
 * (ref → the row it then holds), and has `containers` (inspect rows). It
 * records every command it is asked to run.
 */
function engine({ images = {}, pulls = {}, containers = [] } = {}) {
  const held = new Map(Object.entries(images));
  const calls = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const no = (stderr) => ({ status: 1, stdout: "", stderr });
  const exec = (bin, args) => {
    calls.push([bin, ...args].join(" "));
    if (args[0] === "image" && args[1] === "inspect") {
      const row = held.get(args[2]);
      return row ? ok(JSON.stringify([row])) : no(`Error: No such image: ${args[2]}`);
    }
    if (args[0] === "pull") {
      const ref = args.at(-1);
      if (!pulls[ref]) return no(`Error response from daemon: pull access denied for ${ref}`);
      held.set(ref, pulls[ref]);
      return ok();
    }
    if (args[0] === "tag") {
      const id = args[1];
      held.set(args[2], { Id: id, RepoDigests: [] });
      return ok();
    }
    if (args[0] === "image" && args[1] === "rm") return held.delete(args[2]) ? ok(`Untagged: ${args[2]}`) : no("No such image");
    if (args[0] === "ps") return ok(containers.map((c) => c.Id).join("\n"));
    if (args[0] === "container" && args[1] === "inspect") return ok(JSON.stringify(containers));
    return no(`unexpected: ${args.join(" ")}`);
  };
  return { exec, calls, held };
}

test("the engine is the one the compose command drives", () => {
  assert.equal(engineFor(["docker", "compose"]), "docker");
  assert.equal(engineFor(["podman", "compose"]), "podman");
  assert.equal(engineFor(["nerdctl", "compose"]), "nerdctl");
  assert.equal(engineFor(["docker-compose"]), "docker");
  assert.equal(engineFor(["/usr/local/bin/docker-compose"]), "docker");
  assert.equal(engineFor(["podman-compose"]), "podman");
  // The knob `cloister artifacts pull` already reads names it for both.
  assert.equal(engineFor(["docker", "compose"], { CONTAINER_CMD: "nerdctl" }), "nerdctl");
});

test("a local build runs under a tag made from its image ID", () => {
  assert.equal(contentTag("cloister:0.1.0", ID_A), `cloister:sha256-${hex("a")}`);
  assert.equal(contentTag("bitnami/redis:7", ID_A), `bitnami/redis:sha256-${hex("a")}`);
  assert.equal(contentTag("localhost:5000/x:dev", ID_A), `localhost:5000/x:sha256-${hex("a")}`);
});

test("the compose file's services and project are read from it", () => {
  const { project, services } = composeServices("name: shop\nservices:\n  web:\n    image: web:1\n  db:\n    image: \"db@sha256:" + hex("d") + "\"\n  built:\n    build: .\n");
  assert.equal(project, "shop");
  assert.deepEqual(services, [{ service: "db", image: `db@sha256:${hex("d")}` }, { service: "web", image: "web:1" }]);
});

test("each image is resolved by what the engine holds, pinned by digest or ID", () => {
  // The API image came from a registry and carries its digest, as a local
  // build also does in docker's containerd image store. Both run by their ID.
  const e = engine({
    images: {
      [`ghcr.io/acme/db@${MANIFEST}`]: { Id: ID_B, RepoDigests: [`ghcr.io/acme/db@${MANIFEST}`] },
      "cloister:0.1.0": { Id: ID_A, RepoDigests: [] },
      "ghcr.io/acme/api:1.4": { Id: ID_B, RepoDigests: [`ghcr.io/acme/api@${MANIFEST}`] },
    },
  });
  const { resolved, failures } = resolveRunImages([
    { service: "db", image: `ghcr.io/acme/db@${MANIFEST}` },
    { service: "router", image: "cloister:0.1.0" },
    { service: "api", image: "ghcr.io/acme/api:1.4" },
  ], { exec: e.exec, engine: "docker" });
  assert.deepEqual(failures, []);
  assert.deepEqual(resolved, [
    { service: "db", image: `ghcr.io/acme/db@${MANIFEST}`, run: `ghcr.io/acme/db@${MANIFEST}`, digest: MANIFEST, by: "pinned" },
    { service: "router", image: "cloister:0.1.0", run: `cloister:sha256-${hex("a")}`, digest: ID_A, by: "id" },
    { service: "api", image: "ghcr.io/acme/api:1.4", run: `ghcr.io/acme/api:sha256-${hex("b")}`, digest: ID_B, by: "id" },
  ]);
  // What the engine holds is never pulled again.
  assert.ok(!e.calls.some((c) => c.startsWith("docker pull")), e.calls.join("\n"));
  assert.ok(e.calls.includes(`docker tag ${ID_A} cloister:sha256-${hex("a")}`));
});

test("an image that names a registry and is not held is pulled with the engine's credentials", () => {
  const e = engine({ pulls: { "ghcr.io/acme/api:1.4": { Id: ID_B, RepoDigests: [`ghcr.io/acme/api@${MANIFEST}`] } } });
  const { resolved, failures } = resolveRunImages([{ service: "api", image: "ghcr.io/acme/api:1.4" }], { exec: e.exec, engine: "docker" });
  assert.deepEqual(failures, []);
  assert.deepEqual(resolved, [{ service: "api", image: "ghcr.io/acme/api:1.4", run: `ghcr.io/acme/api:sha256-${hex("b")}`, digest: ID_B, by: "id" }]);
  assert.ok(e.calls.includes("docker pull --quiet ghcr.io/acme/api:1.4"));

  const denied = engine();
  const refused = resolveRunImages([{ service: "api", image: "ghcr.io/acme/api:1.4" }], { exec: denied.exec, engine: "docker" });
  assert.deepEqual(refused.resolved, []);
  assert.match(refused.failures[0], /image ghcr\.io\/acme\/api:1\.4 \(service api\) could not be pulled as ghcr\.io\/acme\/api:1\.4 \(.*pull access denied/);
});

test("an image written by digest that is not held is pulled by that digest alone", () => {
  // Compose pulls nothing (the emitter writes pull_policy: never), and a digest names one set of bytes.
  const pinned = `ghcr.io/acme/db:1@${MANIFEST}`;
  const e = engine({ pulls: { [`ghcr.io/acme/db@${MANIFEST}`]: { Id: ID_B, RepoDigests: [`ghcr.io/acme/db@${MANIFEST}`] } } });
  const { resolved, failures } = resolveRunImages([{ service: "db", image: pinned }], { exec: e.exec, engine: "docker" });
  assert.deepEqual(failures, []);
  assert.deepEqual(resolved, [{ service: "db", image: pinned, run: pinned, digest: MANIFEST, by: "pinned" }]);
  assert.ok(e.calls.includes(`docker pull --quiet ghcr.io/acme/db@${MANIFEST}`), e.calls.join("\n"));
});

test("a bare name that is not held is refused, and nothing is pulled or tagged for any service", () => {
  const e = engine({ images: { "cloister:0.1.0": { Id: ID_A, RepoDigests: [] } } });
  const { resolved, failures } = resolveRunImages([
    { service: "router", image: "cloister:0.1.0" },
    { service: "mache", image: "mache:0.8.0" },
    { service: "cache", image: "bitnami/redis:7" },
    { service: "api", image: "ghcr.io/acme/api:1.4" },
  ], { exec: e.exec, engine: "docker" });
  assert.deepEqual(resolved, []);
  assert.equal(failures.length, 2, failures.join("\n"));
  assert.match(failures[0], /image mache:0\.8\.0 \(service mache\) is not on this machine \(Error: No such image: mache:0\.8\.0\)\. It is a bare name, so cloister does not pull it: docker would fetch Docker Hub's library\/mache/);
  assert.match(failures[1], /Docker Hub's bitnami\/redis, an image anyone could publish/);
  assert.ok(!e.calls.some((c) => / (pull|tag) /.test(c)), e.calls.join("\n"));
});

test("podman's bare-hex image ID is read as a sha256 content address", () => {
  const e = engine({ images: { "cloister:0.1.0": { Id: hex("a"), RepoDigests: [] } } });
  const { resolved } = resolveRunImages([{ service: "router", image: "cloister:0.1.0" }], { exec: e.exec, engine: "podman" });
  assert.equal(resolved[0].digest, ID_A);
});

const recorded = (service, image, digest, by) => ({
  Id: `c-${service}`,
  Config: { Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": service, [IMAGE_LABELS.image]: image, [IMAGE_LABELS.digest]: digest, [IMAGE_LABELS.by]: by } },
});

test("the previous run's record is read back from its containers' labels", () => {
  const e = engine({ containers: [recorded("router", "cloister:0.1.0", ID_A, "id")] });
  const records = previousRecords({ exec: e.exec, engine: "docker", project: "shop" });
  assert.deepEqual([...records], [["router", { image: "cloister:0.1.0", digest: ID_A, by: "id" }]]);
  assert.ok(e.calls.includes("docker ps -a -q --filter label=com.docker.compose.project=shop"));
  assert.equal(previousRecords({ exec: e.exec, engine: "docker", project: null }).size, 0);
});

test("only a moved local build's old tag is stale", () => {
  const now = [{ service: "router", image: "cloister:0.1.0", run: `cloister:sha256-${hex("b")}`, digest: ID_B, by: "id" }];
  assert.deepEqual(staleTags(now, new Map([["router", { image: "cloister:0.1.0", digest: ID_A, by: "id" }]])), [`cloister:sha256-${hex("a")}`]);
  assert.deepEqual(staleTags(now, new Map([["router", { image: "cloister:0.1.0", digest: ID_B, by: "id" }]])), []);
  // A pinned image never ran under a tag cloister made.
  assert.deepEqual(staleTags(now, new Map([["router", { image: `ghcr.io/acme/r@${MANIFEST}`, digest: MANIFEST, by: "pinned" }]])), []);
});

function clusterDir(compose) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-compose-up-"));
  writeFileSync(join(dir, "cluster.compose.yaml"), compose);
  return dir;
}

const COMPOSE = "name: shop\nservices:\n  router:\n    image: cloister:0.1.0\n    labels:\n      - \"cloister.bundle=router\"\n";

/** A compose that exits `status`, keeping what it was started with and the override it read. */
function fakeCompose(status = 0) {
  const seen = {};
  const spawn = (bin, args, opts) => {
    Object.assign(seen, { bin, args, cwd: opts.cwd });
    const override = args[args.indexOf("-f", args.indexOf("-f") + 1) + 1];
    seen.override = override;
    seen.overrideText = readFileSync(override, "utf8");
    return { on: (event, cb) => { if (event === "close") queueMicrotask(() => cb(status)); } };
  };
  return { spawn, seen };
}

test("up starts the committed file with an override that pins and records each image, then cleans up", async () => {
  const root = clusterDir(COMPOSE);
  try {
    const e = engine({
      images: { "cloister:0.1.0": { Id: ID_B, RepoDigests: [] }, [`cloister:sha256-${hex("a")}`]: { Id: ID_A, RepoDigests: [] } },
      containers: [recorded("router", "cloister:0.1.0", ID_A, "id")],
    });
    const { spawn, seen } = fakeCompose(0);
    const logs = [];
    const file = join(root, "cluster.compose.yaml");
    const code = await composeUp({ root, file, compose: ["docker", "compose"], detach: true }, { exec: e.exec, spawn, log: (l) => logs.push(l), errLog: (l) => logs.push(l) });
    assert.equal(code, 0);
    // The committed file first, so the cluster root stays the project directory.
    assert.deepEqual(seen.args.slice(0, 4), ["compose", "-f", file, "-f"]);
    assert.deepEqual(seen.args.slice(5), ["up", "-d"]);
    assert.equal(seen.cwd, root);
    const override = parseYaml(seen.overrideText);
    assert.deepEqual(override.services.router, {
      image: `cloister:sha256-${hex("b")}`,
      labels: [`${IMAGE_LABELS.image}=cloister:0.1.0`, `${IMAGE_LABELS.digest}=${ID_B}`, `${IMAGE_LABELS.by}=id`],
    });
    assert.ok(logs.some((l) => l === `  router: cloister:0.1.0 runs as sha256:${"b".repeat(12)} (image ID, moved from sha256:${"a".repeat(12)})`), logs.join("\n"));
    // The run's directory goes when the run ends, and so does the old build's tag.
    assert.equal(existsSync(dirname(seen.override)), false);
    assert.ok(e.calls.includes(`docker image rm cloister:sha256-${hex("a")}`), e.calls.join("\n"));
    assert.ok(logs.some((l) => /removed cloister:sha256-a{64}, which an earlier build ran under/.test(l)), logs.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("up refuses before compose starts when an image cannot be resolved", async () => {
  const root = clusterDir(COMPOSE);
  try {
    const e = engine();
    let started = false;
    const errors = [];
    const code = await composeUp(
      { root, file: join(root, "cluster.compose.yaml"), compose: ["docker", "compose"], detach: false },
      { exec: e.exec, spawn: () => { started = true; }, log: () => {}, errLog: (l) => errors.push(l) },
    );
    assert.equal(code, 1);
    assert.equal(started, false);
    assert.match(errors.join("\n"), /image cloister:0\.1\.0 \(service router\) is not on this machine/);
    assert.match(errors.at(-1), /nothing was started/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`cloister cluster up` without --env goes through the resolution", async () => {
  const root = clusterDir(COMPOSE);
  try {
    const e = engine({ images: { "cloister:0.1.0": { Id: ID_A, RepoDigests: [] } } });
    const { spawn, seen } = fakeCompose(0);
    const code = await main(["up", "--dir", root, "-d"], { spawn, exec: e.exec, composeCmd: ["docker", "compose"], log: () => {}, errLog: () => {} });
    assert.equal(code, 0);
    assert.match(seen.overrideText, new RegExp(`image: cloister:sha256-${hex("a")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
