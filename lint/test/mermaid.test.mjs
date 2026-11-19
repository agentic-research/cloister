// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint/mermaid.mjs, held to what it claims: a diagram that would not draw is
// reported, and the tree as committed has none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { lintMarkdown, mermaidBlocks, trackedMarkdown } from "../mermaid.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const doc = (...lines) => ["# t", "", "```mermaid", ...lines, "```", ""].join("\n");

test("every diagram in a tracked markdown file passes", async () => {
  let diagrams = 0;
  for (const file of trackedMarkdown(ROOT)) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    diagrams += mermaidBlocks(text).length;
    assert.deepEqual(await lintMarkdown(text), [], file);
  }
  // Not vacuous: the architecture document alone has more than ten.
  assert.ok(diagrams > 10, `only ${diagrams} diagrams were found`);
});

test("a diagram that does not parse is reported, at its line", async () => {
  const errors = await lintMarkdown(doc("graph TB", "    A --> --> B", "    B --> C"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^L5: does not parse: /);
});

test("a sequence diagram is parsed too, not only a flowchart", async () => {
  assert.match((await lintMarkdown(doc("sequenceDiagram", "    A->>B no colon")))[0], /does not parse/);
  assert.deepEqual(await lintMarkdown(doc("sequenceDiagram", "    A->>B: hello")), []);
});

test("what parses and still draws wrongly on GitHub is reported", async () => {
  // mermaid invents an empty node for an edge to a name never declared.
  assert.match((await lintMarkdown(doc("graph TB", '    A["a"] --> GHOST')))[0], /undeclared node `GHOST`/);
  assert.match((await lintMarkdown(doc("graph TB", '    A["a"]', "    style GHOST fill:#fff")))[0], /style block names undeclared node `GHOST`/);
});

test("a correct diagram is not reported", async () => {
  assert.deepEqual(await lintMarkdown(doc("graph TB", '    A["a<br/>b"] -->|"calls (http)"| B["b"]')), []);
});

test("the task checks every tracked file, not a named few", () => {
  const { tasks } = parse(readFileSync(resolve(ROOT, "lint/Taskfile.yml"), "utf8"));
  assert.deepEqual(tasks["mermaid:lint"].cmds, ["node lint/mermaid.mjs"]);
});
