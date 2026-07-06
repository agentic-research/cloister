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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTomlToCluster,
  renderClusterTs,
} from "../toml-to-cluster.mjs";
import { clusterToToml } from "../cluster-to-toml.mjs";
import { ClusterSchema } from "../../src/generated/cluster.zod.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const TOML_TO_CLUSTER = resolve(REPO_ROOT, "scripts/toml-to-cluster.mjs");
const CLUSTER_TO_TOML = resolve(REPO_ROOT, "scripts/cluster-to-toml.mjs");

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Canonical "all-empty" Gateway value — the back-compat default for
 * pre-Phase-4a cluster.toml files (cloister-c919d7 / ADR-0031).
 * Schema requires the field; this is the zero value zod accepts.
 * The emitter falls through to its ART-default template when it
 * sees this exact shape.
 */
const EMPTY_GATEWAY = {
  metadata: { name: "", version: "" },
  actor: {
    fingerprint: "",
    algorithm: "",
    pubkeyBinding: "",
    attestationRepo: "",
    tunnelEndpoint: "",
  },
  policy: {
    maxCertLifetimeSeconds: 0,
    requireInterlock: false,
    minAlgorithm: "",
  },
  vaultProxyServices: [],
};

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
    inputs: [], // ADR-0026 / cloister-cf7a3b Phase 1a — required schema field
    routes: [], // cloister-345ad1 / ADR-0031 Phase 2 — required schema field
    gateway: EMPTY_GATEWAY, // cloister-c919d7 / ADR-0031 Phase 4a — required schema field
    edges: [], // ADR-0030 / cloister-0e3004 — required schema field (back-compat: pre-ADR-0030 = empty)
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
        perTenant: false,
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
        perTenant: false,
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
    inputs: [], // ADR-0026 / cloister-cf7a3b Phase 1a — required schema field
    routes: [], // cloister-345ad1 / ADR-0031 Phase 2 — required schema field
    gateway: EMPTY_GATEWAY, // cloister-c919d7 / ADR-0031 Phase 4a — required schema field
    edges: [], // ADR-0030 / cloister-0e3004 — required schema field (back-compat: pre-ADR-0030 = empty)
  };
}

// ── Contract 1: forward parse + validate + render ─────────────────────────

test("toml-to-cluster: parses TOML, validates via ClusterSchema, returns Cluster object", async () => {
  // Hardcoded TOML (not generated by the writer) so this test
  // exercises the READER in isolation — independent of Phase 4.
  const toml = `
[metadata]
name = "test-cluster"
version = "0.0.1"

[[bundles]]
description = "A test bundle"
holdsCredential = []
hypervisorRationale = ""
kind = "external"
name = "alpha"
tier = "cluster"
workerdServiceName = ""

[bundles.external]
args = []
env = []
httpPort = 0
image = "alpha:0.1"
ipcSocket = "/run/alpha.sock"

[[wires]]
binding = "SELF"
from = "alpha"
to = "alpha"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  const parsed = await parseTomlToCluster(toml);

  // The parsed result must match the schema-validated shape.
  const validated = ClusterSchema.parse(parsed);
  assert.equal(validated.metadata.name, "test-cluster");
  assert.equal(validated.bundles.length, 1);
  assert.equal(validated.bundles[0].name, "alpha");
  // Union shape (un-flattened from the TOML kind = "external" + [bundles.external]):
  assert.ok(
    "external" in validated.bundles[0].kind,
    "bundle.kind must be the { external: {...} } union shape after un-flattening",
  );
  assert.equal(validated.bundles[0].kind.external.image, "alpha:0.1");
  // Wire transport (un-flattened from transport = "uds"):
  assert.deepEqual(validated.wires[0].transport, { uds: null });
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
      // Error message must cite the field path `metadata.name`
      // (not just any field containing "name") so operators see
      // the location precisely. Tightened per skeptic-agent N5.
      return /metadata\.name/.test(err.message);
    },
    "expected a schema-validation error citing the missing 'metadata.name' field",
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

test("cluster-to-toml: omits bundle schema defaults while preserving semantic roundtrip", async () => {
  const c = minimalCluster();
  c.bundles[0] = {
    ...c.bundles[0],
    description: "",
    holdsCredential: [],
    workerdServiceName: "",
    hypervisorRationale: "",
    perTenant: false,
    kind: {
      external: {
        image: "alpha:0.1",
        ipcSocket: "/run/alpha.sock",
        httpPort: 0,
        args: [],
        env: [],
      },
    },
  };

  const t = clusterToToml(c);

  assert.match(t, /\[\[bundles\]\]/, "bundle row must still be emitted");
  assert.match(t, /name = "alpha"/, "bundle identity must remain explicit");
  assert.match(t, /tier = "cluster"/, "bundle tier must remain explicit");
  assert.match(t, /kind = "external"/, "bundle kind must remain explicit");
  assert.match(t, /image = "alpha:0\.1"/, "external image must remain explicit");
  assert.match(t, /ipcSocket = "\/run\/alpha\.sock"/, "external ipcSocket must remain explicit");

  assert.ok(!t.includes("description"), "empty description must not emit boilerplate");
  assert.ok(!t.includes("holdsCredential"), "empty holdsCredential[] must not emit boilerplate");
  assert.ok(!t.includes("hypervisorRationale"), "empty hypervisorRationale must not emit boilerplate");
  assert.ok(!t.includes("workerdServiceName"), "empty workerdServiceName must not emit boilerplate");
  assert.ok(!t.includes("perTenant"), "perTenant=false must not emit boilerplate");
  assert.ok(!t.includes("args"), "empty external args[] must not emit boilerplate");
  assert.ok(!t.includes("env"), "empty external env[] must not emit boilerplate");
  assert.ok(!t.includes("httpPort"), "external httpPort=0 must not emit boilerplate");

  const reparsed = await parseTomlToCluster(t);
  assert.deepEqual(
    ClusterSchema.parse(reparsed),
    ClusterSchema.parse(c),
    "parser defaults must restore omitted schema-default bundle fields",
  );
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

// ── Contract 9: duplicate bundle names rejected ──────────────────────────

test("toml-to-cluster: rejects TOML with duplicate bundle names", async () => {
  // `wires = []` at the top is required by TOML 1.0.0 (top-level
  // scalars must precede any table sections); zod also requires
  // `wires` to be present (empty is fine).
  const bad = `wires = []

[metadata]
name = "test"
version = "0.0.1"

[[bundles]]
name = "twin"
description = "first"
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
kind = "external"
[bundles.external]
image = "twin:0.1"
ipcSocket = "/twin1.sock"
httpPort = 0
args = []
env = []

[[bundles]]
name = "twin"
description = "second — duplicate name"
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
kind = "external"
[bundles.external]
image = "twin:0.2"
ipcSocket = "/twin2.sock"
httpPort = 0
args = []
env = []

[storage]
doStoragePath = "/data/do"
`;
  await assert.rejects(
    () => parseTomlToCluster(bad),
    (err) => /bundle name "twin" is declared more than once/.test(err.message),
    "expected duplicate-bundle-name rejection citing the collision",
  );
});

// ── Contract 10: duplicate wire bindings rejected ────────────────────────

test("toml-to-cluster: rejects TOML with duplicate wire bindings", async () => {
  const bad = `
[metadata]
name = "test"
version = "0.0.1"

[[bundles]]
name = "alpha"
description = "a"
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
kind = "external"
[bundles.external]
image = "alpha:0.1"
ipcSocket = "/alpha.sock"
httpPort = 0
args = []
env = []

[[wires]]
from = "alpha"
to = "alpha"
binding = "DUPED"
transport = "uds"

[[wires]]
from = "alpha"
to = "alpha"
binding = "DUPED"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  await assert.rejects(
    () => parseTomlToCluster(bad),
    (err) => /wire binding "DUPED" is declared more than once/.test(err.message),
    "expected duplicate-wire-binding rejection citing the collision",
  );
});

