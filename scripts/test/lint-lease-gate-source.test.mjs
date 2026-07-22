// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint-lease-gate-source.mjs — the ADR-0053 single-source guard
// (cloister-220c9d) and cloister-bd7210 Phase 1 rail. No regex assertions per
// operator request — substring + structural checks only.
//
// Run with: node --import tsx --test scripts/test/lint-lease-gate-source.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findViolations, collectViolations } from "../lint-lease-gate-source.mjs";

test("flags a route that reads env.INTERLACE_ROOT_PUBKEY directly", () => {
  const text = "if (env.INTERLACE_ROOT_PUBKEY) { enforce(); }";
  const v = findViolations("src/routes/mcp.ts", text);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
  assert.ok(v[0].fix.includes("resolveLeaseGate"), "fix should point at the resolver");
});

test("allows the two legitimate homes to read it", () => {
  const text = "const hasAuthority = !!env.INTERLACE_ROOT_PUBKEY;";
  assert.equal(findViolations("src/routes/lease-gate.ts", text).length, 0);
  assert.equal(findViolations("src/storage/ca-bundle-source.ts", text).length, 0);
});

test("a clean file using the resolver is not flagged", () => {
  const text = "if (leaseEnforced(env)) { enforce(); }\nreturn null;";
  assert.equal(findViolations("src/routes/mcp.ts", text).length, 0);
});

test("reports the correct line number on a multi-line file", () => {
  const text = "line one\nline two\nif (!env.INTERLACE_ROOT_PUBKEY) return null;";
  const v = findViolations("src/routes/oci-registry.ts", text);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
});

test("the shipped src/ tree satisfies the invariant (220c9d holds)", () => {
  // The whole point of the rail: the live code has a single source of truth for
  // the lease-gate decision. If this ever fails, a re-scattered gate check landed.
  assert.deepEqual(collectViolations(), []);
});
