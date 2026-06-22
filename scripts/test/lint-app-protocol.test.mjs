// scripts/test/lint-app-protocol.test.mjs
//
// Run with: pnpm exec tsx --test scripts/test/lint-app-protocol.test.mjs
//
// Unit + integration tests for `validateAppProtocol` and the
// `lint-app-protocol.mjs` CLI. Mirrors the shape of
// lint-capability-scheme.test.mjs.
//
// Per cloister-0fa3d7 (ADR-0030 §A4).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAppProtocol, collectViolations, BLESSED_LABELS } from "../lint-app-protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-app-protocol.mjs");

// ── Unit: validateAppProtocol — accepts the blessed set ──────────────────

test("validateAppProtocol: accepts every substrate-blessed label", () => {
  for (const label of BLESSED_LABELS) {
    assert.equal(
      validateAppProtocol(label),
      null,
      `blessed label rejected: ${label}`,
    );
  }
});

test("validateAppProtocol: blessed set contains the ADR-0030 §A4 initial members", () => {
  // Pin the initial blessed set so a refactor that drops one would
  // surface here loudly (the substrate guarantee changes only via PR
  // + ADR amendment).
  const expected = [
    "art.mcp-jsonrpc",
    "art.interlace-capnp",
    "art.capnp-uds",
    "art.http",
    "art.http2",
    "art.grpc",
    "art.tcp",
    "art.tls",
  ];
  for (const e of expected) assert.ok(BLESSED_LABELS.includes(e), `missing: ${e}`);
});

// ── Unit: validateAppProtocol — rejects unknown art.* ────────────────────

test("validateAppProtocol: rejects unknown art.* (closed-set property)", () => {
  const r = validateAppProtocol("art.unknown");
  assert.ok(typeof r === "string" && r.includes("not a substrate-blessed"));
});

test("validateAppProtocol: rejects art. with empty tail", () => {
  const r = validateAppProtocol("art.");
  assert.ok(typeof r === "string" && r.includes("not a substrate-blessed"));
});

// ── Unit: validateAppProtocol — vendor-extensible namespace ──────────────

test("validateAppProtocol: accepts well-formed x-<vendor>-<protocol>", () => {
  assert.equal(validateAppProtocol("x-myorg-redis"), null);
  assert.equal(validateAppProtocol("x-acme-bespoke-rpc"), null);
  assert.equal(validateAppProtocol("x-a-b"), null);
  // multi-segment protocol after vendor is fine (kebab path)
  assert.equal(validateAppProtocol("x-myorg-redis-v2"), null);
});

test("validateAppProtocol: rejects x- with empty vendor", () => {
  assert.ok(validateAppProtocol("x-").includes("empty"));
});

test("validateAppProtocol: rejects x-vendor without protocol segment", () => {
  const r = validateAppProtocol("x-myorg");
  assert.ok(typeof r === "string" && r.includes("x- namespace requires"));
});

test("validateAppProtocol: rejects x-vendor- with empty trailing protocol", () => {
  const r = validateAppProtocol("x-myorg-");
  assert.ok(typeof r === "string" && r.includes("missing protocol segment"));
});

test("validateAppProtocol: rejects non-kebab vendor", () => {
  const r = validateAppProtocol("x-MyOrg-redis");
  assert.ok(typeof r === "string" && r.includes("non-kebab"));
});

test("validateAppProtocol: rejects non-kebab protocol", () => {
  const r = validateAppProtocol("x-myorg-Redis");
  assert.ok(typeof r === "string" && r.includes("non-kebab"));
});

test("validateAppProtocol: rejects doubled hyphen in protocol path", () => {
  const r = validateAppProtocol("x-myorg-foo--bar");
  assert.ok(typeof r === "string" && r.includes("doubled hyphen"));
});

// ── Unit: validateAppProtocol — totally non-conforming shapes ────────────

test("validateAppProtocol: rejects bare protocol name (no namespace)", () => {
  const r = validateAppProtocol("redis");
  assert.ok(typeof r === "string" && r.includes("does not match"));
});

