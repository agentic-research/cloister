// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-implementation conformance for `cloister/execution/v1` (cloister-17e502).
//
// Cloister pins TWO independently-published LLO artifacts and they must agree:
//
//   1. `src/generated/llo-execution-tools.json` — schema-bridge's ToolDefs
//      projection of `execution.capnp`, content-pinned by
//      `llo-execution-contract.lock.json`. This is what cloister VALIDATES
//      against at runtime.
//   2. `test/fixtures/llo-execution-v1/canonical-run.json` — LLO's own canonical
//      carrier vector, byte-pinned by its `VECTORS.sha256`. This is what LLO
//      says a real run LOOKS LIKE.
//
// Nothing previously checked that the schema cloister enforces accepts the
// document LLO calls canonical. That gap is the one PR #260 fell through: it
// hand-wrote a ten-field RunSpec sharing zero names with the eleven-field
// canonical struct, and `task lint` stayed green because no test ever put
// cloister's notion of the contract next to LLO's. Per ADR-0063.
//
// This is the cheapest cross-impl gate available, and it needs no LLO checkout
// — the vector is vendored under its upstream digest, the same way
// `rs/crates/cloister-cas/tests/confinement_digest.rs` vendors confinement/v1's.
// When LLO republishes either artifact, bumping one pin without the other fails
// here instead of in production.
//
// NOTE ON HOW THIS IS WRITTEN: no canonical field name is spelled out below.
// Every name is read from one artifact and checked against the other. That is
// `lint:schema-claim`'s rule (cloister must not restate a contract it does not
// own) and it is also what makes the test survive a schema bump — an LLO field
// added at a new ordinal is covered the moment the pins move, with no edit here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  lloExecutionRequest,
  lloExecutionTools,
  validateLloExecutionRequest,
} from "../../cli/lib/runtime/llo-execution-contract.mjs";

const VECTOR_URL = new URL(
  "../../test/fixtures/llo-execution-v1/canonical-run.json",
  import.meta.url,
);

// From ley-line-open `rs/ll-core/schema-spec/execution/v1/VECTORS.sha256`, which
// LLO verifies with `cargo test -p leyline-schema-spec`. The vendored copy is
// byte-for-byte upstream's; this is what makes "vendored" safe rather than a
// second source of truth.
const LLO_VECTORS_SHA256 =
  "b27808e8762da2893d83c3fccf3d9de8fef229be315fc8a131d8344d13408343";

const vectorBytes = readFileSync(VECTOR_URL);
const vector = JSON.parse(vectorBytes.toString("utf8"));

/**
 * Tools carrying a `$defs` bag. There is more than one: schema-bridge makes
 * each tool portable standalone, so `provision` and `start` each ship a full
 * copy rather than sharing one. That matters here — see the agreement test.
 */
function toolsWithDefs() {
  const tools = lloExecutionTools().filter((tool) => tool.inputSchema?.$defs);
  if (tools.length === 0) throw new Error("generated LLO artifact carries no $defs bag");
  return tools;
}

function deref(ref, defs) {
  const target = defs[String(ref).replace("#/$defs/", "")];
  if (!target) throw new Error(`generated artifact has no struct for ${ref}`);
  return target;
}

/**
 * Which generated struct backs one of the vector's top-level documents, resolved
 * against THE SAME `$defs` root the validator uses for that operation.
 *
 * Asked of the schema, never guessed from the name. Two earlier drafts of this
 * helper were wrong in ways worth recording, because both produced a green
 * suite:
 *
 *  - Matching `$defs` keys by suffix resolved the grant to `WorkspaceGrant`
 *    (three structs end in "Grant"), so the enum assertion probed the wrong
 *    type entirely.
 *  - Reading "the first `$defs` bag in the artifact" returned `provision`'s
 *    copy while `validateLloExecutionRequest` resolved `start`'s. A mutation
 *    injected into the copy the test read was invisible to the validator, and
 *    vice versa — the test and the code under test were looking at different
 *    schemas.
 *
 * Binding through the operation that actually carries the document fixes both.
 */
function structForVectorKey(key) {
  for (const tool of lloExecutionTools()) {
    const ref = tool.inputSchema?.properties?.[key]?.$ref;
    if (ref) return deref(ref, tool.inputSchema.$defs);
  }
  // Outputs are not published as tool schemas; find the envelope declaring it.
  for (const tool of toolsWithDefs()) {
    for (const schema of Object.values(tool.inputSchema.$defs)) {
      const ref = schema?.properties?.[key]?.$ref;
      if (ref) return deref(ref, tool.inputSchema.$defs);
    }
  }
  throw new Error(`no generated struct binds the vector's "${key}" document`);
}

test("the vendored execution/v1 vector matches LLO's VECTORS.sha256 pin", () => {
  const digest = createHash("sha256").update(vectorBytes).digest("hex");
  assert.equal(
    digest,
    LLO_VECTORS_SHA256,
    "vendored canonical-run.json drifted from ley-line-open's published vector",
  );
});

