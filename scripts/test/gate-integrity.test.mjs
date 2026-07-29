// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Properties of the VERIFICATION SYSTEM ITSELF.
//
// cloister-846228 / cloister-70df69 / cloister-61c638.
//
// Every other test in this tree asserts something about cloister. These assert
// things about the gate that runs those tests — the layer that decides whether
// a green result means anything. Three failures found this session all live
// here, and all three were invisible to the gate by construction:
//
//   846228  a test file existed and was never executed. The gate reported a
//           healthy count while ignoring it. FALSE CONFIDENCE.
//   70df69  tests that spawn `task manifest` fail in a worktree and pass in
//           the main checkout, because they inherit an env the harness does
//           not supply. FALSE ALARM — and indistinguishable from a real
//           regression until you check, which cost two investigations today.
//   61c638  the declared surface (cluster.ts) and the resolved surface
//           (cluster.lock.toml) disagree about the same field, so a reader of
//           the declared file concludes something the substrate contradicts.
//           MISLEADING ARTIFACT.
//
// Written property-first: each property is stated over ALL members of a set
// (every test file, every derived field), not over the instances that happened
// to break. An example-based test would have pinned oci-artifact.test.mjs and
// requiresSession; the properties catch the next one.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@iarna/toml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Assert a predicate over EVERY member of a finite set, reporting all
 * violations at once.
 *
 * Why not fast-check here. The first draft used `fc.constantFrom(...items)`,
 * which SAMPLES: 12 draws from 4 recipes can miss one, and it did — the
 * property passed while recipes/multi-tenant-smoke was genuinely broken. A
 * sampling check over a small finite domain is a vacuous pass waiting to
 * happen, which is the failure this whole file exists to catch.
 *
 * fast-check earns its place below on GENERATED input, where the domain is
 * large and examples cannot be enumerated. Real trees get enumerated.
 */
function forAll(items, describe, predicate) {
  const violations = items.filter((i) => !predicate(i));
  assert.deepEqual(violations.map(describe), [], `${violations.length} of ${items.length} failed`);
}

// ── 846228: every test file on disk is executed by the gate ───────────────

/** Test files present on disk, by directory. */
function testFilesOnDisk(dir) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => f.endsWith(".test.mjs"));
}

/** Test files the Taskfile actually invokes. */
function testFilesInvoked() {
  // lint-allow-rawparse: reads Taskfile TEXT to learn which files the gate
  // NAMES. A YAML parse yields the same command string, but the invocation may
  // live in a cmds: entry, a var, or an included Taskfile — the literal text is
  // what "does the gate name this file" actually means.
  const taskfile = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
  return new Set([...taskfile.matchAll(/([\w/.-]+\.test\.mjs)/g)].map((m) => basename(m[1])));
}

test("PROPERTY: every scripts/test file on disk is invoked by the gate", () => {
  const invoked = testFilesInvoked();
  const onDisk = testFilesOnDisk("scripts/test");
  assert.ok(onDisk.length > 20, `sanity: expected many test files, found ${onDisk.length}`);

  // A file on disk the gate never names is a test that CANNOT fail — strictly
  // worse than no test, because it reports coverage it does not provide.
  // oci-artifact.test.mjs sat dark this way since #189.
  forAll(onDisk, (f) => `${f} is on disk but the gate never names it`, (f) => invoked.has(f));
});

test("PROPERTY: the gate names no test file that does not exist", () => {
  // The other direction. A named-but-absent file is either a silent skip or a
  // hard error depending on the runner — neither should be discovered later.
  const onDisk = new Set([
    ...testFilesOnDisk("scripts/test"),
    ...testFilesOnDisk("tools/harness-sandbox/test"),
  ]);
  const named = [...testFilesInvoked()];
  assert.ok(named.length > 20, `sanity: expected many named files, found ${named.length}`);
  forAll(named, (f) => `${f} is named by the gate but absent from disk`, (f) => onDisk.has(f));
});

// ── 61c638: declared surface never contradicts resolved surface ───────────

/**
 * Fields that resolve-inputs.mjs DERIVES rather than the operator declaring.
 * A derived field may be absent from the declared surface; it must never be
 * present-and-different, because that is the only case a reader can be misled
 * by (absent reads as "look elsewhere", wrong reads as "this is the answer").
 */