test("validateAppProtocol: rejects ALL-CAPS label", () => {
  const r = validateAppProtocol("ART.HTTP");
  assert.ok(typeof r === "string" && r.includes("does not match"));
});

test("validateAppProtocol: rejects non-string / empty", () => {
  assert.equal(validateAppProtocol(""), "empty string");
  assert.equal(validateAppProtocol(null), "not a string");
  assert.equal(validateAppProtocol(undefined), "not a string");
  assert.equal(validateAppProtocol(42), "not a string");
});

// ── Unit: collectViolations ──────────────────────────────────────────────

test("collectViolations: returns empty for a cluster with no edges", () => {
  const cluster = { edges: [] };
  assert.deepEqual(collectViolations(cluster), []);
});

test("collectViolations: returns empty when edges is missing entirely (back-compat)", () => {
  const cluster = {};
  assert.deepEqual(collectViolations(cluster), []);
});

test("collectViolations: surfaces each violating edge with from/to/value", () => {
  const cluster = {
    edges: [
      { from: "alice", to: "bob",   appProtocol: "art.mcp-jsonrpc",   transport: "" }, // ok
      { from: "alice", to: "carol", appProtocol: "redis",             transport: "" }, // bad
      { from: "bob",   to: "alice", appProtocol: "ART.HTTP",          transport: "" }, // bad
      { from: "carol", to: "bob",   appProtocol: "x-myorg-bespoke",   transport: "" }, // ok
      { from: "alice", to: "dave",  appProtocol: "art.unknown",       transport: "" }, // bad (closed set)
    ],
  };
  const v = collectViolations(cluster);
  assert.equal(v.length, 3);
  assert.equal(v[0].idx, 1);
  assert.equal(v[0].value, "redis");
  assert.equal(v[1].idx, 2);
  assert.equal(v[1].value, "ART.HTTP");
  // `art.unknown` is the 5th edge (original-array index 4); the conformant
  // x-myorg-bespoke at index 3 is skipped. idx tracks the original
  // position, not the violation-array position.
  assert.equal(v[2].idx, 4);
  assert.equal(v[2].value, "art.unknown");
});

// ── Integration: invoke as subprocess against synthetic cluster.ts ───────

function spawnLint(envOverride) {
  return spawnSync(process.execPath, [LINT_SCRIPT], {
    env: { ...process.env, ...envOverride },
    encoding: "utf-8",
  });
}

function writeFixtureClusterTs(dir, edges) {
  const path = join(dir, "cluster.ts");
  const body = `export const cluster = ${JSON.stringify({ edges }, null, 2)};\n`;
  writeFileSync(path, body);
  return path;
}

test("integration: clean exit on a cluster with all-conformant edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-ap-pass-"));
  try {
    const cts = writeFixtureClusterTs(dir, [
      { from: "alice", to: "bob",   appProtocol: "art.mcp-jsonrpc", transport: "" },
      { from: "bob",   to: "carol", appProtocol: "x-myorg-redis",   transport: "" },
    ]);
    const r = spawnLint({ CLUSTER_TS: cts });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("clean ✓"));
    assert.ok(r.stdout.includes("2 edge(s) walked"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: clean exit on a cluster with no edges (back-compat)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-ap-empty-"));
  try {
    const cts = writeFixtureClusterTs(dir, []);
    const r = spawnLint({ CLUSTER_TS: cts });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("0 edge(s) walked"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: exit 1 with actionable error on non-conforming label", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-ap-fail-"));
  try {
    const cts = writeFixtureClusterTs(dir, [
      { from: "alice", to: "bob", appProtocol: "redis", transport: "" },
    ]);
    const r = spawnLint({ CLUSTER_TS: cts });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("1 violation"));
    assert.ok(r.stderr.includes("from=alice → to=bob"));
    assert.ok(r.stderr.includes("Namespace rules per ADR-0030 §A4"));
    assert.ok(r.stderr.includes("art.<name>"));
    assert.ok(r.stderr.includes("x-<vendor>-<proto>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: exit 2 toolchain-error when cluster.ts missing", () => {
  const r = spawnLint({ CLUSTER_TS: "/does/not/exist/cluster.ts" });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("cluster source not found"));
});