// ── Contract 11: empty cluster roundtrips deterministically ──────────────

test("roundtrip: empty bundles/wires arrays are byte-equal across roundtrip (TOML hoists them per spec — known artifact, documented in ADR-0025 §Canonicalization)", async () => {
  const empty = {
    metadata: { name: "empty", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [], // ADR-0026 / cloister-cf7a3b Phase 1a — required schema field
    routes: [], // cloister-345ad1 / ADR-0031 Phase 2 — required schema field
    gateway: EMPTY_GATEWAY, // cloister-c919d7 / ADR-0031 Phase 4a — required schema field
    edges: [], // ADR-0030 / cloister-0e3004 — required schema field
  };
  const t1 = clusterToToml(empty);
  const back = await parseTomlToCluster(t1);
  const t2 = clusterToToml(back);
  assert.equal(t2, t1, "empty-cluster canonical form must be byte-stable");
  // Confirm zod validates the parsed-back shape too.
  const validated = ClusterSchema.parse(back);
  assert.deepEqual(validated, empty);
});

// ── cloister-fe891f: Taskfile cluster:toml chain canonicalizes operator-edited TOML ──
//
// Spec: `task cluster:toml` MUST chain `toml-to-cluster.mjs` (forward)
// then `cluster-to-toml.mjs --write cluster.toml` (re-canonicalize) so
// operator-edited TOML lands in canonical form in one verb. Without
// the chain, an operator who types `httpPort = 9999` (which @iarna/toml
// normalizes to `9_999`) sees the drift gate fail after `task cluster:toml`
// even though the data is correct.
//
// Test exercises the chain at the script level (matches what Taskfile
// will invoke). If the scripts change such that the chain no longer
// canonicalizes in one pass, this fails. Pair with the Taskfile entry
// having BOTH commands — see Taskfile.yml `cluster:toml`.

const NON_CANONICAL_TOML = `
[metadata]
name = "fe891f-test"
version = "0.0.1"

[[bundles]]
description = "fe891f probe — non-canonical formatting"
holdsCredential = []
hypervisorRationale = ""
kind = "external"
name = "probe"
tier = "cluster"
workerdServiceName = ""

  [bundles.external]
  args = []
  env = []
  httpPort = 9999
  image = "probe:0.1"
  ipcSocket = "/run/probe.sock"

[storage]
doStoragePath = "/data/do"

[[wires]]
binding = "SELF"
from = "probe"
to = "probe"
transport = "uds"
`;

function runChain(workDir, tomlPath, tsPath) {
  // Forward: parse cluster.toml → render cluster.ts.
  const fwd = spawnSync(TSX_BIN, [TOML_TO_CLUSTER], {
    cwd: workDir,
    env: { ...process.env, CLUSTER_TOML: tomlPath, CLUSTER_OUTPUT: tsPath },
    encoding: "utf8",
  });
  if (fwd.status !== 0) {
    throw new Error(`toml-to-cluster failed: exit=${fwd.status}\nstderr:\n${fwd.stderr}\nstdout:\n${fwd.stdout}`);
  }
  // Reverse: render cluster.ts → canonical cluster.toml (overwriting input).
  const rev = spawnSync(TSX_BIN, [CLUSTER_TO_TOML, "--write", tomlPath], {
    cwd: workDir,
    env: { ...process.env, CLUSTER_TS: tsPath },
    encoding: "utf8",
  });
  if (rev.status !== 0) {
    throw new Error(`cluster-to-toml failed: exit=${rev.status}\nstderr:\n${rev.stderr}\nstdout:\n${rev.stdout}`);
  }
}

test("cloister-fe891f: chained workflow canonicalizes non-canonical operator-edited TOML in one pass", () => {
  const tmp = mkdtempSync(resolve(tmpdir(), "fe891f-"));
  const tomlPath = resolve(tmp, "cluster.toml");
  const tsPath = resolve(tmp, "cluster.ts");

  try {
    writeFileSync(tomlPath, NON_CANONICAL_TOML);

    // Single chain pass = the Taskfile `cluster:toml` workflow post-fix.
    runChain(tmp, tomlPath, tsPath);

    const afterChain = readFileSync(tomlPath, "utf8");

    // 1. The chain rewrote the file (operator's non-canonical input
    //    was normalized).
    assert.notEqual(
      afterChain,
      NON_CANONICAL_TOML,
      "chain must rewrite operator-edited TOML to canonical form",
    );

    // 2. The canonical form normalizes the integer (httpPort 9999 → 9_999
    //    per @iarna/toml thousand-separator behavior).
    assert.match(
      afterChain,
      /httpPort = 9_999/,
      "canonical form should use TOML's thousand-separator for integers ≥1000",
    );

    // 3. Second chain pass is a no-op (canonical is the fixed point).
    runChain(tmp, tomlPath, tsPath);
    const afterSecondChain = readFileSync(tomlPath, "utf8");
    assert.equal(
      afterSecondChain,
      afterChain,
      "canonical TOML must be a fixed point of the chain (second pass = no-op)",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cloister-fe891f: Taskfile cluster:toml entry has BOTH legs of the chain", () => {
  // Pins the Taskfile config so a future edit that drops the
  // canonicalize step fails CI immediately. Companion to the
  // behavior test above — behavior tests the contract; this tests
  // the wire-up.
  const taskfile = readFileSync(resolve(REPO_ROOT, "Taskfile.yml"), "utf8");

  // Extract the cluster:toml: block (up to the next top-level entry).
  // Match from `  cluster:toml:` (indented) through the next blank line
  // followed by a non-indented or differently-indented key.
  const blockMatch = taskfile.match(/^  cluster:toml:\n([\s\S]*?)(?=^  [\w:-]+:|^\S)/m);
  assert.ok(blockMatch, "Taskfile must contain a cluster:toml: entry");
  const block = blockMatch[1];

  assert.match(
    block,
    /toml-to-cluster\.mjs/,
    "cluster:toml must invoke the forward leg (toml-to-cluster.mjs)",
  );
  assert.match(
    block,
    /cluster-to-toml\.mjs[^\n]*--write[^\n]*cluster\.toml/,
    "cluster:toml must chain the re-canonicalize step (cluster-to-toml.mjs --write cluster.toml) — per cloister-fe891f",
  );
});

// ── cloister-cf7a3b Phase 1a: [inputs.*] schema lands in bidi pipeline ───

test("inputs: TOML [inputs.<name>] table roundtrips to InputSpec[] and back to byte-equal canonical TOML", async () => {
  const { parseTomlToCluster, renderClusterTs } = await import("../toml-to-cluster.mjs");
  const { clusterToToml } = await import("../cluster-to-toml.mjs");

  // Inline TOML fixture covering: ref-only (no version), version-pinned,
  // digest-pinned (defense-in-depth), dev-loop `from` override, and the
  // lego-blocks provides/requires capability declarations.
  const tomlIn = `
[metadata]
name    = "inputs-fixture"
version = "0.0.1"

[[bundles]]
name                = "router"
description         = "self-loop"
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "router:0.1"
  ipcSocket = "/run/r.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "router"
to        = "router"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[inputs.rosary]
ref      = "io.github.jamestexas/rosary"
version  = "^0.1"
provides = ["cloister/mcp-tool/v1"]
requires = ["cloister/credential-isolation/v1"]

[inputs.python-tools]
ref      = "skills.sh/python"
version  = "^1.0"
digest   = "sha256:deadbeef"
provides = ["cloister/skill/v1", "cloister/python-runtime/v1"]

[inputs.local-dev]
ref     = "io.github.jamestexas/mache"
version = "^0.3"
from    = "file:///abs/path/to/mache"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.inputs.length, 3, "expected 3 inputs after unflatten");
  const byName = Object.fromEntries(parsed.inputs.map((i) => [i.name, i]));
  assert.equal(byName.rosary.ref, "io.github.jamestexas/rosary");
  assert.equal(byName.rosary.version, "^0.1");
  assert.deepEqual(byName.rosary.provides, ["cloister/mcp-tool/v1"]);
  assert.deepEqual(byName.rosary.requires, ["cloister/credential-isolation/v1"]);
  assert.equal(byName["python-tools"].digest, "sha256:deadbeef");
  assert.equal(byName["local-dev"].from, "file:///abs/path/to/mache");

  // Reverse leg: cluster object → canonical TOML. Two stringifications
  // produce byte-identical bytes (existing deterministic-emit property
  // extends to inputs).
  const t1 = clusterToToml(parsed);
  const t2 = clusterToToml(parsed);
  assert.equal(t1, t2, "cluster-to-toml emit must be deterministic");

  // The emitted TOML carries the three [inputs.<name>] table headers.
  // Substring checks (not regex) so the intent is plain — we're
  // asserting these exact strings appear, nothing fancier.
  assert.ok(t1.includes("[inputs.rosary]"),       "missing [inputs.rosary] header");
  assert.ok(t1.includes("[inputs.python-tools]"), "missing [inputs.python-tools] header");
  assert.ok(t1.includes("[inputs.local-dev]"),    "missing [inputs.local-dev] header");

  // Forward leg is idempotent: parsing the emitted TOML returns the
  // same cluster shape (this is the load-bearing roundtrip property +
  // also implicitly proves "empty fields omitted" — if cluster-to-toml
  // emitted `digest = ""` for the rosary input, parseTomlToCluster
  // would happily re-parse it back, so the deepEqual is the real test).
  const reparsed = await parseTomlToCluster(t1);
  assert.deepEqual(reparsed.inputs, parsed.inputs, "inputs must round-trip identity");

  // renderClusterTs handles the inputs field (no crash); structural
  // check on the rendered body — re-import via dynamic eval would be
  // overkill, so we assert presence of the field via plain substring.
  const tsBody = renderClusterTs(parsed);
  assert.ok(tsBody.includes('"inputs"'), "rendered TS body must serialize the inputs field");
  // Same body re-parsed as JSON (after stripping the TS wrapper) round-trips
  // the inputs structurally.
  const jsonBody = tsBody
    .replace(/^[\s\S]*export const cluster: Cluster = /, "")
    .replace(/ as const;\s*$/, "");
  const reparsedFromTs = JSON.parse(jsonBody);
  assert.deepEqual(reparsedFromTs.inputs, parsed.inputs);
});

test("inputs: cluster.toml with NO [inputs.*] tables parses to empty inputs array (back-compat)", async () => {
  const { parseTomlToCluster } = await import("../toml-to-cluster.mjs");
  const tomlIn = `
[metadata]
name    = "no-inputs"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "alpha:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.deepEqual(parsed.inputs, [], "missing [inputs] table → empty array");
});

test("inputs: empty inputs array omits the [inputs] section from emitted TOML (back-compat)", async () => {
  const { clusterToToml } = await import("../cluster-to-toml.mjs");
  const cluster = {
    metadata: { name: "no-inputs", version: "0.0.1" },
    bundles: [
      {
        name: "alpha", description: "", tier: "cluster",
        holdsCredential: [], workerdServiceName: "", hypervisorRationale: "",
        kind: { external: { image: "a:0.1", ipcSocket: "/run/a", httpPort: 0, args: [], env: [] } },
      },
    ],
    wires: [{ from: "alpha", to: "alpha", binding: "SELF", transport: { uds: null } }],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: EMPTY_GATEWAY,
  };
  const toml = clusterToToml(cluster);
  // Substring check, not regex. The contract: any "[inputs" header
  // would be a sign we emitted a stray section for an empty list.
  assert.ok(!toml.includes("[inputs"), "empty inputs[] must NOT emit a [inputs] table");
});

// ── cloister-05334b (P1 of LLO arc): urlBinding + serviceBinding on InputSpec ──
//
// The transport-binding hints thread through to [[generated_backends]] rows in
// cluster.lock.toml when the resolved input carries _meta.art.cloister/v1
// (or when the heuristic fallback fires). The downstream manifest emitter
// (scripts/build-manifest.mjs) then wires the generated mcpProxy backend to
// the right env-var bindings. Schema add: append-only ordinals @7 / @8 on
// InputSpec per ADR-0004 schema-evolution rules.

test("inputs: urlBinding + serviceBinding round-trip through cluster.toml (populated)", async () => {
  const { parseTomlToCluster } = await import("../toml-to-cluster.mjs");
  const { clusterToToml } = await import("../cluster-to-toml.mjs");
  const tomlIn = `
[metadata]
name    = "with-bindings"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "alpha:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[inputs.llo]
ref            = "io.github.org/agentic-research/ley-line-open@main"
version        = "0.4.5"
urlBinding     = "LLO_MCP_URL"
serviceBinding = "LSP_MCP"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.inputs.length, 1);
  assert.equal(parsed.inputs[0].urlBinding, "LLO_MCP_URL", "urlBinding must thread through the parse");
  assert.equal(parsed.inputs[0].serviceBinding, "LSP_MCP", "serviceBinding must thread through the parse");

  // Forward then reverse leg — round-trip preserves the bindings.
  const emitted = clusterToToml(parsed);
  assert.ok(emitted.includes('urlBinding = "LLO_MCP_URL"'), "emitted TOML must carry urlBinding");
  assert.ok(emitted.includes('serviceBinding = "LSP_MCP"'), "emitted TOML must carry serviceBinding");

  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.inputs, parsed.inputs, "binding hints must round-trip identity");
});

test("inputs: omitting urlBinding + serviceBinding parses to empty strings (back-compat)", async () => {
  const { parseTomlToCluster } = await import("../toml-to-cluster.mjs");
  const { clusterToToml } = await import("../cluster-to-toml.mjs");
  const tomlIn = `
[metadata]
name    = "no-bindings"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "alpha:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[inputs.bare]
ref = "file:///tmp/foo"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.inputs.length, 1);
  // Defaults: empty strings (canonical "unspecified" shape).
  assert.equal(parsed.inputs[0].urlBinding, "");
  assert.equal(parsed.inputs[0].serviceBinding, "");

  // Reverse leg must NOT emit empty-string bindings (canonicalization
  // drops empty fields so operators see only what they set).
  const emitted = clusterToToml(parsed);
  assert.ok(!emitted.includes("urlBinding"), "empty urlBinding must NOT appear in canonical TOML");
  assert.ok(!emitted.includes("serviceBinding"), "empty serviceBinding must NOT appear in canonical TOML");
});

test("inputs: zod strict-mode ACCEPTS urlBinding + serviceBinding (P5 follow-up — was previously a reject)", async () => {
  // Before this bead, the `.strict()` ClusterSchema rejected unknown
  // keys on InputSpec, so the resolver couldn't thread urlBinding /
  // serviceBinding from [inputs.*] through the bidi pipeline. This
  // test pins the fix.
  const { ClusterSchema } = await import("../../src/generated/cluster.zod.ts");
  const sample = {
    metadata: { name: "x", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [{
      name: "llo", ref: "x", version: "1", digest: "", from: "",
      provides: [], requires: [],
      urlBinding: "LLO_MCP_URL", serviceBinding: "LSP_MCP",
      tenancy: { mode: "", workerdId: "", trustedTier: false, sharesWorkerdWith: [] },
    }],
    routes: [], // cloister-345ad1 / ADR-0031 Phase 2 — required schema field
    gateway: EMPTY_GATEWAY, // cloister-c919d7 / ADR-0031 Phase 4a — required schema field
    edges: [], // ADR-0030 / cloister-0e3004 — required schema field
  };
  const out = ClusterSchema.parse(sample);
  assert.equal(out.inputs[0].urlBinding, "LLO_MCP_URL");
  assert.equal(out.inputs[0].serviceBinding, "LSP_MCP");
});

// ── ADR-0030 §A5 / cloister-0e3004 — tenancy on InputSpec roundtrip ────

test("inputs: tenancy block roundtrips byte-identically through cluster.toml (ADR-0030 §A5)", async () => {
  const { parseTomlToCluster } = await import("../toml-to-cluster.mjs");
  const { clusterToToml } = await import("../cluster-to-toml.mjs");

  const tomlIn = `
[metadata]
name    = "tenancy-roundtrip"
version = "0.0.1"

[[bundles]]
name                = "router"
description         = "self-loop"
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "router:0.1"
  ipcSocket = "/run/r.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "router"
to        = "router"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[inputs.notme]
ref     = "github://agentic-research/notme"
version = "^0.1"
  [inputs.notme.tenancy]
  mode              = "co-located"
  workerdId         = "cloister-router"
  trustedTier       = true
  sharesWorkerdWith = ["router"]

[inputs.mache]
ref     = "github://agentic-research/mache"
version = "^0.8"
  [inputs.mache.tenancy]
  mode = "external"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  // notme tenancy: full populate
  const notme = parsed.inputs.find((i) => i.name === "notme");
  assert.equal(notme.tenancy.mode, "co-located");
  assert.equal(notme.tenancy.workerdId, "cloister-router");
  assert.equal(notme.tenancy.trustedTier, true);
  assert.deepEqual(notme.tenancy.sharesWorkerdWith, ["router"]);
  // mache tenancy: partial — mode set, others default
  const mache = parsed.inputs.find((i) => i.name === "mache");
  assert.equal(mache.tenancy.mode, "external");
  assert.equal(mache.tenancy.workerdId, "");
  assert.equal(mache.tenancy.trustedTier, false);
  assert.deepEqual(mache.tenancy.sharesWorkerdWith, []);
  // Roundtrip preserves the populated tenancy declarations.
  const t1 = clusterToToml(parsed);
  const reparsed = await parseTomlToCluster(t1);
  assert.deepEqual(reparsed.inputs, parsed.inputs, "tenancy must roundtrip");
  // Reverse leg is deterministic.
  const t2 = clusterToToml(parsed);
  assert.equal(t1, t2, "cluster-to-toml must be deterministic with tenancy");
});

test("inputs: omitting tenancy parses to all-empty TenancySpec (back-compat)", async () => {
  const { parseTomlToCluster } = await import("../toml-to-cluster.mjs");
  const tomlIn = `
[metadata]
name = "no-tenancy"
version = "0.0.1"

[[bundles]]
name = "x"
description = "x"
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
kind = "external"
  [bundles.external]
  image = "x:0.1"
  ipcSocket = "/x.sock"
  httpPort = 0
  args = []
  env = []

[[wires]]
from = "x"
to = "x"
binding = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[inputs.legacy]
ref = "x"
version = "^0.1"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  const legacy = parsed.inputs.find((i) => i.name === "legacy");
  // Pre-ADR-0030 cluster.toml continues to parse; tenancy block defaults
  // to all-empty (resolver inherits server.json defaults).
  assert.deepEqual(legacy.tenancy, {
    mode: "",
    workerdId: "",
    trustedTier: false,
    sharesWorkerdWith: [],
  });
});

// ── cloister-345ad1 / ADR-0031 Phase 2 — [[routes]] bidi round-trip ─────
//
// The Route discriminated union has 11 variants. Operators write routes
// in `cluster.toml` using the TOML-flat shape:
//
//   [[routes]]
//   path = "/health"
//   kind = "health"
//
//   [[routes]]
//   path = "/identity"
//   kind = "serviceBindingProxy"
//     [routes.serviceBindingProxy]
//     binding = "NOTME"
//     upstreamHost = "notme-bot"
//     stripPrefix = "/identity"
//
// The bidi pipeline un-flattens this to the zod-nested form
// (`kind: { health: null }` for void variants;
// `kind: { serviceBindingProxy: {...} }` for payload variants), and the
// canonicalizer reverses on emit. Round-trip preserves every variant +
// payload field, deterministically.

test("routes: void variant (health) round-trips through TOML", async () => {
  const tomlIn = `
[metadata]
name    = "routes-void"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[routes]]
path = "/health"
kind = "health"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.routes.length, 1, "expected 1 route after unflatten");
  assert.equal(parsed.routes[0].path, "/health");
  assert.deepEqual(parsed.routes[0].kind, { health: null });

  const emitted = clusterToToml(parsed);
  assert.ok(emitted.includes("[[routes]]"), "emitted TOML must carry [[routes]]");
  assert.ok(emitted.includes('path = "/health"'));
  assert.ok(emitted.includes('kind = "health"'));
  // Void variant has NO [routes.health] subtable.
  assert.ok(!emitted.includes("[routes.health]"), "void variant must NOT emit a subtable");

  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.routes, parsed.routes, "void route must round-trip identity");
});

test("routes: serviceBindingProxy variant (payload) round-trips through TOML", async () => {
  const tomlIn = `
[metadata]
name    = "routes-sbp"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[routes]]
path = "/identity"
kind = "serviceBindingProxy"
  [routes.serviceBindingProxy]
  binding      = "NOTME"
  upstreamHost = "notme-bot"
  stripPrefix  = "/identity"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.routes.length, 1);
  assert.equal(parsed.routes[0].path, "/identity");
  assert.deepEqual(parsed.routes[0].kind, {
    serviceBindingProxy: {
      binding: "NOTME",
      upstreamHost: "notme-bot",
      stripPrefix: "/identity",
    },
  });

  // Round-trip the payload variant.
  const emitted = clusterToToml(parsed);
  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.routes, parsed.routes, "payload route must round-trip identity");
});

