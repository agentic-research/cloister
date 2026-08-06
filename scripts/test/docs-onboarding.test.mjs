import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("the README leads a new user through the installed CLI", () => {
  const readme = read("README.md");

  // ANCHORED ON A GUARD, not on prose. The previous version sliced to
  // `indexOf("## Why you'd care")`; when that heading was removed in the
  // orientation rewrite, indexOf returned -1 and `slice(0, -1)` silently
  // widened to the whole file. Same fail-open shape the runtime test below
  // documents having been bitten by — twice now, in one file.
  //
  // So the anchor is the first `##` after the intro, found positionally, and
  // its absence is an explicit failure rather than a silent widening.
  const firstSection = readme.indexOf("\n## ");
  assert.notEqual(firstSection, -1, "README has no sections — anchor is stale");
  const opening = readme.slice(0, firstSection);
  assert.ok(opening.length > 0, "opening slice is empty — anchors crossed");

  // What a new user must meet before anything else: the product command, not
  // the repo plumbing.
  assert.match(readme, /task install/);
  assert.match(readme, /cloister dev bootstrap/);
  assert.match(readme, /cloister run --harness/);
  assert.doesNotMatch(readme, /task dev:bootstrap|task cluster:toml/);

  // `skills pin` and `cluster generate` deliberately are NOT asserted here any
  // more. They are second-step operations and the README is now an orientation
  // page (cloister-0cc05e); they belong to the docs that own them. Asserting
  // them at the front door is what kept four quickstarts alive.
});

test("operator docs name the product command and label the compatibility runtime", () => {
  const running = read("docs/RUNNING.md");
  const readme = read("README.md");
  // Anchored on the FIRST runtime heading, which is now the LLO path — the
  // section was reordered so the page stops leading with the shell-out
  // (cloister-17e502). Both headings live between this anchor and the next `##`,
  // so the slice still covers the whole runtime surface.
  //
  // The old anchor was the literal "### Experimental: run an external tool".
  // When that heading was renamed, indexOf returned -1 and slice(-1, n) produced
  // an EMPTY string — so every assertion below passed vacuously except the one
  // that happened to be a positive match. A heading-text anchor fails open,
  // which is worth knowing about the shape rather than just fixing.
  // Re-anchored after the orientation rewrite (cloister-0cc05e). The README no
  // longer carries a runtime walkthrough — that moved to RUNNING.md — so the
  // section this once sliced does not exist. What the README must still say is
  // that it does not execute, and the guard stays explicit.
  const runtimeStart = readme.indexOf("## How it fits together");
  assert.notEqual(runtimeStart, -1, "runtime section heading not found — anchor is stale");
  const runtimeSection = readme.slice(runtimeStart, readme.indexOf("## What it is not"));
  assert.ok(runtimeSection.length > 0, "runtime slice is empty — anchors crossed");
  assert.match(runtimeSection, /ley-line-open/, "the README must name who owns execution");

  // `compatibility provider` is gone rather than renamed: the krunvm shell-out
  // it described was deleted in 681a58f. A rail asserting a deleted subject is
  // how docs get resurrected to satisfy a test.

  assert.match(running, /node bin\/cloister\.mjs/);
  assert.doesNotMatch(running, /node scripts\/cloister-cli\.mjs/);
  assert.doesNotMatch(runtimeSection, /task runtime:/);
});

test("Work Board and recorder guidance do not overstate the boundary", () => {
  const running = read("docs/RUNNING.md");

  assert.match(running, /`pr-board` is the agent skill/);
  assert.match(running, /Work Board is a local visual app/);
  assert.match(
    running,
    /does not yet record every attempted file,\s+environment-variable, process, or network access/,
  );
});

test("scripts are described as repository plumbing, not the operator interface", () => {
  const scripts = read("scripts/README.md");

  assert.match(scripts, /not the installed product interface/i);
  assert.doesNotMatch(scripts, /Taskfile is the entry point/);
});
