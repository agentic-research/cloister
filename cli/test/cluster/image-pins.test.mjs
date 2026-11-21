// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ADR-0083 §1–§3: every placement runs an image by the digest the lock pins.
//   - `cluster resolve` pins an operator image that names a registry, and
//     never looks up a bare name;
//   - compose and Kubernetes run the lock's digest;
//   - a committed render names each image it cannot pin.
//
// Run with: node --test cli/test/cluster/image-pins.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";

import { lockedImages, parseImageRef, pinnedImage, registryApi } from "../../lib/oci-artifact.mjs";
import { ResolutionFailedError, operatorImagesToPin, resolveClusterInputs } from "../../lib/cluster/resolve-inputs.mjs";
import { emitCompose } from "../../lib/cluster/emit-compose.mjs";
import { lowerDir } from "../../commands/cluster.mjs";
import { generateClusterArtifacts } from "../../lib/cluster/generate.mjs";

const DIGEST = `sha256:${"e".repeat(64)}`;
const quiet = { log: () => {}, errLog: () => {} };

function inDir(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "cloister-image-pins-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A registry that answers a manifest HEAD with `digest`, recording each URL it is asked. */
function registry(digest, status = 200) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() === "docker-content-digest" ? digest : null) } };
  };
  return { asked, fetchImpl };
}

const RESOLVE_TOML = `
[metadata]
name = "pins"
version = "0.1.0"

[[bundles]]
name = "api"
kind = "external"

[bundles.external]
image = "ghcr.io/acme/api:1.4"

[[bundles]]
name = "local"
kind = "external"

[bundles.external]
image = "cloister:0.1.0"

[[bundles]]
name = "implied-hub"
kind = "external"

[bundles.external]
image = "bitnami/redis:7"

[[bundles]]
name = "written"
kind = "external"

[bundles.external]
image = "ghcr.io/acme/db@${DIGEST}"

[[bundles]]
name = "cache"
kind = "external"

[bundles.external]
image = "docker.io/redis:7"

[[bundles]]
name = "edge"
kind = "external"

[bundles.external]
image = "ghcr.io/acme/edge"
`;

test("an image reference is split by Docker's rule", () => {
  const cases = [
    ["cloister:0.1.0", { registry: null, repository: "cloister", tag: "0.1.0", digest: null }],
    ["bitnami/redis:7", { registry: null, repository: "bitnami/redis", tag: "7", digest: null }],
    ["docker.io/redis:7", { registry: "docker.io", repository: "redis", tag: "7", digest: null }],
    ["localhost:5000/x:1", { registry: "localhost:5000", repository: "x", tag: "1", digest: null }],
    ["localhost/x", { registry: "localhost", repository: "x", tag: null, digest: null }],
    ["registry.k8s.io/e2e-test-images/agnhost:2.53", { registry: "registry.k8s.io", repository: "e2e-test-images/agnhost", tag: "2.53", digest: null }],
    [`ghcr.io/acme/db:1@${DIGEST}`, { registry: "ghcr.io", repository: "acme/db", tag: "1", digest: DIGEST }],
  ];
  for (const [ref, want] of cases) assert.deepEqual(parseImageRef(ref), want, ref);
  // Docker Hub's API is not at docker.io, and its one-component names are under library/.
  assert.deepEqual(registryApi("docker.io", "redis"), { host: "registry-1.docker.io", repository: "library/redis" });
  assert.deepEqual(registryApi("index.docker.io", "bitnami/redis"), { host: "registry-1.docker.io", repository: "bitnami/redis" });
  assert.deepEqual(registryApi("ghcr.io", "acme/api"), { host: "ghcr.io", repository: "acme/api" });
});

test("an image that names a registry is pinned; a bare or implied-Docker-Hub name never is", () => {
  const refs = operatorImagesToPin(parseToml(RESOLVE_TOML));
  assert.deepEqual([...refs], [
    ["ghcr.io/acme/api:1.4", ["api"]],
    ["docker.io/redis:7", ["cache"]],
    ["ghcr.io/acme/edge", ["edge"]],
  ]);
  // A bare name would be read as Docker Hub's library/cloister, which anyone could publish.
  assert.equal(parseImageRef("cloister:0.1.0").registry, null);
  assert.equal(parseImageRef("bitnami/redis:7").registry, null);
});

test("cluster resolve records the registry's digest in [[images]], asking only that registry", async () => {
  await inDir({ "cluster.toml": RESOLVE_TOML }, async (dir) => {
    const { asked, fetchImpl } = registry(DIGEST);
    await resolveClusterInputs({ root: dir, fetchImpl, env: {}, ...quiet });
    const lock = parseToml(readFileSync(join(dir, "cluster.lock.toml"), "utf8"));
    assert.deepEqual(lock.images.map((row) => ({ ...row })), [
      { ref: "docker.io/redis:7", digest: DIGEST },
      { ref: "ghcr.io/acme/api:1.4", digest: DIGEST },
      { ref: "ghcr.io/acme/edge", digest: DIGEST },
    ]);
    // Docker Hub is asked where Docker asks, and an image with no tag is `latest`.
    assert.deepEqual(asked, [
      "https://registry-1.docker.io/v2/library/redis/manifests/7",
      "https://ghcr.io/v2/acme/api/manifests/1.4",
      "https://ghcr.io/v2/acme/edge/manifests/latest",
    ]);
  });
});