test("routes: mcp variant with durableObject + mcpProxy backends round-trips", async () => {
  const tomlIn = `
[metadata]
name    = "routes-mcp"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[routes]]
path = "/mcp"
kind = "mcp"

  [[routes.mcp.backends]]
  name          = "bead"
  handlesPrefix = "bead_"
  kind          = "durableObject"
    [routes.mcp.backends.durableObject]
    binding = "BEAD_STORE"
    keyArg  = "repo"
    tools   = []

  [[routes.mcp.backends]]
  name          = "mache"
  handlesPrefix = "mache_"
  kind          = "mcpProxy"
    [routes.mcp.backends.mcpProxy]
    urlBinding      = "MACHE_MCP_URL"
    serviceBinding  = "MACHE_MCP"
    tools           = []
    dynamicTools    = true
    stripPrefix     = "mache_"
    requiresSession = true
    protocolMode    = ""
    claims          = []
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.routes.length, 1);
  assert.equal(parsed.routes[0].path, "/mcp");
  const mcp = parsed.routes[0].kind.mcp;
  assert.ok(mcp, "mcp payload must be present");
  assert.equal(mcp.backends.length, 2);
  assert.equal(mcp.backends[0].name, "bead");
  assert.deepEqual(mcp.backends[0].kind.durableObject, {
    binding: "BEAD_STORE",
    keyArg: "repo",
    tools: [],
  });
  assert.equal(mcp.backends[1].name, "mache");
  assert.equal(mcp.backends[1].kind.mcpProxy.urlBinding, "MACHE_MCP_URL");
  assert.equal(mcp.backends[1].kind.mcpProxy.serviceBinding, "MACHE_MCP");
  assert.equal(mcp.backends[1].kind.mcpProxy.dynamicTools, true);
  assert.equal(mcp.backends[1].kind.mcpProxy.requiresSession, true);

  const emitted = clusterToToml(parsed);
  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.routes, parsed.routes, "mcp route must round-trip identity");
});

test("routes: tenantDispatch variant carries inline tenants table (ADR-0030 §A2)", async () => {
  // Per ADR-0030 §A2 / cloister-0f144c. Multi-tenant routing through
  // SNI or path-prefix dispatch. The TenantDispatchRoute class exists
  // (src/routes/tenant-dispatch.ts) and is referenced by
  // src/manifest/runtime.ts:215. This test pins the operator-facing
  // declaration shape end-to-end through the bidi pipeline.
  const tomlIn = `
[metadata]
name    = "routes-tenant-dispatch"
version = "0.0.1"

[[bundles]]
name                = "alice-bundle"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "alice:0.1"
  ipcSocket = "/run/alice.sock"
  httpPort  = 0
  args      = []
  env       = []

[[bundles]]
name                = "bob-bundle"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "bob:0.1"
  ipcSocket = "/run/bob.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alice-bundle"
to        = "alice-bundle"
binding   = "T_ALICE"
transport = "uds"

[[wires]]
from      = "bob-bundle"
to        = "bob-bundle"
binding   = "T_BOB"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[routes]]
path = "/"
kind = "tenantDispatch"

  [[routes.tenantDispatch.tenants]]
  name       = "alice"
  mode       = "sni"
  matchValue = "alice.cluster.example"
  binding    = "T_ALICE"

  [[routes.tenantDispatch.tenants]]
  name       = "bob"
  mode       = "path-prefix"
  matchValue = "/t/bob"
  binding    = "T_BOB"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.routes.length, 1);
  assert.deepEqual(parsed.routes[0].kind, {
    tenantDispatch: {
      tenants: [
        { name: "alice", mode: "sni",         matchValue: "alice.cluster.example", binding: "T_ALICE" },
        { name: "bob",   mode: "path-prefix", matchValue: "/t/bob",                 binding: "T_BOB"   },
      ],
    },
  });

  const emitted = clusterToToml(parsed);
  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.routes, parsed.routes,
    "tenantDispatch route must round-trip identity (operator config + canonical form agree)");
});

