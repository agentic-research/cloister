// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ADR-0067 L1 — every registered artifact validates against its VENDORED schema
// and matches its committed golden.
//
// Portable by construction: the schema is vendored, so this runs on a CI box
// with no sibling checkout. That is the requirement, not a convenience. The
// strongest confinement check cloister had before this was local-only, which
// meant it was absent from precisely the machine where a drifted artifact would
// otherwise go unnoticed.
//
// What this catches that source inspection did not: `cloister-d2ba07`
// (`credentialSource: "vault://"`, a §5 scheme the spec does not close over) and
// `cloister-bd6399` (bare relative `fs.allow` paths, refused by §2). Both shipped
// for a year. Both were in the SAME emitted document, and the second hid behind
// the first — fixing §5 let a parse advance far enough to reach §2. Validating
// the whole document reports both at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { ARTIFACTS, goldenBytes } from "../artifact-registry.mjs";
import { validate, UnsupportedSchemaError } from "../lib/json-schema-subset.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

test("the registry is not empty — an empty list passes every test below", () => {
  // The vacuity guard. Every assertion in this file iterates ARTIFACTS, so an
  // empty registry is green and means nothing. ADR-0067's whole premise is that
  // an unlisted artifact is an unchecked one.
  assert.ok(ARTIFACTS.length > 0, "no artifacts registered");
});

for (const artifact of ARTIFACTS) {
  test(`${artifact.id}: validates against the vendored schema`, () => {
    const schema = JSON.parse(read(artifact.schema));
    let errors;
    try {
      errors = validate(artifact.produce(), schema);
    } catch (err) {
      if (err instanceof UnsupportedSchemaError) {
        // Distinguished deliberately: this means the SCHEMA moved past the
        // validator, not that the document is wrong. Failing here is correct —
        // the alternative is skipping the keyword and reporting a pass for
        // something never checked.
        assert.fail(`vendored schema uses an unimplemented keyword — ${err.message}`);
      }
      throw err;
    }
    assert.deepEqual(errors, [], `${artifact.id} is not a valid ${artifact.schema}`);
  });

  test(`${artifact.id}: matches its committed golden`, () => {
    assert.ok(existsSync(resolve(ROOT, artifact.golden)),
      `golden missing — regenerate with \`task artifacts:golden\``);
    assert.equal(
      goldenBytes(artifact.produce()),
      read(artifact.golden),
      `${artifact.id} changed.\n\n` +
      `If deliberate, run \`task artifacts:golden\` and COMMIT the diff — that diff is\n` +
      `the review. For confinement documents it also changes the confinementDigest\n` +
      `committed into every minted cert, so previously-minted certs stop verifying;\n` +
      `say so in the commit message and the CHANGELOG.`,
    );
  });
}

test("the validator refuses a schema keyword it does not implement", () => {
  // Non-vacuity for the fail-closed property, which is the only thing making a
  // hand-written validator safe to trust. A validator that ignores what it does
  // not understand reports "valid" for a document it never checked.
  assert.throws(
    () => validate({ a: [] }, { type: "object", properties: { a: { type: "array", maxItems: 1 } } }),
    UnsupportedSchemaError,
  );
});

test("the validator rejects the documents that actually shipped broken", () => {
  // The regression pin, and the reason to trust the layer at all: the two real
  // defects must FAIL here. A validator that passes everything is the vacuous
  // outcome this harness exists to replace.
  const schema = JSON.parse(read(ARTIFACTS[0].schema));
  const current = ARTIFACTS[0].produce();

  const withVaultScheme = { ...current, credentialSource: "vault://claude-code" };
  assert.notDeepEqual(validate(withVaultScheme, schema), [],
    "cloister-d2ba07's vault:// scheme must be refused by §5");

  const withRelativePaths = {
    ...current,
    fs: { allow: [{ path: "workspace", mode: "rw" }, { path: "state", mode: "rw" }] },
  };
  assert.notDeepEqual(validate(withRelativePaths, schema), [],
    "cloister-bd6399's bare relative paths must be refused by §2");
});

test("the vendored schema matches its pinned digest", () => {
  // The vendored copy is the thing every check above trusts. Pinning it means a
  // silent edit to the local copy — which would weaken every artifact check at
  // once — fails here instead of passing everywhere.
  const pin = read("test/fixtures/llo-confinement-v1/VECTORS.sha256").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(
    resolve(ROOT, "test/fixtures/llo-confinement-v1/confinement.schema.json"))).digest("hex");
  assert.equal(actual, pin, "vendored schema does not match VECTORS.sha256");
});

test("the vendored schema is the PINNED version's, not a working tree's", { skip: !lloRepo() }, () => {
  // Resolved by `git show v<pinned>:<path>`, NOT by reading the sibling's
  // checkout. The first cut read the working tree, and the working tree was on
  // an in-progress branch — so the vendored copy came from nowhere in
  // particular, the test compared against that same nowhere, and the two agreed
  // with each other. A self-consistent loop with no anchor is worse than no
  // check: it reports clean by construction.
  //
  // Anchoring on the pinned version also makes the coupling correct — the
  // vendored schema and the pin move together, so a bump that forgets to
  // re-vendor fails here rather than validating tomorrow's documents against
  // yesterday's rules.
  const pinned = pinnedLloVersion();
  assert.ok(pinned, "could not read the pinned ley-line-open version");
  const fromTag = execFileSync(
    "git",
    ["show", `v${pinned}:rs/ll-core/schema-spec/confinement/v1/confinement.schema.json`],
    { cwd: lloRepo(), encoding: "utf8" },
  );
  assert.equal(
    fromTag,
    read("test/fixtures/llo-confinement-v1/confinement.schema.json"),
    `vendored confinement schema is not v${pinned}'s — re-vendor from the tag and re-pin`,
  );
});

function lloRepo() {
  const p = process.env.CLOISTER_LLO_ROOT ?? resolve(ROOT, "../ley-line-open");
  return existsSync(resolve(p, ".git")) ? p : null;
}

function pinnedLloVersion() {
  const toml = read("cluster.toml");
  return /\[inputs\.llo\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? null;
}
