#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:schema-claim — nobody hand-enumerates execution/v1 (cloister-3e86e8).
//
// PR #260 hand-wrote a ten-field RunSpec. The canonical struct has eleven fields
// and shares NONE of those ten names, so the mapping emitted an object the
// contract rejects outright — and `task lint` passed green throughout. This rail
// is the thing that was missing. Per ADR-0063.
//
// ── What it checks, and what it deliberately does not ────────────────────────
//
// It reads the CANONICAL FIELD NAMES out of the generated artifact
// (`src/generated/llo-execution-tools.json`, itself digest-pinned by
// `llo-execution-contract.lock.json`) and fails when a file enumerates them by
// hand. It is a check against real data, not a guess about source shape.
//
// The first cut checked something else — "does this file mention the string
// `execution/v1`" — and it was wrong twice within an hour. It failed on its own
// header (a markdown backtick in JSDoc read as a template literal), and then on
// `cli/commands/runtime.mjs`, whose offence was a HELP STRING: "Provision
// through the LLO execution/v1 provider". Naming a contract in prose is not
// speaking it. A rail that cannot tell a mention from a claim is a rail that
// trains people to work around it.
//
// So the invariant is narrower and truer: the failure was never *naming* the
// contract, it was RESTATING ITS FIELDS. That is what this looks for.
//
// ── The threshold ────────────────────────────────────────────────────────────
//
// Canonical field names include ordinary words — `arguments`, `outputs`,
// `capabilities`, `limits`, `workspaces`. One or two in a file is coincidence.
// MIN_FIELDS distinct canonical names appearing as object keys in one file is
// enumeration. The threshold is a judgement call, so it is pinned from both
// sides in the companion test: below it must pass, at it must fail.
//
// Exit 0 clean, 1 on violations.

