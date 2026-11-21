// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bundle's workspace is a need declared once, and every placement gives it
// or refuses by name (ADR-0078, cli/lib/cluster/workspace.mjs). Compose
// bind-mounts it at /work; a microvm plan carries it for the host runtime,
// which refuses it until it can serve one; any other placement is refused when
// cluster.toml is parsed. Nothing starts the bundle without it.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { parseTomlToCluster } from "../../lib/cluster/toml-to-cluster.mjs";
import { clusterToToml } from "../../lib/cluster/cluster-to-toml.mjs";
import { emitCompose } from "../../lib/cluster/emit-compose.mjs";
import { buildLaunchPlan } from "../../commands/runtime-plan.mjs";
import { WORKSPACE_PATH } from "../../lib/cluster/workspace.mjs";
import { tableAdmits } from "../fixtures/platform-admits-table.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const toml = ({ workspace = "", mode = "microvm", extra = "" } = {}) => `
[metadata]
name = "workspace-fixture"
version = "0.0.1"

[storage]
doStoragePath = "/data/do"

[[bundles]]
name = "tool"
kind = "external"
tier = "cluster"
${extra}

[bundles.external]
image = "tool:1"
entryPoint = "/usr/bin/tool"
executionMode = "${mode}"
${mode === "process" ? 'executionModeRationale = "a fixture"' : ""}
args = ["--path", "/work"]
${workspace === "" ? "" : `workspace = "${workspace}"`}
`;

const composed = async (text) => parseYaml(emitCompose(await parseTomlToCluster(text))).services.tool;

test("compose gives a declared workspace at /work, read-only for read", async () => {
  const read = await composed(toml({ mode: "process", workspace: "read" }));
  assert.deepEqual(read.volumes, [{ type: "bind", source: "${CLOISTER_WORKSPACE:-.}", target: WORKSPACE_PATH, read_only: true }]);
  const write = await composed(toml({ mode: "process", workspace: "write" }));
  assert.deepEqual(write.volumes, [{ type: "bind", source: "${CLOISTER_WORKSPACE:-.}", target: WORKSPACE_PATH }]);
  // A bundle that declares none is mounted nothing.
  assert.equal((await composed(toml({ mode: "process" }))).volumes, undefined);
});

test("a microvm plan carries the declared workspace for the host runtime, and only when declared", async () => {
  const lock = {
    inputs: {
      tool: {
        oci: {
          identifier: "ghcr.io/example/tool",
          digest: `sha256:${"8".repeat(64)}`,
          rootfs: [{ platform: "linux/arm64", digest: `blake3-256:${"9".repeat(64)}`, image: `sha256:${"8".repeat(64)}` }],
        },
      },
    },
  };
  const options = {
    bundle: "tool", workspace: "/w", controlSocket: "/tmp/tool.sock",
    rootfsInCas: () => ({ present: true, casRoot: "/cas" }),
    guestPlatform: () => "linux/arm64",
    platformAdmits: tableAdmits({ "linux/arm64": { admitted: ["linux/arm64"], overlapping: ["linux/arm64"] } }),
  };
  const plan = buildLaunchPlan(await parseTomlToCluster(toml({ workspace: "write" })), lock, options);
  assert.equal(plan.workspaceAccess, "write");
  const none = buildLaunchPlan(await parseTomlToCluster(toml()), lock, options);
  assert.equal("workspaceAccess" in none, false);
});

test("a placement that does not give a workspace refuses the declaration, by name", async () => {
  const placed = toml({
    workspace: "read",
    extra: '\n[[bundles.placements]]\nenv = "prod"\nkind = "kubernetes"\nmanifest = "tool.yaml"\n',
  });
  await assert.rejects(
    parseTomlToCluster(placed),
    /bundle "tool" declares workspace = "read", and its "kubernetes" placement for env "prod" does not give it one/,
  );
});

test("a workspace value other than read or write is refused, and so is one shared between tenants", async () => {
  await assert.rejects(parseTomlToCluster(toml({ workspace: "rw" })), /workspace "rw" is not one of read, write/);
  await assert.rejects(
    parseTomlToCluster(toml({ mode: "process", workspace: "read", extra: "perTenant = true" })),
    /is perTenant and declares workspace = "read": every tenant's instance would be given the same workspace/,
  );
});

test("the round trip keeps a declared workspace, and writes nothing for none", async () => {
  const declared = clusterToToml(await parseTomlToCluster(toml({ workspace: "read" })));
  assert.match(declared, /^workspace = "read"$/m);
  const none = clusterToToml(await parseTomlToCluster(toml()));
  assert.doesNotMatch(none, /workspace =/);
});

test("this repository's mache is given its workspace by compose, where it was given none", () => {
  const compose = parseYaml(readFileSync(resolve(ROOT, "cluster.compose.yaml"), "utf8"));
  const mache = compose.services.mache;
  assert.ok(
    (mache.volumes ?? []).some((v) => v?.type === "bind" && v?.target === WORKSPACE_PATH && v?.read_only !== true),
    "mache's compose service mounts the workspace, writable, at /work",
  );
  assert.deepEqual(mache.command.slice(-2), ["--path", WORKSPACE_PATH]);
});
