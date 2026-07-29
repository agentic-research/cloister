// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for lint:binding-parity (cloister-9aeb3f).
//
// The rail asserts that a binding read in src/ resolves on BOTH deployment
// paths. These tests assert the rail itself: that it holds against the
// SHIPPED tree, that its extractors actually extract, and that it would catch
// the drift it was written for rather than passing vacuously.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  bindingsReadInSrc,
  bindingsInConfigCapnp,
  bindingsInWrangler,
  findViolations,
  DECLARED_ASYMMETRY,
} from "../lint-binding-parity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ── The rail holds against the real tree ──────────────────────────────────

test("the shipped tree has binding parity", () => {
  assert.deepEqual(
    findViolations(ROOT).map((v) => `${v.name} missing from ${v.missingFrom}`),
    [],
  );
});

// ── Each extractor actually extracts ──────────────────────────────────────
//
// Guards the vacuous pass three ways: a rail comparing two empty sets reports
// clean forever, and that is precisely the failure this rail exists to catch
// one layer down.

test("src/ extraction finds the bindings the code actually reads", () => {
  const read = bindingsReadInSrc(ROOT);
  assert.ok(read.size > 15, `expected many bindings read, got ${read.size}`);
  // Spot-check the trust-surface one this rail was written for.
  assert.ok(read.has("INTERLACE_ROOT_PUBKEY"));
});

test("config.capnp extraction finds bindings, not service names", () => {
  const cfg = bindingsInConfigCapnp(ROOT);
  assert.ok(cfg.has("BEAD_STORE"), "DO binding");
  assert.ok(cfg.has("INTERLACE_ROOT_PUBKEY"), "the binding this rail added");
  // Service/socket names are lower-kebab and must NOT be read as bindings —
  // the case discrimination the extractor depends on.
  assert.ok(!cfg.has("mache-mcp"));
  assert.ok(!cfg.has("cloister"));
});

test("wrangler.toml extraction reads INLINE durable-object tables", () => {
  // The first implementation regexed line-anchored `name = "X"` and missed
  // every DO binding, because wrangler declares them as inline tables inside
  // a `bindings = [ ... ]` array. It reported four phantom violations. This
  // pins the parse that replaced it.
  const wr = bindingsInWrangler(ROOT);
  assert.ok(wr.has("BEAD_STORE"), "inline DO binding must be seen");
  assert.ok(wr.has("TRUST_STORE"));
  assert.ok(wr.has("INTERLACE_ROOT_PUBKEY"), "[vars] entry must be seen");
});

// ── The rail would catch real drift ───────────────────────────────────────

test("a binding read in src/ but present on only one path is a violation", () => {
  // Synthetic tree: src reads GHOST_BINDING; wrangler declares it; capnp
  // does not. That is exactly the shape of the drift this rail was written
  // for (six trust-surface vars, CF-only).
  const dir = mkdtempSync(resolve(tmpdir(), "binding-parity-"));
  try {
    mkdirSync(resolve(dir, "src"));
    writeFileSync(resolve(dir, "src/x.ts"), "const k = env.GHOST_BINDING;\n");
    writeFileSync(resolve(dir, "wrangler.toml"), "[vars]\nGHOST_BINDING = \"x\"\n");
    // capnp needs enough real-looking bindings to clear the non-vacuity floor.
    const filler = Array.from({ length: 16 }, (_, i) => `( name = "FILLER_${i}", text = "" ),`).join("\n");
    writeFileSync(resolve(dir, "config.capnp"), `bindings = [\n${filler}\n]\n`);

    const violations = findViolations(dir);
    assert.deepEqual(violations, [{ name: "GHOST_BINDING", missingFrom: "config.capnp" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared asymmetry is skipped, and every entry states a reason", () => {
  for (const [name, reason] of Object.entries(DECLARED_ASYMMETRY)) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 20, `${name} needs a real reason, got ${JSON.stringify(reason)}`);
  }
  // And they are genuinely one-sided in the tree — an entry that is actually
  // present on both paths is stale and should be deleted, not carried.
  const cfg = bindingsInConfigCapnp(ROOT);
  const wr = bindingsInWrangler(ROOT);
  for (const name of Object.keys(DECLARED_ASYMMETRY)) {
    assert.ok(
      !(cfg.has(name) && wr.has(name)),
      `${name} is declared asymmetric but exists on both paths — delete the entry`,
    );
  }
});