test("an operator image the registry does not resolve is refused by name, and no lock is written", async () => {
  await inDir({ "cluster.toml": RESOLVE_TOML }, async (dir) => {
    const errors = [];
    await assert.rejects(
      resolveClusterInputs({ root: dir, fetchImpl: registry(null, 404).fetchImpl, env: {}, log: () => {}, errLog: (m) => errors.push(m) }),
      (e) => e instanceof ResolutionFailedError && /3 image\(s\) could not be pinned/.test(e.message),
    );
    assert.ok(errors.some((m) => /image ghcr\.io\/acme\/api:1\.4 \(bundle api\) has no digest: the registry probe returned "absent"/.test(m)), errors.join("\n"));
    assert.throws(() => readFileSync(join(dir, "cluster.lock.toml")), /ENOENT/);
  });
});

function composeCluster(image) {
  return {
    metadata: { name: "test", version: "0.0.1" },
    bundles: [{
      name: "cloister-router",
      description: "Test router",
      tier: "hypervisor",
      holdsCredential: [],
      workerdServiceName: "cloister",
      hypervisorRationale: "test",
      kind: { external: { image, ipcSocket: "/run/cloister-uds/router.sock", httpPort: 8787, args: [], env: [] } },
    }],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: {
      metadata: { name: "", version: "" },
      actor: { fingerprint: "", algorithm: "", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
      policy: { maxCertLifetimeSeconds: 0, requireInterlock: false, minAlgorithm: "" },
    },
    edges: [],
  };
}

test("compose runs the lock's digest for an operator image, and its header names an image it cannot pin", () => {
  const images = lockedImages({ images: [{ ref: "ghcr.io/acme/router:1.4", digest: DIGEST }] });
  const pinned = emitCompose(composeCluster("ghcr.io/acme/router:1.4"), new Map(), { images, warn: () => {} });
  assert.match(pinned, new RegExp(`\\n    image: ghcr\\.io/acme/router:1\\.4@${DIGEST}\\n`));
  assert.doesNotMatch(pinned, /Not pinned by digest/);

  const local = emitCompose(composeCluster("cloister:0.1"), new Map(), { images, warn: () => {} });
  assert.match(local, /\n {4}image: cloister:0\.1\n/);
  assert.match(local, /# Not pinned by digest, so each runs whatever its tag names when compose starts it \(ADR-0083\):\n# {3}- cloister:0\.1 \(cloister-router\)\n/);
});

const LOWER_TOML = `
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

[[bundles.placements]]
env = "local"
kind = "kubernetes"
manifest = "orders.yaml"
`;

test("a lowered Kubernetes workload runs the lock's digest, and says whether its image is pinned", async () => {
  const lock = `schema = "cloister/lockfile/v1"\n\n[[images]]\nref = "example.com/orders:1"\ndigest = "${DIGEST}"\n`;
  await inDir({ "cluster.toml": LOWER_TOML, "cluster.lock.toml": lock }, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const manifest = readFileSync(join(dir, "orders.yaml"), "utf8");
    assert.match(manifest, new RegExp(`image: example\\.com/orders:1@${DIGEST}`));
    assert.match(manifest, /# Its image runs by the digest cluster\.lock\.toml pins \(ADR-0083\)\./);
  });
  await inDir({ "cluster.toml": LOWER_TOML }, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const manifest = readFileSync(join(dir, "orders.yaml"), "utf8");
    assert.match(manifest, /image: example\.com\/orders:1\n/);
    assert.match(manifest, /# Its image example\.com\/orders:1 is not pinned by digest/);
  });
});

test("a declaration's own digest is used as written, by every placement", async () => {
  assert.equal(pinnedImage(`ghcr.io/acme/db@${DIGEST}`), `ghcr.io/acme/db@${DIGEST}`);
  const out = emitCompose(composeCluster(`ghcr.io/acme/db@${DIGEST}`), new Map(), { warn: () => {} });
  assert.match(out, new RegExp(`\\n    image: ghcr\\.io/acme/db@${DIGEST}\\n`));
  assert.doesNotMatch(out, /Not pinned by digest/);
  await inDir({ "cluster.toml": LOWER_TOML.replace("example.com/orders:1", `example.com/orders@${DIGEST}`) }, async (dir) => {
    await lowerDir({ root: dir, env: "local" });
    const manifest = readFileSync(join(dir, "orders.yaml"), "utf8");
    assert.match(manifest, new RegExp(`image: example\\.com/orders@${DIGEST}\\n`));
    assert.match(manifest, /# Its image runs by the digest cluster\.toml writes \(ADR-0083\)\./);
  });
});

test("cluster resolve, then cluster generate: the committed compose file runs the pinned operator image", async () => {
  // The path a user takes. Pins once reached emit-compose's own main and not
  // `cluster generate`, which writes the committed file and runs the drift check.
  const toml = `
[metadata]
name = "pins"
version = "0.1.0"

[storage]

[[bundles]]
name = "api"
kind = "external"
tier = "cluster"

[bundles.external]
image = "ghcr.io/acme/api:1.4"

[[bundles]]
name = "local"
kind = "external"
tier = "cluster"

[bundles.external]
image = "cloister:0.1.0"
`;
  await inDir({ "cluster.toml": toml }, async (dir) => {
    await resolveClusterInputs({ root: dir, fetchImpl: registry(DIGEST).fetchImpl, env: {}, ...quiet });
    await generateClusterArtifacts({ root: dir, env: {}, warn: () => {} });
    const compose = readFileSync(join(dir, "cluster.compose.yaml"), "utf8");
    assert.match(compose, new RegExp(`\\n    image: ghcr\\.io/acme/api:1\\.4@${DIGEST}\\n`));
    assert.match(compose, /# Not pinned by digest[^\n]*\n# {3}- cloister:0\.1\.0 \(local\)\n# `cloister cluster resolve`/);
    // And the drift check agrees with what generate wrote.
    const check = await generateClusterArtifacts({ root: dir, env: {}, check: true, warn: () => {} });
    assert.deepEqual(check.changed, []);
  });
});
