// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLaunchPlan,
  parsePlanArgs,
} from "../emit-host-launch-plan.mjs";

const cluster = {
  bundles: [
    {
      name: "mache",
      kind: "external",
      confinement: {
        fs: { allow: [{ path: "/workspace", mode: "rw" }] },
        network: { allowHosts: [] },
        port: { bind: 7532, address: "127.0.0.1" },
        credentialSource: "",
      },
      external: {
        entryPoint: "/usr/bin/mache",
        executionMode: "microvm",
        args: ["serve", "--http", "127.0.0.1:7532", "/workspace"],
      },
    },
  ],
};

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
  delete missing.bundles[0].external.entryPoint;
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
    },
  );
  assert.throws(() => parsePlanArgs(["mache", "--workspace", "relative"]), /absolute/);
});
