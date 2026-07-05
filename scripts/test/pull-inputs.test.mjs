// scripts/test/pull-inputs.test.mjs
//
// Run with:  node --test scripts/test/pull-inputs.test.mjs
//
// Unit tests for the pure ref-resolution helpers in pull-inputs.mjs
// (ociPullRef precedence + collectOciRefs lockfile walk). The pull
// itself shells out to a container runtime and isn't unit-tested here.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ociPullRef, collectOciRefs } from "../pull-inputs.mjs";

// ── ociPullRef: ADR-0038 precedence ──────────────────────────────────

test("ociPullRef: digest wins (content-addressed)", () => {
  assert.equal(
    ociPullRef({ identifier: "ghcr.io/org/tool", version: "1.2.3", digest: "sha256:abc" }),
    "ghcr.io/org/tool@sha256:abc",
  );
});

test("ociPullRef: version when no digest", () => {
  assert.equal(
    ociPullRef({ identifier: "ghcr.io/org/tool", version: "1.2.3" }),
    "ghcr.io/org/tool:1.2.3",
  );
});

test("ociPullRef: bare identifier when neither digest nor version", () => {
  assert.equal(ociPullRef({ identifier: "ghcr.io/org/tool" }), "ghcr.io/org/tool");
});

test("ociPullRef: null / missing identifier → null", () => {
  assert.equal(ociPullRef(null), null);
  assert.equal(ociPullRef(undefined), null);
  assert.equal(ociPullRef({}), null);
  assert.equal(ociPullRef({ version: "1.0.0" }), null);
  assert.equal(ociPullRef({ identifier: "   " }), null);
});

// ── collectOciRefs: lockfile walk ────────────────────────────────────

test("collectOciRefs: one row per input; ref null when no oci; pinned only for digest", () => {
  const doc = {
    inputs: {
      llo:    { sha256: "sha256:1", oci: { identifier: "ghcr.io/org/llo", version: "0.5.6" } },
      pinned: { sha256: "sha256:2", oci: { identifier: "ghcr.io/org/x", digest: "sha256:dd" } },
      mache:  { sha256: "sha256:3" }, // no oci
    },
  };
  const rows = collectOciRefs(doc);
  assert.deepEqual(rows, [
    { name: "llo",    ref: "ghcr.io/org/llo:0.5.6",   pinned: false },
    { name: "pinned", ref: "ghcr.io/org/x@sha256:dd", pinned: true },
    { name: "mache",  ref: null,                       pinned: false },
  ]);
});

test("collectOciRefs: empty / missing inputs table → []", () => {
  assert.deepEqual(collectOciRefs({}), []);
  assert.deepEqual(collectOciRefs({ inputs: {} }), []);
  assert.deepEqual(collectOciRefs(null), []);
});
