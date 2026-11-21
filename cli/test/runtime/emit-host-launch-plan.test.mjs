// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

import {
  buildLaunchPlan,
  parsePlanArgs,
  planFromToml,
} from "../../commands/runtime-plan.mjs";
import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { tableAdmits } from "../fixtures/platform-admits-table.mjs";

const ADMITS = tableAdmits({
  "linux/arm64": { admitted: ["linux/arm64", "linux/arm64/v8"], overlapping: ["linux/arm64", "linux/arm64/v8"] },
});

// buildLaunchPlan takes a VALIDATED cluster (cloister-991e65: runtime plan
// parses cluster.toml through parseTomlToCluster first), so the fixture is
// TOML run through that pipeline rather than a hand-built object.
//
// The listener is a declared port, not `[bundles.confinement.port]`: a
// microvm bundle's only channels are §6 grants derived from its ports and
// connections, and cluster.toml refuses a hand-declared grant on one
// (cloister-ca2582). This fixture once declared the port and a /workspace
// path under confinement, and its first test asserted they reached the plan
// unchanged: a plan the host runtime then refused at launch.
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

[[bundles.ports]]
name = "mcp"
port = 7532
appProtocol = "art.http"
expose = "cluster"
`;
const cluster = await parseTomlToCluster(CLUSTER_TOML);

const lock = {
  inputs: {
    mache: {
      oci: {
        identifier: "ghcr.io/agentic-research/mache",
        version: "v0.17.0",
        digest: `sha256:${"8".repeat(64)}`,
        rootfs: [{ platform: "linux/arm64", digest: `blake3-256:${"9".repeat(64)}`, image: `sha256:${"8".repeat(64)}` }],
      },
    },
  },
};
const inCas = () => ({ present: true, casRoot: "/cas" });

test("buildLaunchPlan lowers the declared port to a §6 grant, and the locked artifact", () => {
  const plan = buildLaunchPlan(cluster, lock, {
    bundle: "mache",
    workspace: "/Users/operator/src",
    controlSocket: "/tmp/cloister/mache.sock",
    rootfsInCas: inCas, guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
  });

  assert.deepEqual(plan, {
    schema: "cloister/host-runtime/v1",
    bundle: "mache",
    mode: "microvm",
    artifact: {
      image: "ghcr.io/agentic-research/mache",
      // A microvm plan runs the imported rootfs, not the image digest.
      digest: `blake3-256:${"9".repeat(64)}`,
      entrypoint: "/usr/bin/mache",
      args: ["serve", "--http", "127.0.0.1:7532", "/workspace"],
    },
    // The deny-all facet, plus the one channel the port declares: the
    // workload listens on the guest's 127.0.0.1:7532, and only this socket
    // reaches it.
    confinement: {
      ...cluster.bundles[0].confinement,
      unixSocket: { allow: [{ path: "/tmp/cloister-host-runtime/ch/mache.mcp.sock", mode: "bind", guestPort: 7532 }] },
    },
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
  const declared = parseToml(readFileSync(new URL("../../../cluster.toml", import.meta.url), "utf8"));
  const mache = declared.bundles.find((bundle) => bundle.name === "mache");
  assert.equal(mache.external.entryPoint, "/usr/local/bin/mache");
  assert.deepEqual(
    mache.external.args,
    ["serve", "--http", "127.0.0.1:7532", "--path", "/workspace"],
  );
});

test("planFromToml is the cluster.toml entry point and applies the full schema", async () => {
  const plan = await planFromToml(CLUSTER_TOML, lock, {
    bundle: "mache", workspace: "/workspace", controlSocket: "/tmp/mache.sock", rootfsInCas: inCas, guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
  });
  assert.equal(plan.bundle, "mache");
  await assert.rejects(
    planFromToml(CLUSTER_TOML.replace("entryPoint", "entryPiont"), lock, {
      bundle: "mache", workspace: "/workspace", controlSocket: "/tmp/mache.sock", rootfsInCas: inCas, guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
    }),
    /\[bundles.external\] declares unknown field "entryPiont"/,
  );
});

// cloister-2af426: a bundle's declared environment reaches the plan.
const planOptions = {
  bundle: "mache",
  workspace: "/workspace",
  controlSocket: "/tmp/mache.sock",
  rootfsInCas: inCas,
  guestPlatform: () => "linux/arm64", platformAdmits: ADMITS,
};
function withEnv(env) {
  const c = structuredClone(cluster);
  c.bundles[0].kind.external.env = env;
  return c;
}

test("buildLaunchPlan emits declared environment in declaration order", () => {
  const plan = buildLaunchPlan(
    withEnv([{ name: "ZED", value: "1" }, { name: "ALPHA", value: "two words" }]),
    lock,
    planOptions,
  );
  assert.deepEqual(plan.environment, [
    { name: "ZED", value: "1" },
    { name: "ALPHA", value: "two words" },
  ]);
});

test("buildLaunchPlan emits no environment key for a bundle that declares none", () => {
  for (const env of [undefined, []]) {
    const plan = buildLaunchPlan(withEnv(env), lock, planOptions);
    assert.equal("environment" in plan, false);
  }
});

test("buildLaunchPlan refuses a malformed environment by bundle and name, never value", () => {
  const secret = "s3cret-value";
  const cases = [
    ["empty name", [{ name: "", value: secret }], /empty or non-string name/, null],
    ["non-string name", [{ name: 7, value: secret }], /empty or non-string name/, null],
    ["name with =", [{ name: "A=B", value: secret }], /"A=B".*"="/, "A=B"],
    ["NUL in name", [{ name: "A\u0000B", value: secret }], /NUL/, "A\\u0000B"],
    ["NUL in value", [{ name: "GOOD", value: `${secret}\u0000x` }], /"GOOD".*NUL/, "GOOD"],
    ["non-string value", [{ name: "GOOD", value: 5 }], /"GOOD".*string/, "GOOD"],
    ["duplicate name", [{ name: "DUP", value: secret }, { name: "DUP", value: "b" }], /"DUP" twice/, "DUP"],
  ];
  for (const [label, env, pattern, nameText] of cases) {
    assert.throws(
      () => buildLaunchPlan(withEnv(env), lock, planOptions),
      (err) => {
        assert.match(err.message, /bundle "mache"/, label);
        assert.match(err.message, pattern, label);
        if (nameText) assert.ok(err.message.includes(nameText), label);
        assert.ok(!err.message.includes(secret), `${label}: message leaked the value`);
        return true;
      },
    );
  }
});

// A shape other than { name, value } rows used to be coerced to an empty list
// by the TOML layer, so the plan carried no environment and nothing said so.
test("planFromToml refuses an env that is not { name, value } rows, never dropping it", async () => {
  const secret = "s3cret-value";
  const withExternal = (line) => CLUSTER_TOML.replace('executionMode = "microvm"', `executionMode = "microvm"\n${line}`);
  const withTail = (tail) => CLUSTER_TOML.replace("[[bundles.ports]]", `${tail}\n[[bundles.ports]]`);
  const cases = [
    ["a KEY = value table", withTail(`[bundles.external.env]\nGREETING = "${secret}"\n`), /env must be a list of \{ name, value \} rows/],
    ["a string", withExternal(`env = "GREETING=${secret}"`), /env must be a list of \{ name, value \} rows/],
    ["a list of strings", withExternal(`env = ["GREETING=${secret}"]`), /env entry 0 is not a \{ name, value \} row/],
    ["a numeric value", withTail(`[[bundles.external.env]]\nname = "PORT"\nvalue = 8080\n`), /env "PORT": value must be a string/],
    ["a non-string name", withTail(`[[bundles.external.env]]\nname = 7\nvalue = "${secret}"\n`), /env entry 0: name must be a string/],
  ];
  for (const [label, toml, pattern] of cases) {
    await assert.rejects(planFromToml(toml, lock, planOptions), (err) => {
      assert.match(err.message, /bundle "mache"/, label);
      assert.match(err.message, pattern, label);
      assert.ok(!err.message.includes(secret), `${label}: message leaked the value`);
      return true;
    }, label);
  }
  const plan = await planFromToml(
    withTail(`[[bundles.external.env]]\nname = "GREETING"\nvalue = "hi"\n\n[[bundles.external.env]]\nname = "EMPTY"\n`),
    lock,
    planOptions,
  );
  assert.deepEqual(plan.environment, [{ name: "GREETING", value: "hi" }, { name: "EMPTY", value: "" }]);
});
