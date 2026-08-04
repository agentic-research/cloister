import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("the README leads a new user through the installed CLI", () => {
  const readme = read("README.md");
  const opening = readme.slice(0, readme.indexOf("## Why you'd care"));

  assert.match(opening, /task install/);
  assert.match(opening, /cloister dev bootstrap/);
  assert.match(opening, /cloister skills pin repo-summary[^\n]*--write/);
  assert.match(opening, /cloister cluster generate/);
  assert.doesNotMatch(opening, /task dev:bootstrap|task cluster:toml/);
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
  const runtimeStart = readme.indexOf("### Running an external tool under isolation");
  assert.notEqual(runtimeStart, -1, "runtime section heading not found — anchor is stale");
  const runtimeSection = readme.slice(runtimeStart, readme.indexOf("## What cloister is NOT"));
  assert.ok(runtimeSection.length > 0, "runtime slice is empty — anchors crossed");

  assert.match(running, /node bin\/cloister\.mjs/);
  assert.doesNotMatch(running, /node scripts\/cloister-cli\.mjs/);
  assert.match(runtimeSection, /compatibility provider/i);
  assert.match(runtimeSection, /cloister runtime storage init/);
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
