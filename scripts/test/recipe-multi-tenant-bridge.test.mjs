import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";

const recipeUrl = new URL("../../recipes/multi-tenant-smoke/cluster.toml", import.meta.url);
const fixtureUrl = new URL("../../test/fixtures/multi-tenant-smoke.gateway.json", import.meta.url);

function gatewayFixtureFrom(cluster) {
  const route = cluster.routes.find((candidate) => "tenantDispatch" in candidate.kind);
  assert.ok(route, "the recipe must declare a tenantDispatch route");

  return {
    metadata: { name: "recipe-instantiate-test", version: "0.0.0" },
    routes: [route],
    actor: {
      fingerprint: "",
      algorithm: "ed25519",
      pubkeyBinding: "",
      attestationRepo: "",
      tunnelEndpoint: "",
    },
    policy: {
      maxCertLifetimeSeconds: 300,
      requireInterlock: false,
      minAlgorithm: "ed25519",
    },
  };
}

test("the workerd fixture is the validated multi-tenant recipe", async () => {
  const [toml, fixtureText] = await Promise.all([
    readFile(recipeUrl, "utf8"),
    readFile(fixtureUrl, "utf8"),
  ]);
  const cluster = await parseTomlToCluster(toml);
  const fixture = JSON.parse(fixtureText);

  assert.equal(cluster.metadata.name, "cloister-multi-tenant-smoke");
  assert.equal(cluster.bundles.length, 3);
  assert.equal(cluster.routes.length, 2);
  assert.deepEqual(fixture, gatewayFixtureFrom(cluster));
});