test("LLO's canonical run validates through Cloister's own request validator", () => {
  // The production path, not a reimplementation of it: `start` is the operation
  // that carries both structs, and it runs the same `additionalProperties:false`
  // + `required` + enum checks every real UDS request gets. If cloister's pinned
  // schema and LLO's canonical document disagree anywhere, this throws.
  const request = lloExecutionRequest.start(vector.spec, vector.grant);
  assert.equal(request.op, "llo_execution_start");
  assert.deepEqual(request.spec, vector.spec);
  assert.deepEqual(request.grant, vector.grant);
});

test("every repeated $defs copy in the artifact agrees with the others", () => {
  // Because each tool is portable standalone, the artifact carries the same
  // struct definitions more than once, and Cloister resolves `$ref`s against
  // the CALLING operation's copy. Divergent copies would make the contract
  // depend on which operation you invoked — `provision` accepting a shape
  // `start` rejects. Nothing upstream forbids that, so pin it here.
  const [reference, ...others] = toolsWithDefs();
  assert.ok(others.length > 0, "expected more than one tool to carry a $defs bag");

  for (const tool of others) {
    for (const [name, schema] of Object.entries(tool.inputSchema.$defs)) {
      const baseline = reference.inputSchema.$defs[name];
      if (!baseline) continue;
      assert.deepEqual(
        schema,
        baseline,
        `${name} differs between ${reference.name} and ${tool.name}`,
      );
    }
  }
});

test("the canonical receipt agrees with the generated receipt schema", () => {
  // RunReceipt is an output, so no operation validates it on the way in. Check
  // the same two properties by hand — every declared requirement present, every
  // present key declared — derived from both artifacts, never enumerated.
  const receiptSchema = structForVectorKey("receipt");
  const declared = Object.keys(receiptSchema.properties ?? {});
  const present = Object.keys(vector.receipt);

  assert.deepEqual(
    (receiptSchema.required ?? []).filter((name) => !present.includes(name)),
    [],
    "canonical receipt omits a field the generated schema requires",
  );
  assert.deepEqual(
    present.filter((name) => !declared.includes(name)),
    [],
    "canonical receipt carries a field the generated schema does not declare",
  );
});

// ── The gate must be able to fail ───────────────────────────────────────────
// A conformance test that passes because it checks nothing is worse than none,
// because it reads as coverage. These two mutate the canonical document in the
// exact directions the contract forbids and assert cloister rejects them. They
// are what make the three tests above load-bearing.

test("dropping a required field from the canonical spec is rejected", () => {
  const specSchema = structForVectorKey("spec");
  const victim = (specSchema.required ?? [])[0];
  assert.ok(victim, "generated spec schema declares no required field to drop");

  const mutated = { ...vector.spec };
  delete mutated[victim];
  assert.throws(
    () => lloExecutionRequest.start(mutated, vector.grant),
    new RegExp(`${victim} is required`),
  );
});

test("an undeclared field on the canonical grant is rejected", () => {
  assert.throws(
    () => lloExecutionRequest.start(vector.spec, {
      ...vector.grant,
      cloisterInventedThis: true,
    }),
    /cloisterInventedThis is not declared/,
  );
});

test("an out-of-vocabulary enum value in the canonical grant is rejected", () => {
  // The enum vocabularies (BackendClass, RunState, WorkspaceOperation, …) are
  // as much of the contract as the field names, and are where a stale pin shows
  // up first: LLO adds a variant, cloister's copy has not moved, and the value
  // is silently unroutable. Locate the enum from the schema, then pick a value
  // that is definitionally not in it.
  const startDefs = lloExecutionTools()
    .find((tool) => tool.inputSchema?.properties?.grant?.$ref)
    .inputSchema.$defs;
  const grantSchema = structForVectorKey("grant");
  const [enumField] = Object.entries(grantSchema.properties ?? {})
    .filter(([, schema]) => typeof schema.$ref === "string"
      && Array.isArray(deref(schema.$ref, startDefs).enum))
    .map(([name]) => name);
  assert.ok(enumField, "canonical grant references no enum-typed field");

  assert.throws(
    () => lloExecutionRequest.start(vector.spec, {
      ...vector.grant,
      [enumField]: "definitely-not-a-declared-variant",
    }),
    /invalid enum value/,
  );
});

test("Cloister's validator is the same one the vector exercises", () => {
  // Guards against the test above quietly drifting onto a private copy of the
  // validation logic: the exported entry point must reject the same document.
  assert.throws(
    () => validateLloExecutionRequest({
      op: "llo_execution_start",
      spec: vector.spec,
      grant: { ...vector.grant, cloisterInventedThis: true },
    }),
    /not declared/,
  );
});
