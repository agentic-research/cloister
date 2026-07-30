// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Skills are DECLARED and DIGEST-VERIFIED before a run mints anything (ADR-0061).
//
// Confinement already bounds how much damage a skill can do — proven three
// levels deep, across a language boundary, in
// tools/harness-sandbox/test/cloister-harness-binary.test.mjs. These assert the
// different question: WHICH skills ran.
//
// The property NOT claimed, and asserted as such below: this is verification at
// LOAD, not continuous. The skills directory stays writable because nono's
// grants are a union rather than an intersection — a narrower read grant does
// not constrain a broader rw parent, measured. A skill substituted mid-run is
// caught on the NEXT run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestSkillDir, verifySkills, PreconditionError } from "../lib/harness/launch.mjs";

function skillTree(t) {
  const base = mkdtempSync(join(tmpdir(), "skills-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "skills");
  mkdirSync(join(dir, "beads", "nested"), { recursive: true });
  writeFileSync(join(dir, "beads", "SKILL.md"), "# beads\n");
  writeFileSync(join(dir, "beads", "nested", "helper.sh"), "echo hi\n");
  return { base, dir };
}

const planFor = (stateDir, skills) => ({
  sandbox: { stateDir },
  cluster: {},
  skills,
});

// verifySkills reads plan.skills; keep the shape in one place.
const run = (stateDir, skills, log = () => {}, extra = {}) =>
  verifySkills(
    { sandbox: { stateDir }, skills, root: stateDir },
    log,
    // Capture the receipt instead of writing it, so tests assert its CONTENT
    // rather than only the one-line summary.
    { writeFileSync: (p, d) => { extra.receipt = JSON.parse(d); extra.receiptPath = p; }, ...extra.deps },
  );

test("digestSkillDir folds the PATH in, so a rename changes the digest", (t) => {
  // Hashing contents alone would let `evil.sh` be renamed to `setup.sh`
  // invisibly — same bytes, different meaning to whatever loads by name.
  const { base, dir } = skillTree(t);
  const before = digestSkillDir(join(dir, "beads"));
  renameSync(join(dir, "beads", "nested", "helper.sh"), join(dir, "beads", "nested", "setup.sh"));
  const after = digestSkillDir(join(dir, "beads"));
  assert.notEqual(before, after, "a rename with identical bytes must change the digest");
  assert.match(before, /^sha256:[0-9a-f]{64}$/);
  void base;
});

test("digestSkillDir is stable across repeated walks", (t) => {
  const { dir } = skillTree(t);
  assert.equal(digestSkillDir(join(dir, "beads")), digestSkillDir(join(dir, "beads")));
});

test("a matching pin verifies and is reported", (t) => {
  const { dir } = skillTree(t);
  const digest = digestSkillDir(join(dir, "beads"));
  let out = "";
  const verified = run(join(dir, ".."), [{ name: "beads", digest }], (m) => { out += `${m}\n`; });
  assert.deepEqual(verified, [{ name: "beads", digest, pinned: true }]);
  assert.match(out, /skills: 1 declared \(1 pinned\)/, "stdout stays a one-liner");
});

test("a TAMPERED skill refuses the run — the falsifier", (t) => {
  // Without this, every assertion above is satisfied by a verifier that returns
  // success unconditionally.
  const { dir } = skillTree(t);
  const digest = digestSkillDir(join(dir, "beads"));
  writeFileSync(join(dir, "beads", "SKILL.md"), "# beads\nrm -rf /\n");
  assert.throws(
    () => run(join(dir, ".."), [{ name: "beads", digest }]),
    (err) => err instanceof PreconditionError && /does not match its pin/.test(err.message),
    "content changed under a pin must refuse the run",
  );
});

test("an UNPINNED declaration is admitted but says so, with the digest to paste", (t) => {
  // A warning with no remedy is noise. This one carries the exact line to copy.
  const { dir } = skillTree(t);
  let out = "";
  const verified = run(join(dir, ".."), [{ name: "beads", digest: "" }], (m) => { out += `${m}\n`; });
  assert.equal(verified[0].pinned, false);
  assert.match(out, /UNPINNED/);
  assert.match(out, /digest = "sha256:[0-9a-f]{64}"/, "must give the operator the line to paste");
});

test("a DECLARED but absent skill refuses — the run would not be the declared one", (t) => {
  const { dir } = skillTree(t);
  assert.throws(
    () => run(join(dir, ".."), [{ name: "ghost", digest: "" }]),
    (err) => err instanceof PreconditionError && /declared in cluster\.toml but absent/.test(err.message),
  );
});

test("an UNDECLARED skill is reported, not silently honoured", (t) => {
  const { dir } = skillTree(t);
  mkdirSync(join(dir, "sneaky"));
  writeFileSync(join(dir, "sneaky", "SKILL.md"), "# not declared\n");
  let out = "";
  run(join(dir, ".."), [{ name: "beads", digest: "" }], (m) => { out += `${m}\n`; });
  assert.match(out, /1 UNDECLARED/, "the COUNT is the signal on stdout");
  assert.doesNotMatch(out, /sneaky/, "names belong in the receipt, not in every run's scrollback");
});

test("declaring nothing with no skills dir is silent, not an error", (t) => {
  const base = mkdtempSync(join(tmpdir(), "skills-empty-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  let out = "";
  assert.deepEqual(run(base, [], (m) => { out += m; }), []);
  assert.equal(out, "", "no skills declared and none present is a valid posture");
});

// ── the receipt (ADR-0043's load-event receipt, finally delivered) ─────────

test("the receipt carries the FULL picture that stdout deliberately omits", (t) => {
  const { dir } = skillTree(t);
  mkdirSync(join(dir, "sneaky"));
  writeFileSync(join(dir, "sneaky", "SKILL.md"), "# not declared\n");
  const captured = {};
  let out = "";
  run(join(dir, ".."), [{ name: "beads", digest: "" }], (m) => { out += `${m}\n`; }, captured);

  assert.ok(captured.receipt, "a receipt must be written");
  assert.equal(captured.receipt.version, "cloister/skill-load/v1");
  assert.deepEqual(captured.receipt.undeclared, ["sneaky"], "names live here");
  assert.equal(captured.receipt.verified[0].name, "beads");
  assert.match(captured.receipt.verified[0].digest, /^sha256:/);
  // stdout must POINT at it, or the detail is unreachable in practice.
  assert.match(out, /\.harness-skills\.json/, "the one-liner must name the receipt");
});

test("the receipt states its own limitation, because it outlives the explanation", (t) => {
  // "Verified" on an artifact reads as stronger than it is. The artifact says
  // what it means, so a reader six months out does not infer continuous
  // enforcement from a word.
  const { dir } = skillTree(t);
  const captured = {};
  run(join(dir, ".."), [{ name: "beads", digest: "" }], () => {}, captured);
  assert.equal(captured.receipt.verifiedAt, "load");
  assert.match(captured.receipt.note, /not continuous/);
  assert.match(captured.receipt.note, /NEXT run/);
});

test("a receipt that cannot be written does not fail an otherwise-fine run", (t) => {
  const { dir } = skillTree(t);
  const boom = { deps: { writeFileSync: () => { throw new Error("EROFS"); } } };
  let out = "";
  const verified = verifySkills(
    { sandbox: { stateDir: join(dir, "..") }, skills: [{ name: "beads", digest: "" }], root: "/nope" },
    (m) => { out += m; },
    boom.deps,
  );
  assert.equal(verified.length, 1, "verification still happened");
  void out;
});
