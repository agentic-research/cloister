// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint-trust-env-locality.mjs — cloister-21e42e rail. No regex
// assertions per operator request — substring + structural checks only.
//
// Run with: node --import tsx --test scripts/test/lint-trust-env-locality.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readsEnvVar, findViolations, collectViolations, OWNED } from "../lint-trust-env-locality.mjs";

test("readsEnvVar matches a whole-identifier read", () => {
  assert.equal(readsEnvVar("const x = env.RECEIPT_EPOCH;", "RECEIPT_EPOCH"), true);
  assert.equal(readsEnvVar("if (!env.VAULT_KEK_SOURCE) {}", "VAULT_KEK_SOURCE"), true);
});

test("readsEnvVar does NOT match a longer identifier (word boundary)", () => {
  // env.RECEIPT_EPOCHS must not match env.RECEIPT_EPOCH.
  assert.equal(readsEnvVar("env.RECEIPT_EPOCHS", "RECEIPT_EPOCH"), false);
  // VAULT_KEK_SOURCE must not match on VAULT_KEK_TENANT_SCOPED.
  assert.equal(readsEnvVar("env.VAULT_KEK_TENANT_SCOPED", "VAULT_KEK_SOURCE"), false);
});

test("flags a trust-secret env read outside its resolver", () => {
  const v = findViolations("src/routes/mcp.ts", "if (!env.VAULT_KEK_SOURCE) skipEncryption();");
  assert.equal(v.length, 1);
  assert.equal(v[0].name, "VAULT_KEK_SOURCE");
  assert.equal(v[0].line, 1);
});

test("allows the owning resolver to read it", () => {
  const text = "const spec = env.VAULT_KEK_SOURCE;";
  assert.equal(findViolations("src/vault-store.ts", text).length, 0);
});

test("DEV_CA_MASTER has two legitimate owners (gate + bundle source)", () => {
  const text = "const m = env.DEV_CA_MASTER;";
  assert.equal(findViolations("src/routes/lease-gate.ts", text).length, 0);
  assert.equal(findViolations("src/storage/ca-bundle-source.ts", text).length, 0);
  assert.equal(findViolations("src/routes/somewhere-else.ts", text).length, 1);
});

test("a file with no trust-secret read is clean", () => {
  assert.equal(findViolations("src/routes/health.ts", "return env.ROSARY_MCP_URL || 'x';").length, 0);
});

test("the OWNED table covers the receipt + vault + dev-CA + dev-overlay secrets", () => {
  const names = new Set(OWNED.map((o) => o.name));
  for (const expected of ["RECEIPT_SIGNING_KEY", "VAULT_KEK_SOURCE", "DEV_CA_MASTER", "DEV_PASSTHROUGH_SERVICES"]) {
    assert.ok(names.has(expected), `OWNED should cover ${expected}`);
  }
});

test("the shipped src/ tree satisfies trust-env locality (no scatter)", () => {
  // The live guard: every trust-secret env var is read only in its resolver. If
  // this fails, a scattered read landed — exactly where an empty-value-means-off
  // footgun would next hide (cloister-21e42e).
  assert.deepEqual(collectViolations(), []);
});