const DERIVED_INPUT_FIELDS = ["requiresSession"];

/**
 * Inputs as the OPERATOR declared them — read from cluster.toml, where an
 * undeclared field is genuinely absent.
 *
 * Deliberately NOT src/generated/cluster.ts. That file zero-fills every
 * undeclared field, so `requiresSession: false` there means either "the
 * operator chose false" or "nobody said" — indistinguishable, and wrong in
 * 3 of 4 inputs today (llo, mache, canonical-hours all resolve true). That
 * ambiguity is real and tracked as cloister-61c638; fixing it means deciding
 * whether the declared surface should carry derived values at all, which is a
 * design change and not something to smuggle into a test.
 *
 * The invariant that IS correct and enforceable now: when an operator states
 * a value explicitly, the substrate must not silently resolve the opposite.
 * That is the case where someone gets what they did not ask for.
 */
function operatorDeclaredInputs() {
  const doc = parseToml(readFileSync(resolve(ROOT, "cluster.toml"), "utf8"));
  return Object.entries(doc.inputs ?? {}).map(([name, spec]) => ({ name, ...spec }));
}

function resolvedInputs() {
  const lock = parseToml(readFileSync(resolve(ROOT, "cluster.lock.toml"), "utf8"));
  const byInput = new Map();
  for (const row of lock.generated_backends ?? []) {
    if (!byInput.has(row.input)) byInput.set(row.input, row);
  }
  return byInput;
}

test("PROPERTY: an explicit operator declaration is never contradicted by the resolved value", () => {
  const declared = operatorDeclaredInputs();
  const resolved = resolvedInputs();
  assert.ok(declared.length > 0, "sanity: cluster.toml must declare inputs");
  assert.ok(resolved.size > 0, "sanity: the lockfile must carry resolved rows");

  const pairs = declared
    .filter((i) => resolved.has(i.name))
    .flatMap((i) =>
      DERIVED_INPUT_FIELDS
        .filter((f) => i[f] !== undefined)          // EXPLICIT declarations only
        .map((f) => ({ input: i.name, field: f, declared: i[f], resolved: resolved.get(i.name)[f] })),
    );

  // Non-vacuity: if nobody declares a derived field explicitly, this property
  // is true of the empty set and proves nothing. Today `rosary` supplies the
  // one explicit `requiresSession = true`. If that disappears, this assertion
  // fails and says so rather than passing on air.
  assert.ok(
    pairs.length > 0,
    "no explicit declaration of any derived field — property would pass vacuously",
  );

  forAll(
    pairs,
    (p) => `${p.input}.${p.field}: operator declared ${p.declared}, substrate resolved ${p.resolved}`,
    (p) => p.resolved === undefined || p.declared === p.resolved,
  );
});

// ── every accepted recipe is an instantiable recipe ───────────────────────
//
// `lint:recipes` accepts README.md + (cloister.capnp OR cluster.toml).
// `cli-init.listRecipes` requires cloister.capnp AND cluster.compose.yaml AND
// cluster.toml. Two definitions of "a valid recipe", and the WEAKER one is the
// gate — so recipes/multi-tenant-smoke passed lint, shipped a README telling
// users to run `task init -- --recipe multi-tenant-smoke`, and the CLI answered
// `unknown recipe`. The docs, the lint, and the code each believed something
// different.
//
// The property is the reconciliation: whatever the lint accepts, the CLI must
// be able to instantiate. Stated over ALL recipes so the next one cannot
// diverge either.

test("PROPERTY: every recipe on disk is instantiable by the init CLI", async () => {
  const { listRecipes } = await import("../cli-init.mjs");
  const recipesRoot = resolve(ROOT, "recipes");
  const onDisk = readdirSync(recipesRoot).filter((n) =>
    existsSync(resolve(recipesRoot, n, "README.md")),
  );
  const instantiable = new Set(listRecipes(recipesRoot));

  assert.ok(onDisk.length > 2, `sanity: expected several recipes, found ${onDisk.length}`);

  forAll(
    onDisk,
    (n) => `recipes/${n} has a README but the init CLI cannot instantiate it`,
    (n) => instantiable.has(n),
  );
});
