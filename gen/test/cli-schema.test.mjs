// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CLI's JSON outputs are declared in manifest/cli.capnp and versioned in
// schema/cli-formats.lock.json (ADR-0077). These hold the parts a reader has
// to trust: that the gate passes on the shipped tree because the tree is in
// step, not because it checks nothing; that the bump is decided by the
// change, not chosen; and that the CLI refuses to print an output that does
// not match its declaration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSON_SCHEMA, LOCK, changeBetween, check, outputsOf, signatureOf } from "../cli-schema.mjs";
import { declaredOutput, formatVersion } from "../../cli/lib/output-format.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = JSON.parse(readFileSync(resolve(ROOT, JSON_SCHEMA), "utf8"));
const lock = JSON.parse(readFileSync(resolve(ROOT, LOCK), "utf8"));

test("the shipped tree passes the gate, and the gate read real outputs", () => {
  assert.deepEqual(check(), []);
  const outputs = outputsOf(schema);
  assert.ok(outputs.includes("Graph"), `outputs: ${outputs}`);
  for (const name of outputs) {
    assert.match(lock.outputs[name].formatVersion, /^\d+\.\d+$/);
    assert.deepEqual(lock.outputs[name].shape, signatureOf(schema, name), name);
  }
});

test("a description is not part of an output's shape", () => {
  const reworded = structuredClone(schema);
  reworded.$defs.GraphEdge.properties.why.description = "said differently";
  assert.deepEqual(signatureOf(reworded, "Graph"), signatureOf(schema, "Graph"));
});

test("a field or enum value only added is a minor change", () => {
  const prev = signatureOf(schema, "Graph");
  const next = structuredClone(prev);
  next.GraphEdge.fields.port = "string";
  next.Strength.enum = [...next.Strength.enum, "sealed"];
  const { kind, changes } = changeBetween(prev, next);
  assert.equal(kind, "minor");
  assert.deepEqual(changes.sort(), ["GraphEdge.port added", 'Strength: value "sealed" added']);
});

test("a field removed or retyped, or an enum value removed, is a major change", () => {
  const prev = signatureOf(schema, "Graph");
  for (const [what, edit] of [
    ["removed", (s) => { delete s.GraphEdge.fields.why; }],
    ["retyped", (s) => { s.GraphEdge.fields.meetsMinimum = "string"; }],
    ["value removed", (s) => { s.Strength.enum = s.Strength.enum.filter((v) => v !== "policy"); }],
  ]) {
    const next = structuredClone(prev);
    edit(next);
    assert.equal(changeBetween(prev, next).kind, "major", what);
  }
  assert.equal(changeBetween(prev, structuredClone(prev)).kind, "same");
});

const edge = {
  from: "a", to: "b", declaredAs: "connection", name: "b", carrier: "x", strength: "none",
  minStrength: "none", meetsMinimum: true, why: "nothing enforces it",
};
const graph = { env: "local", edges: [edge], elsewhere: [], counts: { none: 1, policy: 0, capability: 0 } };

test("an output that matches its declaration is printed with its version first", async () => {
  const out = await declaredOutput("Graph", graph);
  assert.equal(Object.keys(out)[0], "formatVersion");
  assert.equal(out.formatVersion, formatVersion("Graph"));
});

test("an output with a field the declaration lacks is refused", async () => {
  await assert.rejects(declaredOutput("Graph", { ...graph, extra: 1 }), /does not match manifest\/cli\.capnp/);
});

test("an output missing a declared field is refused, though the schema has a default for it", async () => {
  const { why: _why, ...withoutWhy } = edge;
  await assert.rejects(declaredOutput("Graph", { ...graph, edges: [withoutWhy] }), /lacks fields manifest\/cli\.capnp declares/);
});

test("an output with a value outside an enum is refused", async () => {
  await assert.rejects(declaredOutput("Graph", { ...graph, edges: [{ ...edge, strength: "strong" }] }), /does not match/);
});

test("a union's variants are part of its shape: added is minor, removed is major", () => {
  const prev = signatureOf(schema, "InspectReport");
  assert.ok(prev.FindingSubject.union?.wire, "the union's variants are recorded");
  const added = structuredClone(prev);
  added.FindingSubject.union.route = "string";
  assert.equal(changeBetween(prev, added).kind, "minor");
  const removed = structuredClone(prev);
  delete removed.FindingSubject.union.wire;
  assert.equal(changeBetween(prev, removed).kind, "major");
});
