// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

import {
  buildLaunchPlan,
  parsePlanArgs,
  planFromToml,
} from "../../cli/commands/runtime-plan.mjs";
import { parseTomlToCluster } from "../../cli/lib/cluster/toml-to-cluster.mjs";

// buildLaunchPlan takes a VALIDATED cluster (cloister-991e65: runtime plan
// parses cluster.toml through parseTomlToCluster first), so the fixture is
// TOML run through that pipeline rather than a hand-built object.
const CLUSTER_TOML = `
[metadata]
name = "plan-fixture"
version = "0.0.1"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "mache"
kind = "external"
tier = "cluster"

[bundles.external]
entryPoint = "/usr/bin/mache"
executionMode = "microvm"
args = ["serve", "--http", "127.0.0.1:7532", "/workspace"]

[bundles.confinement.port]
bind = 7532
address = "127.0.0.1"

[[bundles.confinement.fs.allow]]
path = "/workspace"
mode = "rw"
`;
const cluster = await parseTomlToCluster(CLUSTER_TOML);

const lock = {
  inputs: {
    mache: {
      oci: {
        identifier: "ghcr.io/agentic-research/mache",
        version: "v0.17.0",
        digest: `sha256:${"8".repeat(64)}`,
      },
    },
  },
};

test("buildLaunchPlan lowers the exact manifest policy and locked artifact", () => {
  const plan = buildLaunchPlan(cluster, lock, {
    bundle: "mache",
    workspace: "/Users/operator/src",
    controlSocket: "/tmp/cloister/mache.sock",
  });

  assert.deepEqual(plan, {
    schema: "cloister/host-runtime/v1",
    bundle: "mache",
    mode: "microvm",
    artifact: {
      image: "ghcr.io/agentic-research/mache",
      digest: `sha256:${"8".repeat(64)}`,
      entrypoint: "/usr/bin/mache",
      args: ["serve", "--http", "127.0.0.1:7532", "/workspace"],
    },
    confinement: cluster.bundles[0].confinement,
    workspace: "/Users/operator/src",
    controlSocket: "/tmp/cloister/mache.sock",
  });
});

test("buildLaunchPlan refuses a mutable OCI tag", () => {
  const mutable = structuredClone(lock);
  delete mutable.inputs.mache.oci.digest;
  assert.throws(
    () => buildLaunchPlan(cluster, mutable, {
      bundle: "mache",
      workspace: "/workspace",
      controlSocket: "/tmp/mache.sock",
    }),
    /immutable sha256 digest/,
  );
});

test("buildLaunchPlan refuses missing operator entrypoint instead of guessing", () => {
  const missing = structuredClone(cluster);
  missing.bundles[0].kind.external.entryPoint = "";
  assert.throws(
    () => buildLaunchPlan(missing, lock, {
      bundle: "mache",
      workspace: "/workspace",
      controlSocket: "/tmp/mache.sock",
    }),
    /entryPoint/,
  );
});

test("parsePlanArgs requires explicit bundle and absolute workspace", () => {
  assert.deepEqual(
    parsePlanArgs([
      "mache",
      "--workspace", "/repo",
      "--control-socket", "/tmp/mache.sock",
      "--output", "/tmp/plan.json",
    ]),
    {
      bundle: "mache",
      workspace: "/repo",
      controlSocket: "/tmp/mache.sock",
      output: "/tmp/plan.json",
      env: "local",
      channelDir: "/tmp/cloister-host-runtime/ch",
    },
  );
  assert.throws(() => parsePlanArgs(["mache", "--workspace", "relative"]), /absolute/);
  assert.throws(
    () => parsePlanArgs(["mache", "--workspace", "/repo/../secret"]),
    /canonical/,
  );
});

test("buildLaunchPlan rejects non-canonical guest paths instead of normalizing policy", () => {
  const ambiguous = structuredClone(cluster);
  ambiguous.bundles[0].kind.external.entryPoint = "/usr/bin/../bin/mache";
  assert.throws(
    () => buildLaunchPlan(ambiguous, lock, {
      bundle: "mache",
      workspace: "/workspace",
      controlSocket: "/tmp/mache.sock",
    }),
    /canonical/,
  );
});

test("the declared Mache tenant has an explicit in-guest workspace fallback", () => {
  const declared = parseToml(readFileSync(new URL("../../cluster.toml", import.meta.url), "utf8"));
  const mache = declared.bundles.find((bundle) => bundle.name === "mache");
  assert.equal(mache.external.entryPoint, "/usr/local/bin/mache");
  assert.deepEqual(
    mache.external.args,
    ["serve", "--http", "127.0.0.1:7532", "--path", "/workspace"],
  );
});

test("planFromToml is the cluster.toml entry point and applies the full schema", async () => {
  const plan = await planFromToml(CLUSTER_TOML, lock, {
    bundle: "mache", workspace: "/workspace", controlSocket: "/tmp/mache.sock",
  });
  assert.equal(plan.bundle, "mache");
  await assert.rejects(
    planFromToml(CLUSTER_TOML.replace("entryPoint", "entryPiont"), lock, {
      bundle: "mache", workspace: "/workspace", controlSocket: "/tmp/mache.sock",
    }),
    /\[bundles.external\] declares unknown field "entryPiont"/,
  );
});
