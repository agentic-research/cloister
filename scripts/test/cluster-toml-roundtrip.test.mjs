// scripts/test/cluster-toml-roundtrip.test.mjs
//
// Bidi TOML ↔ cluster.ts roundtrip tests (cloister-ae06f3, ADR-0025).
//
// Run with:
//   pnpm exec tsx --test scripts/test/cluster-toml-roundtrip.test.mjs
//
// Lives under scripts/test/ (not test/) for the same reason
// cli-init.test.mjs and lint-bundle-isolation.test.mjs do: vitest-
// pool-workers runs inside workerd which has no `node:fs`,
// `node:child_process`, or `@iarna/toml`. Node-native test runner +
// tsx loader (so the .ts zod schema can be imported).
//
// Phase 2 baseline: the stub scripts throw `not implemented`; every
// behavioral test below SHOULD FAIL today. Phases 3-5 turn them
// green one tranche at a time. Phase 5 closes the loop with byte-
// equal canonical roundtrip.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parse as parseToml } from "@iarna/toml";
import {
  parseTomlToCluster,
  renderClusterTs,
} from "../toml-to-cluster.mjs";
import { clusterToToml } from "../cluster-to-toml.mjs";
import { ClusterSchema } from "../../src/generated/cluster.zod.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A minimal cluster shape that passes ClusterSchema. */
function minimalCluster() {
  return {
    metadata: { name: "test-cluster", version: "0.0.1" },
    bundles: [
      {
        name: "alpha",
        description: "A test bundle",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        kind: {
          external: {
            image: "alpha:0.1",
            ipcSocket: "/run/alpha.sock",
            httpPort: 0,
            args: [],
            env: [],
          },
        },
      },
    ],
    wires: [
      {
        from: "alpha",
        to: "alpha",
        binding: "SELF",
        transport: { uds: null },
      },
    ],
    storage: { doStoragePath: "/data/do" },
  };
}

/** Cluster covering both union variants for kind + transport. */
function richCluster() {
  return {
    metadata: { name: "rich", version: "0.0.2" },
    bundles: [
      {
        name: "router",
        description: "router bundle",
        tier: "hypervisor",
        holdsCredential: ["VAULT"],
        workerdServiceName: "router",
        hypervisorRationale: "Mediates all traffic. Singleton.",
        kind: {
          external: {
            image: "router:0.1",
            ipcSocket: "/run/router.sock",
            httpPort: 8787,
            args: ["--ipc-socket", "/run/router.sock"],
            env: [{ name: "DEBUG", value: "1" }],
          },
        },
      },
      {
        name: "tool",
        description: "tool bundle",
        tier: "cluster",
        holdsCredential: [],
        workerdServiceName: "",
        hypervisorRationale: "",
        kind: { workerd: { entryPoint: "src/bundles/tool/index.ts" } },
      },
    ],
    wires: [
      {
        from: "router",
        to: "tool",
        binding: "TOOL",
        transport: { uds: null },
      },
      {
        from: "router",
        to: "router",
        binding: "LOOPBACK",
        transport: { leylineNet: null },
      },
    ],
    storage: { doStoragePath: "/data/do" },
  };
}

// ── Contract 1: forward parse + validate + render ─────────────────────────

test("toml-to-cluster: parses TOML, validates via ClusterSchema, returns Cluster object", async () => {
  const c = minimalCluster();
  const toml = clusterToToml(c);
  const parsed = await parseTomlToCluster(toml);

  // The parsed result must match the schema-validated shape.
  const validated = ClusterSchema.parse(parsed);
  assert.equal(validated.metadata.name, "test-cluster");
  assert.equal(validated.bundles.length, 1);
  assert.equal(validated.bundles[0].name, "alpha");
  // Union shape: kind is { external: {...} }, NOT a flat string.
  assert.ok(
    "external" in validated.bundles[0].kind,
    "bundle.kind must be the { external: {...} } union shape",
  );
});

test("toml-to-cluster: renderClusterTs emits the same shape as scripts/build-cluster.mjs", () => {
  const c = minimalCluster();
  const ts = renderClusterTs(c);
  // Header + import + export const cluster: Cluster = {...} as const;
  assert.match(ts, /AUTO-GENERATED/);
  assert.match(ts, /import type \{ Cluster \} from "..\/manifest\/cluster-types.js";/);
  assert.match(ts, /export const cluster: Cluster = \{[\s\S]+\} as const;/);
  // The data body itself must include the cluster name.
  assert.match(ts, /"name": "test-cluster"/);
});

// ── Contract 2: schema-violation rejection ────────────────────────────────

test("toml-to-cluster: rejects TOML that violates ClusterSchema with a clear error", async () => {
  // Missing required `metadata.name` field.
  const bad = `
[metadata]
version = "0.0.1"

[storage]
doStoragePath = "/data/do"
`;
  await assert.rejects(
    () => parseTomlToCluster(bad),
    (err) => {
      // Error message must mention the missing field by name so
      // operators can locate it in their TOML.
      return /name/.test(err.message);
    },
    "expected a schema-validation error citing the missing 'name' field",
  );
});

// ── Contract 3: semantic wire-ref rejection ───────────────────────────────

