// SPDX-License-Identifier: AGPL-3.0-or-later
//
// artifact-registry — every artifact cloister EMITS that another system
// consumes. ADR-0067 L0.
//
// ## Why a list is the load-bearing part
//
// This is the smallest layer in ADR-0067 and the one the rest depends on.
// Nothing previously enumerated these artifacts, and that absence is exactly
// how two conformance refusals in a single document hid behind one another:
// `credentialSource: "vault://"` (§5, cloister-d2ba07) and bare relative
// `fs.allow` paths (§2, cloister-bd6399). Fixing the first let a parse advance
// far enough to reach the second. Both had been shipping for a year.
//
// There was no list on which the confinement document appeared, so there was no
// place for its coverage to be visibly missing. A registry does not check
// anything by itself; it makes the gap nameable.
//
// ## What an entry means
//
// - `produce()`   — emit the artifact exactly as production does. NOT a fixture
//                   hand-written to look like it. The whole failure mode being
//                   closed is a check that agrees with a document cloister never
//                   actually produced, which is what
//                   `rs/crates/cas/tests/confinement_digest.rs` does: it proves
//                   our canonicalizer matches LLO's on LLO's vector, and both
//                   refusals sailed past it.
// - `schema`      — a VENDORED schema path. Vendored is not convenience: CI has
//                   no sibling checkout, so a check that needs one runs only on
//                   machines where everything already works.
// - `golden`      — committed expected output. Changing the artifact becomes a
//                   reviewed diff instead of a silent digest change that
//                   surfaces later as a §8 commitment mismatch, far from cause.
// - `consumers`   — who parses it. Documentation today; L2's dispatch table when
//                   counterparty conformance lands.

import { confinementManifest } from "../cli/lib/harness/launch.mjs";

/**
 * @typedef {object} Artifact
 * @property {string}   id          stable name, used in golden filenames
 * @property {string}   description one line, for the coverage report
 * @property {() => unknown} produce emit it the way production does
 * @property {string}   schema      repo-relative path to the VENDORED schema
 * @property {string}   golden      repo-relative path to the committed golden
 * @property {string[]} consumers   systems that parse this artifact
 */

/** @type {Artifact[]} */
export const ARTIFACTS = [
  // One-root and multi-root are separate entries rather than one parameterised
  // case, because the ROOT COUNT is the only thing that legitimately changes the
  // digest (scripts/test/confinement-shape.test.mjs pins that). Two goldens make
  // a change to either shape visible on its own line.
  {
    id: "confinement-harness-1root",
    description: "confinement/v1 document a single-repo harness identity commits to",
    produce: () => confinementManifest(1),
    schema: "test/fixtures/llo-confinement-v1/confinement.schema.json",
    golden: "test/fixtures/golden/confinement-harness-1root.json",
    consumers: ["ley-line-open (ConfinementManifest::parse)", "tools/harness-sandbox"],
  },
  {
    id: "confinement-harness-3root",
    description: "the same document for a three-root run — the width the digest encodes",
    produce: () => confinementManifest(3),
    schema: "test/fixtures/llo-confinement-v1/confinement.schema.json",
    golden: "test/fixtures/golden/confinement-harness-3root.json",
    consumers: ["ley-line-open (ConfinementManifest::parse)", "tools/harness-sandbox"],
  },
];

/**
 * Canonical bytes for a golden file.
 *
 * Two-space JSON with a trailing newline — a readable diff, which is the point
 * of a golden. This is NOT the confinement/v1 §7 canonical form (that has no
 * trailing newline and is what the digest is taken over); `src/wire/
 * confinement-digest.ts` owns that, and conflating the two would make this file
 * a second opinion on canonicalization.
 */
export function goldenBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