import { readFileSync, globSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = resolve(ROOT, "src/generated/llo-execution-tools.json");

// Structs whose fields cloister must never restate. Read from the artifact, so
// a field added upstream is covered the moment the pin is bumped.
const GUARDED_STRUCTS = ["RunSpec", "RunGrant", "RunReceipt"];
const MIN_FIELDS = 3;

// The one module allowed to know these names: it derives them FROM the artifact.
const CONTRACT_MODULE = "cli/lib/runtime/llo-execution-contract.mjs";

if (!existsSync(ARTIFACT)) {
  console.error(`lint-schema-claim: FAIL — generated artifact missing: ${ARTIFACT}`);
  console.error("  Cloister cannot police a contract it has not generated. Restore the");
  console.error("  artifact and its lock, or remove the code that speaks execution/v1.");
  process.exit(1);
}

const tools = JSON.parse(readFileSync(ARTIFACT, "utf8"));
const defs = tools.find((t) => t?.name === "llo_execution_start")?.inputSchema?.$defs ?? {};

const canonical = new Set();
for (const struct of GUARDED_STRUCTS) {
  for (const field of Object.keys(defs[struct]?.properties ?? {})) canonical.add(field);
}
if (canonical.size === 0) {
  console.error("lint-schema-claim: FAIL — no canonical fields found in the artifact.");
  console.error("  The rail would pass vacuously. Check the generated tool schema shape.");
  process.exit(1);
}

// `key:` or `"key":` at an object-literal position. Not a parser — it does not
// distinguish a key from a same-named label, which would be a false POSITIVE a
// human reads and corrects, never a silent miss.
function enumeratedFields(code) {
  const found = new Set();
  for (const field of canonical) {
    if (new RegExp(`["'\`]?\\b${field}\\b["'\`]?\\s*:`).test(code)) found.add(field);
  }
  return found;
}

const files = globSync("{cli,src,scripts}/**/*.{mjs,ts}", { cwd: ROOT })
  .filter((f) => !f.includes("/generated/") && f !== CONTRACT_MODULE);

// A TEST that pins the wire shape must state the wire shape — that is
// verification, not invention, and forbidding it would forbid the only kind of
// test that can catch a drifted payload. But #260's bad test enumerated a wrong
// shape too, and passed. The difference is whether the GENERATED contract is in
// the loop: a fixture checked through `llo-execution-contract.mjs` is validated
// against the artifact, a fixture asserted against a hand-written builder is
// only self-consistent. So a test may enumerate iff it imports that module.
const CONTRACT_IMPORT = /from\s+["'][^"']*llo-execution-contract\.mjs["']/;
const isTest = (rel) => rel.includes("/test/") || rel.endsWith(".test.mjs");

/**
 * Does this file participate in execution/v1 at all?
 *
 * The rail's claim is "cloister must not restate a contract it does not own".
 * A file that never mentions that contract cannot be restating it — it is using
 * colliding names for its own purposes, and flagging it asserts something false.
 *
 * This is not hypothetical tightening. LLO v0.15.1 added
 * `RunGrant.confinementManifest @15`, and `confinementManifest` was ALREADY
 * cloister's own vocabulary: cli/lib/harness/launch.mjs:103 exports a builder
 * for `cloister/confinement/v1` §1 manifests, a spec cloister owns — the name
 * is in the spec's own title. LLO adopting the name is correct and good; the
 * consequence was that a canonical-field match retroactively made every prior
 * use of cloister's own term a "restatement", in a file that builds nono
 * capability sets and never constructs a RunSpec, RunGrant or RunReceipt.
 *
 * Renaming cloister's function would let an upstream field name dictate
 * cloister's internal vocabulary for a concept cloister defined first. So the
 * discriminator moves instead.
 *
 * It does NOT weaken the #260 case. That defect was a hand-written ten-field
 * RunSpec inside the execution adapter — a file whose entire subject is this
 * contract, and which matches on several of these markers. A file can not build
 * an execution/v1 payload while mentioning execution/v1 nowhere.
 */
const EXECUTION_MARKER =
  /\bexecution\/v1\b|\bllo_execution\w*|\bRun(?:Spec|Grant|Receipt)\b|llo-execution-/;

/**
 * Is this canonical field name DISTINCTIVE to the contract, or an ordinary word
 * that anything might use as a key?
 *
 * The guarded structs contain both. Distinctive: `workspaceInputs`,
 * `confinementDigest`, `runSpecDigest`, `schemaVersion`, `backendClass`.
 * Ordinary: `executable`, `capabilities`, `arguments`, `outputs`, `limits`,
 * `signature`, `usage`, `backend`, `workspaces`.
 *
 * That second list is the problem. Any harness, sandbox or runtime file in
 * cloister will naturally use three of those as object keys, so MIN_FIELDS
 * alone produces a false positive that GROWS every time LLO adds a
 * generically-named field. It is the same coincidence-vs-enumeration question
 * MIN_FIELDS already answers, one level down: three ordinary words together is
 * still coincidence; two compound domain names together is not.
 *
 * Compound camelCase is the proxy, because it is a property of the NAME rather
 * than a list someone must maintain — a hand-kept set of "generic" words would
 * rot the first time upstream added one nobody thought of.
 */
const isDistinctive = (field) => /[a-z][A-Z]/.test(field);

const violations = [];
for (const rel of files) {
  const text = readFileSync(resolve(ROOT, rel), "utf8");
  const found = enumeratedFields(text);
  if (found.size < MIN_FIELDS) continue;
  // A file may be accused of restating the contract only if it NAMES the
  // contract, or enumerates at least two distinctive field names. Without this,
  // `executable` + `capabilities` + any third ordinary word flags every harness
  // file in the tree — which is exactly what LLO v0.15.1 caused by adding
  // `RunGrant.confinementManifest`, a name cloister already owned via its own
  // `cloister/confinement/v1` spec. Checked BEFORE the test exemption so the
  // recorded reason for skipping is the accurate one.
  const distinctive = [...found].filter(isDistinctive);
  if (!EXECUTION_MARKER.test(text) && distinctive.length < 2) continue;
  if (isTest(rel) && CONTRACT_IMPORT.test(text)) continue;
  const why = isTest(rel)
    ? "enumerates the wire shape without importing the generated contract"
    : `enumerates ${found.size} canonical fields`;
  violations.push(`${rel}: ${why} (${[...found].sort().slice(0, 5).join(", ")}…)`);
}

if (violations.length > 0) {
  console.error("lint-schema-claim: FAIL — execution/v1 fields are restated by hand:");
  for (const v of violations) console.error(`  ✘ ${v}`);
  console.error(`\n  These names are owned by ley-line-open and reach cloister through`);
  console.error(`  ${CONTRACT_MODULE},`);
  console.error("  which derives them from the generated artifact. Build payloads there.");
  console.error("  A hand-written field list is how PR #260 shipped a ten-field RunSpec");
  console.error("  against an eleven-field contract, green. Per ADR-0063.");
  process.exit(1);
}

console.log(
  `lint-schema-claim: clean ✓ (${files.length} file(s), ${canonical.size} canonical ` +
    `field(s) from ${GUARDED_STRUCTS.length} struct(s), 0 hand enumerations)`,
);