test("routes: vaultProxy variant carries bundleIdName payload", async () => {
  const tomlIn = `
[metadata]
name    = "routes-vp"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[routes]]
path = "/vault/proxy"
kind = "vaultProxy"
  [routes.vaultProxy]
  bundleIdName = "router"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.routes.length, 1);
  assert.deepEqual(parsed.routes[0].kind, { vaultProxy: { bundleIdName: "router" } });

  const emitted = clusterToToml(parsed);
  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.routes, parsed.routes, "vaultProxy route must round-trip identity");
});

test("routes: all void variants emit + parse correctly", async () => {
  // Every void Route.kind variant — sentinel markers for routes whose
  // handler internally dispatches across multiple URLs (well-known
  // discovery doc, OCI v2/*, MCP registry, CA bundle, identity bridge).
  const voidVariants = [
    "wellKnownInterlace",
    "disclosure",
    "wellKnownIdentityBridge",
    "ociRegistry",
    "wellKnownMcpRegistry",
    "caBundle",
  ];

  for (const variant of voidVariants) {
    const tomlIn = `
[metadata]
name    = "routes-void-${variant}"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[routes]]
path = "/sentinel/${variant}"
kind = "${variant}"
`;
    const parsed = await parseTomlToCluster(tomlIn);
    assert.equal(parsed.routes.length, 1, `${variant}: expected 1 route`);
    assert.deepEqual(
      parsed.routes[0].kind,
      { [variant]: null },
      `${variant}: void variant must parse to { ${variant}: null }`,
    );

    const emitted = clusterToToml(parsed);
    assert.ok(
      emitted.includes(`kind = "${variant}"`),
      `${variant}: emitted TOML must carry kind = "${variant}"`,
    );
    assert.ok(
      !emitted.includes(`[routes.${variant}]`),
      `${variant}: void variant must NOT emit a payload subtable`,
    );
    const reparsed = await parseTomlToCluster(emitted);
    assert.deepEqual(reparsed.routes, parsed.routes, `${variant}: must round-trip identity`);
  }
});

test("routes: empty routes array omits [[routes]] section from emitted TOML", async () => {
  // Same back-compat contract as the [inputs] section — pre-Phase-2
  // cluster.toml files don't gain a stray header for empty lists.
  const cluster = {
    metadata: { name: "no-routes", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: EMPTY_GATEWAY,
  };
  const toml = clusterToToml(cluster);
  assert.ok(!toml.includes("[[routes]]"), "empty routes[] must NOT emit a [[routes]] section");
});

test("routes: cluster.toml with no [[routes]] tables parses to empty routes array (back-compat)", async () => {
  const tomlIn = `
[metadata]
name    = "no-routes"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.deepEqual(parsed.routes, [], "missing [[routes]] → empty array");
});

