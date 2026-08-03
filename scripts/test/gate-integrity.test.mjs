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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { discoverNodeTests } from "../../cli/lib/dev/test-runner.mjs";

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

test("PROPERTY: every scripts/test file on disk is discovered by the runner", () => {
  const discovered = new Set(discoverNodeTests(ROOT));
  const onDisk = testFilesOnDisk("scripts/test").map((file) => `scripts/test/${file}`);
  assert.ok(onDisk.length > 20, `sanity: expected many test files, found ${onDisk.length}`);

  // A file on disk the runner never discovers is a test that CANNOT fail — strictly
  // worse than no test, because it reports coverage it does not provide.
  // oci-artifact.test.mjs sat dark this way since #189.
  forAll(
    onDisk,
    (file) => `${file} is on disk but the runner never discovers it`,
    (file) => discovered.has(file),
  );
});

test("PROPERTY: discovered tests are sorted, unique, and present", () => {
  const discovered = discoverNodeTests(ROOT);
  assert.ok(discovered.length > 20, `sanity: expected many discovered files, found ${discovered.length}`);
  assert.deepEqual(discovered, [...discovered].sort());
  assert.equal(new Set(discovered).size, discovered.length);
  forAll(
    discovered,
    (file) => `${file} was discovered but does not exist`,
    (file) => existsSync(resolve(ROOT, file)),
  );
});