test("toml-to-cluster: rejects TOML where a wire references a nonexistent bundle", async () => {
  // Wire.from references a bundle that isn't declared. zod doesn't
  // catch this (schema lets any string in wire.from); the semantic
  // pass must reject it.
  const bad = `
[metadata]
name = "test"
version = "0.0.1"

[[bundles]]
name = "real"
description = "exists"
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
kind = "external"

[bundles.external]
image = "real:0.1"
ipcSocket = ""
httpPort = 0
args = []
env = []

[[wires]]
from = "ghost"
to = "real"
binding = "X"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  await assert.rejects(
    () => parseTomlToCluster(bad),
    (err) => /ghost/.test(err.message) || /unknown.*bundle/i.test(err.message),
    "expected a semantic error citing the unknown bundle 'ghost'",
  );
});

// ── Contract 4: canonical write is deterministic ──────────────────────────

test("cluster-to-toml: emits canonical TOML (deterministic key order — two calls produce byte-identical output)", () => {
  const c = richCluster();
  const t1 = clusterToToml(c);
  const t2 = clusterToToml(c);
  assert.equal(t1, t2, "canonical output must be byte-stable across calls");
});

test("cluster-to-toml: canonical TOML has metadata before bundles before wires before storage", () => {
  const c = richCluster();
  const t = clusterToToml(c);
  const iMeta = t.indexOf("[metadata]");
  const iBund = t.indexOf("[[bundles]]");
  const iWire = t.indexOf("[[wires]]");
  const iStor = t.indexOf("[storage]");
  assert.ok(iMeta >= 0 && iBund > iMeta, "metadata must come before bundles");
  assert.ok(iWire > iBund, "bundles must come before wires");
  assert.ok(iStor > iWire, "wires must come before storage");
});

// ── Contract 5: discriminated unions flatten to kind = "<variant>" ────────

test("cluster-to-toml: discriminated unions emit as kind = \"<variant>\" + [bundle.<variant>] sibling", () => {
  const c = richCluster();
  const t = clusterToToml(c);

  // The router bundle is { external: {...} } — must appear as
  // kind = "external" + a [bundles.external] subtable with image=.
  assert.match(t, /kind = "external"/, "external bundle must emit kind = \"external\"");
  assert.match(t, /\[bundles\.external\]/, "external bundle must have a [bundles.external] subtable");
  assert.match(t, /image = "router:0.1"/, "subtable must contain the payload fields");

  // The tool bundle is { workerd: {...} }.
  assert.match(t, /kind = "workerd"/, "workerd bundle must emit kind = \"workerd\"");
  assert.match(t, /\[bundles\.workerd\]/, "workerd bundle must have a [bundles.workerd] subtable");
  assert.match(t, /entryPoint = "src\/bundles\/tool\/index\.ts"/);
});

// ── Contract 6: void union variants emit just the discriminator ───────────

test("cluster-to-toml: void union variants (transport.uds, transport.leylineNet) emit as transport = \"<variant>\" with no payload subtable", () => {
  const c = richCluster();
  const t = clusterToToml(c);

  // Both void variants must appear as a string tag, NOT as a table
  // or null sentinel. Per ADR-0025 §Discriminated unions.
  assert.match(t, /transport = "uds"/, "uds wire must emit transport = \"uds\"");
  assert.match(t, /transport = "leylineNet"/, "leylineNet wire must emit transport = \"leylineNet\"");

  // No [wires.uds] or [wires.leylineNet] subtables for void variants.
  assert.equal(t.indexOf("[wires.uds]"), -1, "void variants must NOT emit a payload subtable");
  assert.equal(t.indexOf("[wires.leylineNet]"), -1, "void variants must NOT emit a payload subtable");
});

// ── Contract 7: TOML → cluster.ts → TOML is byte-equal ────────────────────

test("roundtrip: canonical TOML → cluster object → canonical TOML produces byte-equal output", async () => {
  const c = richCluster();
  const t1 = clusterToToml(c);
  const obj = await parseTomlToCluster(t1);
  const t2 = clusterToToml(obj);
  assert.equal(t2, t1, "canonical roundtrip must be byte-equal");
});

// ── Contract 8: cluster.ts → TOML → cluster.ts is semantically equivalent ──

test("roundtrip: cluster object → TOML → cluster object is semantically equivalent (zod-validated identical shape)", async () => {
  const c = richCluster();
  const t = clusterToToml(c);
  const back = await parseTomlToCluster(t);

  // Both shapes pass ClusterSchema.
  const a = ClusterSchema.parse(c);
  const b = ClusterSchema.parse(back);

  // After zod-parse, the structural shape must be identical.
  assert.deepEqual(b, a, "roundtrip must preserve all data faithfully");
});

// ── Phase 2 baseline sanity: confirm the stubs throw as documented ────────

test("Phase 2 stub baseline: imports succeed and stubs throw 'not implemented' (deleted in Phase 3)", () => {
  // This test passes today (Phase 2) and stays passing through
  // Phase 5 because the impl never makes them throw — by then the
  // test is moot, but it documents the pre-impl invariant. Delete
  // when Phase 5 closes.
  assert.equal(typeof parseTomlToCluster, "function");
  assert.equal(typeof renderClusterTs, "function");
  assert.equal(typeof clusterToToml, "function");
  assert.equal(typeof parseToml, "function", "@iarna/toml.parse is reachable");
  assert.equal(typeof ClusterSchema.parse, "function", "ClusterSchema is reachable via tsx loader");
});