test("routes: full repository fixture (health + sentinels + identity + mcp) round-trips byte-equal", async () => {
  // The richest fixture — every variant the ART default deployment uses.
  // If this passes, real `cluster.toml` migration in Commit 4 is safe.
  const cluster = {
    metadata: { name: "rich-routes", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [
      { path: "/health", kind: { health: null } },
      { path: "/.well-known/interlace/index.json", kind: { wellKnownInterlace: null } },
      { path: "/interlace/peers/:fp", kind: { disclosure: null } },
      { path: "/.well-known/identity-bridge", kind: { wellKnownIdentityBridge: null } },
      { path: "/v2", kind: { ociRegistry: null } },
      { path: "/.well-known/mcp-registry", kind: { wellKnownMcpRegistry: null } },
      { path: "/interlace/ca-bundle", kind: { caBundle: null } },
      {
        path: "/identity",
        kind: {
          serviceBindingProxy: {
            binding: "NOTME",
            upstreamHost: "notme-bot",
            stripPrefix: "/identity",
          },
        },
      },
      {
        path: "/mcp",
        kind: {
          mcp: {
            backends: [
              {
                name: "bead",
                handlesPrefix: "bead_",
                kind: {
                  durableObject: {
                    binding: "BEAD_STORE",
                    keyArg: "repo",
                    tools: [],
                  },
                },
              },
            ],
          },
        },
      },
    ],
    gateway: EMPTY_GATEWAY,
  };
  const t1 = clusterToToml(cluster);
  const back = await parseTomlToCluster(t1);
  assert.deepEqual(back.routes, cluster.routes, "round-trip must preserve all routes");
  const t2 = clusterToToml(back);
  assert.equal(t2, t1, "rich-routes canonical form must be byte-stable");
});

// ── cloister-c919d7 / ADR-0031 Phase 4a — [gateway] bidi round-trip ─────
//
// The `[gateway]` block carries operator-authored Gateway-level surface
// (metadata + actor + policy). The bidi pipeline must round-trip every
// field losslessly + drop empty fields on emission so the canonical
// form stays minimal.

test("gateway: TOML [gateway.metadata] + [gateway.actor] + [gateway.policy] roundtrip", async () => {
  const tomlIn = `
[metadata]
name    = "with-gateway"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[gateway.metadata]
name    = "cloister-test"
version = "0.0.1"

[gateway.actor]
fingerprint     = "sha256:abc123"
algorithm       = "ed25519"
pubkeyBinding   = "INTERLACE_MASTER_PUBKEY"
attestationRepo = ""
tunnelEndpoint  = ""

[gateway.policy]
maxCertLifetimeSeconds = 300
requireInterlock       = true
minAlgorithm           = "ed25519"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.gateway.metadata.name, "cloister-test");
  assert.equal(parsed.gateway.metadata.version, "0.0.1");
  assert.equal(parsed.gateway.actor.fingerprint, "sha256:abc123");
  assert.equal(parsed.gateway.actor.algorithm, "ed25519");
  assert.equal(parsed.gateway.actor.pubkeyBinding, "INTERLACE_MASTER_PUBKEY");
  assert.equal(parsed.gateway.policy.maxCertLifetimeSeconds, 300);
  assert.equal(parsed.gateway.policy.requireInterlock, true);
  assert.equal(parsed.gateway.policy.minAlgorithm, "ed25519");
  assert.deepEqual(parsed.gateway.vaultProxyServices, []);

  // Forward → reverse leg: roundtrip preserves every populated field.
  const emitted = clusterToToml(parsed);
  assert.ok(emitted.includes("[gateway.metadata]"),  "emitted TOML must carry [gateway.metadata]");
  assert.ok(emitted.includes('name = "cloister-test"'), "metadata.name must round-trip");
  assert.ok(emitted.includes("[gateway.actor]"),     "emitted TOML must carry [gateway.actor]");
  assert.ok(emitted.includes('fingerprint = "sha256:abc123"'));
  assert.ok(emitted.includes("[gateway.policy]"),    "emitted TOML must carry [gateway.policy]");
  assert.ok(emitted.includes("maxCertLifetimeSeconds = 300"));
  assert.ok(emitted.includes("requireInterlock = true"));

  // Empty fields (attestationRepo, tunnelEndpoint) are dropped from the
  // canonical emit so operators see only what they actually set.
  assert.ok(!emitted.includes('attestationRepo = ""'), "empty fields must NOT appear in canonical TOML");
  assert.ok(!emitted.includes('tunnelEndpoint = ""'), "empty fields must NOT appear in canonical TOML");

  // Second roundtrip is a fixed point.
  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.gateway, parsed.gateway, "gateway must round-trip identity");
});

test("gateway: vaultProxyServices roundtrip through cluster.toml", async () => {
  const tomlIn = `
[metadata]
name    = "with-vault-proxy-services"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"

[[gateway.vaultProxyServices]]
name = "anthropic"
upstreamBaseUrl = "https://api.anthropic.com"
defaultAllowedSubs = ["sha256:harness:*"]
rateLimitPerMinute = 120
injection = "headerNamed"
  [gateway.vaultProxyServices.headerNamed]
  name = "x-api-key"

[[gateway.vaultProxyServices]]
name = "anthropic-compatible"
upstreamBaseUrl = "https://gw.example/anthropic"
defaultAllowedSubs = []
rateLimitPerMinute = 60
injection = "authorizationBearer"
`;

  const parsed = await parseTomlToCluster(tomlIn);
  assert.deepEqual(parsed.gateway.vaultProxyServices, [
    {
      name: "anthropic",
      upstreamBaseUrl: "https://api.anthropic.com",
      defaultAllowedSubs: ["sha256:harness:*"],
      rateLimitPerMinute: 120,
      injection: { headerNamed: { name: "x-api-key" } },
    },
    {
      name: "anthropic-compatible",
      upstreamBaseUrl: "https://gw.example/anthropic",
      defaultAllowedSubs: [],
      rateLimitPerMinute: 60,
      injection: { authorizationBearer: null },
    },
  ]);

  const emitted = clusterToToml(parsed);
  assert.ok(emitted.includes("[[gateway.vaultProxyServices]]"));
  assert.match(emitted, /defaultAllowedSubs = \[\s*\]/);
  assert.ok(emitted.includes('injection = "headerNamed"'));
  assert.ok(emitted.includes("[gateway.vaultProxyServices.headerNamed]"));
  assert.ok(emitted.includes('name = "x-api-key"'));
  assert.ok(emitted.includes('name = "anthropic-compatible"'));
  assert.ok(emitted.includes('injection = "authorizationBearer"'));

  const reparsed = await parseTomlToCluster(emitted);
  assert.deepEqual(reparsed.gateway.vaultProxyServices, parsed.gateway.vaultProxyServices);
});

test("gateway: cluster.toml with NO [gateway] table parses to all-empty default (back-compat)", async () => {
  const tomlIn = `
[metadata]
name    = "no-gateway"
version = "0.0.1"

[[bundles]]
name                = "alpha"
description         = ""
tier                = "cluster"
holdsCredential     = []
workerdServiceName  = ""
hypervisorRationale = ""
kind                = "external"
  [bundles.external]
  image     = "a:0.1"
  ipcSocket = "/run/a.sock"
  httpPort  = 0
  args      = []
  env       = []

[[wires]]
from      = "alpha"
to        = "alpha"
binding   = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  // Schema requires the field; missing TOML block → canonical all-empty.
  assert.deepEqual(parsed.gateway, EMPTY_GATEWAY, "missing [gateway] → all-empty default");
});

test("gateway: empty Gateway object omits the [gateway] section from emitted TOML (back-compat)", () => {
  // Same contract as the [inputs] + [[routes]] empty-omit rules —
  // pre-Phase-4a cluster.toml files don't gain a stray header for
  // the all-empty back-compat default value.
  const cluster = {
    metadata: { name: "no-gateway-emit", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: EMPTY_GATEWAY,
  };
  const toml = clusterToToml(cluster);
  assert.ok(!toml.includes("[gateway"), "all-empty gateway must NOT emit a [gateway] section");
});

test("gateway: partial population (only metadata.name) emits only that subtable", () => {
  // Operator who sets only one field shouldn't see the other empty
  // subtables in the canonical form — drops to minimal surface.
  const cluster = {
    metadata: { name: "partial", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: {
      metadata: { name: "cloister-partial", version: "" },
      actor: { fingerprint: "", algorithm: "", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
      policy: { maxCertLifetimeSeconds: 0, requireInterlock: false, minAlgorithm: "" },
      vaultProxyServices: [],
    },
  };
  const toml = clusterToToml(cluster);
  assert.ok(toml.includes("[gateway.metadata]"),  "populated metadata block must emit");
  assert.ok(toml.includes('name = "cloister-partial"'));
  assert.ok(!toml.includes("[gateway.actor]"),    "empty actor block must NOT emit");
  assert.ok(!toml.includes("[gateway.policy]"),   "empty policy block must NOT emit");
});

test("gateway: requireInterlock = false lands in TOML when other fields are set (oss-launch-minimal shape)", () => {
  // oss-launch-minimal explicitly sets `requireInterlock = false` to
  // disable Interlace's bilateral chain requirement. That `false` is a
  // meaningful operator choice + must appear in the canonical TOML
  // when other gateway fields are populated.
  const cluster = {
    metadata: { name: "permissive", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: {
      metadata: { name: "cloister-permissive", version: "0.0.1" },
      actor: { fingerprint: "", algorithm: "ed25519", pubkeyBinding: "", attestationRepo: "", tunnelEndpoint: "" },
      policy: { maxCertLifetimeSeconds: 300, requireInterlock: false, minAlgorithm: "ed25519" },
      vaultProxyServices: [],
    },
  };
  const toml = clusterToToml(cluster);
  assert.ok(toml.includes("requireInterlock = false"), "explicit false must land in TOML");
  assert.ok(toml.includes("algorithm = \"ed25519\""), "actor.algorithm must round-trip");
  assert.ok(toml.includes("maxCertLifetimeSeconds = 300"));
});

test("gateway: canonical roundtrip is byte-equal across two emissions", async () => {
  // The load-bearing drift gate property: emit → parse → emit
  // produces identical bytes.
  const cluster = {
    metadata: { name: "bytes", version: "0.0.1" },
    bundles: [],
    wires: [],
    storage: { doStoragePath: "/data/do" },
    inputs: [],
    routes: [],
    gateway: {
      metadata: { name: "cloister-bytes", version: "0.0.1" },
      actor: {
        fingerprint:     "sha256:placeholder-pinned-at-deploy-time",
        algorithm:       "ed25519",
        pubkeyBinding:   "INTERLACE_MASTER_PUBKEY",
        attestationRepo: "",
        tunnelEndpoint:  "",
      },
      policy: { maxCertLifetimeSeconds: 300, requireInterlock: true, minAlgorithm: "ed25519" },
      vaultProxyServices: [],
    },
  };
  const t1 = clusterToToml(cluster);
  const back = await parseTomlToCluster(t1);
  const t2 = clusterToToml(back);
  assert.equal(t2, t1, "gateway canonical form must be byte-stable");
});

// ── cloister-cedcf3 Phase 1: perTenant field ────────────────────────────

test("bundles: pre-cedcf3 cluster.toml WITHOUT perTenant defaults to false (back-compat)", async () => {
  // Operators with existing cluster.toml that predates cloister-cedcf3
  // MUST NOT have to add `perTenant = false` to every bundle. The
  // unflattener defaults the field at parse time.
  const tomlIn = `
[metadata]
name = "back-compat"
version = "0.0.1"

[[bundles]]
name = "alpha"
description = ""
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
kind = "external"
  [bundles.external]
  image = "alpha:0.1"
  ipcSocket = "/run/alpha.sock"
  httpPort = 0
  args = []
  env = []

[[wires]]
from = "alpha"
to = "alpha"
binding = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.bundles[0].perTenant, false, "perTenant must default to false");
});

test("bundles: explicit perTenant = true is preserved through the roundtrip", async () => {
  // ADR-0034 acceptance: per-tenant rsry sidecar declares
  // `perTenant = true`. Phase 1 of cedcf3 makes the field operator-
  // declarable; Phase 2 makes emit-compose consume it.
  const tomlIn = `
[metadata]
name = "per-tenant"
version = "0.0.1"

[[bundles]]
name = "rosary"
description = ""
tier = "cluster"
holdsCredential = []
workerdServiceName = ""
hypervisorRationale = ""
perTenant = true
kind = "external"
  [bundles.external]
  image = "rosary:0.2.0"
  ipcSocket = "/run/rosary.sock"
  httpPort = 0
  args = []
  env = []

[[wires]]
from = "rosary"
to = "rosary"
binding = "SELF"
transport = "uds"

[storage]
doStoragePath = "/data/do"
`;
  const parsed = await parseTomlToCluster(tomlIn);
  assert.equal(parsed.bundles[0].perTenant, true, "perTenant=true preserved through parse");

  const emitted = clusterToToml(parsed);
  assert.match(emitted, /perTenant = true/, "perTenant=true emitted into canonical TOML");

  const reparsed = await parseTomlToCluster(emitted);
  assert.equal(reparsed.bundles[0].perTenant, true, "perTenant=true survives roundtrip");
});