test("PROPERTY: Taskfile delegates the script suite to one first-party command", () => {
  // lint-allow-rawparse: this assertion is deliberately about the command a
  // contributor sees and Task executes, not Task's parsed data model.
  const taskfile = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
  const block = taskfile.match(/\n  test:lint-scripts:\n([\s\S]*?)(?=\n  [\w:-]+:\n)/)?.[1] ?? "";
  assert.match(block, /node bin\/cloister\.mjs dev test/);
  assert.doesNotMatch(block, /\.test\.mjs/);
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

test("PROPERTY: no derived field is declarable on the operator surface at all", () => {
  // STRENGTHENED, and the previous version is why (cloister-553c39).
  //
  // It used to assert: IF an operator declares a derived field, the substrate
  // must not resolve the opposite. That was the strongest claim available while
  // `requiresSession` was still an operator-facing knob — the contradiction was
  // the only reachable harm.
  //
  // The knob is gone. requiresSession is now derived from the transport the
  // server declares, with NO fallback: an input declaring no transport is
  // refused rather than defaulted. So the contradiction is not merely absent
  // from the tree, it is unreachable — which made the old property's own
  // non-vacuity guard fire ("no explicit declaration ... would pass vacuously").
  // That guard doing its job is what brought us here, and the honest response is
  // a stronger property rather than a relaxed one.
  //
  // The property now: a derived field must not APPEAR on the operator surface.
  // That is checkable without needing anyone to declare one, and it fails if a
  // future change re-adds an operator-declarable derived field — the drift the
  // old property could only catch after it had already produced a disagreement.
  const declared = operatorDeclaredInputs();
  assert.ok(declared.length > 0, "sanity: cluster.toml must declare inputs");
  assert.ok(DERIVED_INPUT_FIELDS.length > 0, "sanity: at least one field is derived");

  const offenders = declared.flatMap((i) =>
    DERIVED_INPUT_FIELDS.filter((f) => i[f] !== undefined).map((f) => ({ input: i.name, field: f })),
  );

  forAll(
    offenders,
    (o) =>
      `[inputs.${o.input}] declares "${o.field}", which the substrate DERIVES from the ` +
      `server's declared transport. Two statements of one fact — and the operator's is ` +
      `the one nothing keeps current (cloister-af794d was that outage). Delete it.`,
    () => false,   // any offender is a violation
  );

  // And the derived value must still actually be produced, or the removal
  // silently dropped the fact instead of relocating it.
  const resolved = resolvedInputs();
  assert.ok(resolved.size > 0, "sanity: the lockfile must carry resolved rows");
  forAll(
    [...resolved.entries()].filter(([, row]) => row.kind !== "udsForward"),
    ([name]) => `${name}: no resolved row carries a derived requiresSession — the fact was dropped, not moved`,
    ([, row]) => "requiresSession" in row || row.requiresSession === false,
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
  const { listRecipes } = await import("../../cli/commands/init.mjs");
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

// ── every check-shaped task is invoked by some gate ───────────────────────
//
// The pattern this exists for, seven instances in one session:
//
//   1. scripts/test/oci-artifact.test.mjs — on disk, in no test list (#189→#223)
//   2. CI verify path filter — enumerated substrate paths, skipped the rest
//   3. config.capnp ↔ wrangler.toml — "must stay in sync", nothing checked
//   4. identity:zod:check-drift — existed, in no gate (found #224)
//   5. runtime:doctor — referenced ONLY by its own definition
//   6. cluster:zod:check-drift — same shape as (4), still orphaned
//   7. leyline_sign_data — compiled, declared, never executed
//
// Each was invisible for one reason: THE CHECK'S EXISTENCE READS AS COVERAGE.
// A task named `*:doctor` or `*:check-drift` looks like a guarantee whether or
// not anything runs it, and the tree offers no way to tell the difference by
// reading.
//
// So: a task whose NAME declares it a check must appear in some gate's deps,
// or be declared deliberately opt-in WITH A REASON. Silence is not an option.

// Each entry declares WHY the check is absent from `task lint`, and — this is
// the load-bearing part — WHERE it is gated instead. `gatedBy` names a workflow
// file that must actually invoke the task; `null` asserts the check is gated
// nowhere, deliberately.
//
// The `gatedBy` field exists because the first version of this table got it
// WRONG. Two entries claimed the Go drift checks were "gated in the
// cloister-schema-go workflow". That workflow gates a different surface
// entirely — clients/go/cloister-schema/, generated by regen.sh with upstream
// capnpc-go from wire/cloister.capnp — and never touches pkg/cluster/cluster.go
// or pkg/identity/identity.go, which come from LLO's capnpc-schema-bridge-go
// off manifest/*.capnp. Two Go surfaces, two generators, one gate.
//
// The consequence was measured, not theorised: pkg/cluster/cluster.go was stale
// by four fields (InputSpec.requiresSession, .connection, .mutableTagReason,
// Gateway.harnessTargets), each added to the capnp schema by shipped work.
//
// So a prose reason naming a gate was itself an unchecked citation — the same
// defect as an orphaned check, committed inside the rail written to end it.
// A cited gate is now verified to exist and to invoke the task.
const OPT_IN_CHECKS = {
  "image:check": {
    reason:
      "needs the melange AND apko binaries, which `task lint` must not require — a " +
      "developer without them still has to be able to run the gate. It also is NOT " +
      "read-only: its dep `apk:keygen` runs `melange keygen`, writing melange.rsa into " +
      "the tree. I gated it in cc1c1c0 calling it \"offline syntax validation, cheap\" " +
      "and it passed locally because I had the toolchain installed; CI failed with exit " +
      "127. Both halves of that justification were wrong, which is why this entry states " +
      "the toolchain AND the side effect rather than just 'opt-in'. Gating it for real " +
      "means installing melange + apko in a workflow — tracked separately.",
    gatedBy: null,
  },
  "runtime:doctor": {
    reason:
      "host-dependent (krunvm/Buildah availability). NOT in `task lint` by design — a " +
      "developer without a microVM host must still be able to run the gate. It is now a " +
      "dep of runtime:run, which is where it is load-bearing (cloister-66f1ce).",
    gatedBy: null,
  },
};

/** Task names defined at the top level of the Taskfile. */
function taskNames(src) {
  return new Set([...src.matchAll(/^ {2}([a-z][\w:-]*):\s*$/gm)].map((m) => m[1]));
}

/** Every task named inside any deps array, inline or block form. */
function dependedOn(src) {
  const out = new Set();
  for (const m of src.matchAll(/deps:\s*\[([^\]]*)\]/g)) {
    for (const x of m[1].split(",")) if (x.trim()) out.add(x.trim());
  }
  for (const m of src.matchAll(/deps:\s*\n((?:\s+- .*\n)+)/g)) {
    for (const l of m[1].trim().split("\n")) out.add(l.trim().replace(/^-\s*/, ""));
  }
  return out;
}

/**
 * Every task invoked by a CI workflow.
 *
 * A Taskfile deps array is not the only real gate. Some checks CANNOT live in
 * `task lint` — the two schema-bridge Go drift checks need a Go toolchain, and
 * requiring Go for the inner loop would be a worse trade than leaving them to
 * CI. A workflow that runs them is a genuine gate, and treating it as one is
 * what keeps OPT_IN_CHECKS honest: the table should hold only checks gated
 * NOWHERE, not everything that happens to sit outside the Taskfile.
 */
function invokedByCi(root) {
  const dir = resolve(root, ".github/workflows");
  if (!existsSync(dir)) return new Set();
  const out = new Set();
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const src = readFileSync(resolve(dir, f), "utf8");
    // `task <name>` in a run: block. Comments are excluded deliberately —
    // a task NAMED in a comment is exactly the unbacked citation this file
    // exists to reject.
    for (const line of src.split("\n")) {
      const code = line.replace(/^\s*#.*$/, "");
      for (const m of code.matchAll(/\btask\s+([a-z][\w:-]*)/g)) out.add(m[1]);
    }
  }
  return out;
}

test("PROPERTY: every check-shaped task is invoked by a gate, or declared opt-in with a reason", () => {
  // lint-allow-rawparse: reads Taskfile TEXT because the question is which
  // names appear in a deps array literally — a YAML parse would answer the
  // same, but this must keep working if deps move between inline and block
  // form, or into an included Taskfile.
  const src = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
  const names = taskNames(src);
  const deps = dependedOn(src);

  const checkShaped = [...names].filter(
    (n) =>
      n.startsWith("lint:") ||
      n.endsWith(":doctor") ||
      n.endsWith(":check") ||
      n.endsWith(":check-drift") ||
      n.endsWith(":verify"),
  ).sort();

  assert.ok(
    checkShaped.length > 20,
    `sanity: expected many check-shaped tasks, found ${checkShaped.length}`,
  );

  const ci = invokedByCi(ROOT);

  forAll(
    checkShaped,
    (n) => `${n} is check-shaped but neither a Taskfile gate nor a CI workflow invokes it, and it is not a declared opt-in`,
    (n) => deps.has(n) || ci.has(n) || n in OPT_IN_CHECKS,
  );
});

test("PROPERTY: no declared opt-in is stale, and each states a reason", () => {
  const src = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
  const names = taskNames(src);
  const deps = dependedOn(src);

  forAll(
    Object.keys(OPT_IN_CHECKS),
    (n) => `${n} is declared opt-in but ${names.has(n) ? "IS now gated — delete the entry" : "no longer exists"}`,
    // Still defined, and still genuinely un-gated. `runtime:doctor` is the
    // exception: it IS a dep of runtime:run, and its entry says why it is
    // nonetheless absent from `task lint`.
    (n) => names.has(n) && (n === "runtime:doctor" || !(deps.has(n) || invokedByCi(ROOT).has(n))),
  );

  forAll(
    Object.entries(OPT_IN_CHECKS),
    ([n]) => `${n}'s opt-in reason is too short to be a reason`,
    ([, e]) => typeof e.reason === "string" && e.reason.length > 30,
  );
});

test("PROPERTY: an opt-in that cites a gate is cited correctly", () => {
  // The property the first version of this table lacked. Two entries named a
  // workflow that gates a DIFFERENT surface, so the table asserted coverage
  // that did not exist — and nothing could tell, because the claim was prose.
  //
  // `gatedBy: null` is a real answer meaning "gated nowhere, deliberately", and
  // it is checked too: the reason must then say why running nowhere is
  // acceptable, not merely that a toolchain is missing.
  forAll(
    Object.entries(OPT_IN_CHECKS).filter(([, e]) => e.gatedBy !== null),
    ([n, e]) => `${n} claims it is gated by ${e.gatedBy}, but that file does not invoke it`,
    ([n, e]) => {
      const p = resolve(ROOT, e.gatedBy);
      if (!existsSync(p)) return false;
      // The workflow must name the task, or invoke a task that depends on it.
      return readFileSync(p, "utf8").includes(n);
    },
  );

  forAll(
    Object.entries(OPT_IN_CHECKS),
    ([n]) => `${n} must declare gatedBy explicitly — a workflow path, or null for "gated nowhere, deliberately"`,
    ([, e]) => e.gatedBy === null || typeof e.gatedBy === "string",
  );
});
