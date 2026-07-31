import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySkill,
  renderSkillsList,
  sortSkillsForDisplay,
} from "../../cli/commands/skills.mjs";

function skill(name, state) {
  if (state === "CHANGED") return { name, digest: `sha256:${name}`, declared: true, pinned: true, changed: true };
  if (state === "unpinned") return { name, digest: `sha256:${name}`, declared: true, pinned: false, changed: false };
  if (state === "undeclared") return { name, digest: `sha256:${name}`, declared: false, pinned: false, changed: false };
  return { name, digest: `sha256:${name}`, declared: true, pinned: true, changed: false };
}

function taggedOutput() {
  const lines = [];
  const tag = (name) => (value) => `<${name}>${value}</${name}>`;
  const boldRed = tag("bold-red");
  return {
    lines,
    output: {
      log: (line) => lines.push(String(line)),
      style: {
        red: { bold: boldRed },
        yellow: tag("yellow"),
        dim: tag("dim"),
        green: tag("green"),
      },
    },
  };
}

test("skill classification gives changed the highest priority", () => {
  assert.equal(classifySkill(skill("d", "CHANGED")), "CHANGED");
  assert.equal(classifySkill(skill("u", "unpinned")), "unpinned");
  assert.equal(classifySkill(skill("x", "undeclared")), "undeclared");
  assert.equal(classifySkill(skill("p", "pinned")), "pinned");
});

test("skills sort by risk group, then alphabetically", () => {
  const survey = [
    skill("z-pinned", "pinned"), skill("b-changed", "CHANGED"),
    skill("a-undeclared", "undeclared"), skill("a-changed", "CHANGED"),
    skill("z-unpinned", "unpinned"), skill("a-unpinned", "unpinned"),
  ];
  assert.deepEqual(
    sortSkillsForDisplay(survey).map((row) => row.name),
    ["a-changed", "b-changed", "a-unpinned", "z-unpinned", "a-undeclared", "z-pinned"],
  );
});

test("the long survey repeats its summary and styles every textual state", () => {
  const states = ["pinned", "undeclared", "unpinned", "CHANGED"];
  const survey = [];
  for (const state of states) {
    for (const suffix of ["f", "e", "d", "c", "b", "a"]) survey.push(skill(`${state}-${suffix}`, state));
  }
  const { lines, output } = taggedOutput();
  const exit = renderSkillsList(survey, { output, skillsDir: "/many/skills" });

  assert.equal(exit, 1, "changed skills remain a failing status independent of color");
  const summary = "24 skill(s) in /many/skills: 6 pinned, 6 unpinned, 6 undeclared, 6 CHANGED";
  assert.equal(lines.filter((line) => line.includes(summary)).length, 2);

  const rows = lines.filter((line) => line.includes("sha256:"));
  assert.equal(rows.length, 24);
  assert.match(rows[0], /<bold-red>CHANGED<\/bold-red>.*CHANGED-a.*<dim>sha256:CHANGED-a<\/dim>/);
  assert.match(rows[6], /<yellow>unpinned<\/yellow>.*unpinned-a/);
  assert.match(rows[12], /<dim>undeclared<\/dim>.*undeclared-a/);
  assert.match(rows[18], /<green>pinned<\/green>.*pinned-a/);
});

test("a 20-row survey prints its summary once", () => {
  const survey = Array.from({ length: 20 }, (_, i) => skill(`skill-${String(i).padStart(2, "0")}`, "pinned"));
  const { lines, output } = taggedOutput();
  assert.equal(renderSkillsList(survey, { output, skillsDir: "/twenty" }), 0);
  assert.equal(lines.filter((line) => line.includes("20 skill(s) in /twenty")).length, 1);
});
