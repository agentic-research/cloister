// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for capability-matchmaker.mjs — ADR-0027's resolution core
// (cloister-e059ea). No regex assertions per operator standing rule.
//
// These are exhaustive and model-free by design: ADR-0054's whole argument is
// that the symbolic half is PROVABLE rather than sampled, unlike the neural half
// whose correctness we could only measure statistically.
//
// Run: node --import tsx --test scripts/test/capability-matchmaker.test.mjs

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  MatchError,
  collectProviders,
  detectCycle,
  matchCapabilities,
} from "../capability-matchmaker.mjs";

const input = (name, provides = [], requires = []) => ({ name, provides, requires });

// ── step 1 ────────────────────────────────────────────────────────────────
test("collectProviders indexes every provides, preserving order", () => {
  const p = collectProviders([
    input("mache", ["cloister/code-intelligence/v1"]),
    input("rosary", ["cloister/beads/v1", "cloister/dispatch/v1"]),
  ]);
  assert.deepEqual(p.get("cloister/code-intelligence/v1"), ["mache"]);
  assert.deepEqual(p.get("cloister/beads/v1"), ["rosary"]);
  assert.equal(p.has("cloister/nope/v1"), false);
});

test("an input listing the same capability twice is not ambiguous with itself", () => {
  const p = collectProviders([input("a", ["cap/v1", "cap/v1"])]);
  assert.deepEqual(p.get("cap/v1"), ["a"]);
});

// ── step 2: the fail-closed cases ─────────────────────────────────────────
test("unsatisfied requires is REJECTED and names what is missing", () => {
  const inputs = [input("worker", [], ["cloister/code-intelligence/v1"])];
  assert.throws(
    () => matchCapabilities(inputs),
    (e) => {
      assert.ok(e instanceof MatchError);
      assert.equal(e.code, "unsatisfied");
      assert.ok(e.message.includes("worker"), "names the consumer");
      assert.ok(e.message.includes("cloister/code-intelligence/v1"), "names the capability");
      return true;
    },
  );
});

test("ambiguous requires is REJECTED and lists the candidates", () => {
  const inputs = [
    input("mache", ["cap/v1"]),
    input("llo", ["cap/v1"]),
    input("worker", [], ["cap/v1"]),
  ];
  assert.throws(
    () => matchCapabilities(inputs),
    (e) => {
      assert.equal(e.code, "ambiguous");
      assert.deepEqual(e.detail.candidates, ["mache", "llo"]);
      return true;
    },
  );
});

test("an explicit override breaks ambiguity", () => {
  const inputs = [
    input("mache", ["cap/v1"]),
    input("llo", ["cap/v1"]),
    input("worker", [], ["cap/v1"]),
  ];
  const { bindings } = matchCapabilities(inputs, { overrides: { "cap/v1": "llo" } });
  assert.deepEqual(bindings, [{ consumer: "worker", capability: "cap/v1", provider: "llo" }]);
});

test("an override naming a NON-provider is rejected, not silently honoured", () => {
  // Otherwise a typo reintroduces the ambiguity it was meant to resolve.
  const inputs = [
    input("mache", ["cap/v1"]),
    input("llo", ["cap/v1"]),
    input("worker", [], ["cap/v1"]),
  ];
  assert.throws(
    () => matchCapabilities(inputs, { overrides: { "cap/v1": "typo" } }),
    (e) => e.code === "bad-override",
  );
});

test("an input cannot satisfy its own requires", () => {
  // Self-satisfaction is not wiring; it degenerates the lattice.
  const inputs = [input("solo", ["cap/v1"], ["cap/v1"])];
  assert.throws(() => matchCapabilities(inputs), (e) => e.code === "self-provided");
});

// ── step 4: cycles ────────────────────────────────────────────────────────
test("detectCycle finds a direct 2-node cycle and names the path", () => {
  const cycle = detectCycle([
    { consumer: "a", capability: "x", provider: "b" },
    { consumer: "b", capability: "y", provider: "a" },
  ]);
  assert.ok(cycle !== null);
  assert.ok(cycle.includes("a") && cycle.includes("b"));
});

test("detectCycle finds a 3-node cycle", () => {
  const cycle = detectCycle([
    { consumer: "a", capability: "x", provider: "b" },
    { consumer: "b", capability: "y", provider: "c" },
    { consumer: "c", capability: "z", provider: "a" },
  ]);
  assert.ok(cycle !== null);
  for (const n of ["a", "b", "c"]) assert.ok(cycle.includes(n), `path should name ${n}`);
});

test("a DAG (diamond) is NOT reported as a cycle", () => {
  // a→b, a→c, b→d, c→d. Shared descendants must not look circular.
  assert.equal(
    detectCycle([
      { consumer: "a", capability: "1", provider: "b" },
      { consumer: "a", capability: "2", provider: "c" },
      { consumer: "b", capability: "3", provider: "d" },
      { consumer: "c", capability: "4", provider: "d" },
    ]),
    null,
  );
});

test("matchCapabilities rejects a cycle with the path in the message", () => {
  const inputs = [
    input("a", ["capA/v1"], ["capB/v1"]),
    input("b", ["capB/v1"], ["capA/v1"]),
  ];
  assert.throws(
    () => matchCapabilities(inputs),
    (e) => {
      assert.equal(e.code, "cycle");
      assert.ok(e.message.includes("→"), "renders the cycle path");
      return true;
    },
  );
});

// ── input hygiene ─────────────────────────────────────────────────────────
test("duplicate input names are rejected", () => {
  assert.throws(
    () => matchCapabilities([input("dup", ["a/v1"]), input("dup", ["b/v1"])]),
    (e) => e.code === "duplicate-input",
  );
});

test("an input without a usable name is rejected", () => {
  assert.throws(() => matchCapabilities([{ provides: [] }]), (e) => e.code === "bad-input");
  assert.throws(() => matchCapabilities([{ name: "" }]), (e) => e.code === "bad-input");
});

test("a non-array input set is rejected rather than coerced", () => {
  assert.throws(() => matchCapabilities(null), (e) => e.code === "bad-input");
});

// ── the happy path ────────────────────────────────────────────────────────
test("a satisfiable lattice resolves to explicit bindings", () => {
  const inputs = [
    input("mache", ["cloister/code-intelligence/v1"]),
    input("rosary", ["cloister/beads/v1"], ["cloister/code-intelligence/v1"]),
    input("worker", [], ["cloister/beads/v1"]),
  ];
  const { bindings } = matchCapabilities(inputs);
  assert.deepEqual(bindings, [
    { consumer: "rosary", capability: "cloister/code-intelligence/v1", provider: "mache" },
    { consumer: "worker", capability: "cloister/beads/v1", provider: "rosary" },
  ]);
});

test("inputs with neither provides nor requires are inert, not errors", () => {
  const { bindings } = matchCapabilities([input("standalone")]);
  assert.deepEqual(bindings, []);
});

test("the real cluster.toml inputs resolve (currently no declared lattice)", async () => {
  // Live guard: today no input declares provides/requires, so the matchmaker
  // must be a clean no-op rather than throwing. When a lattice IS declared,
  // this test starts proving the shipped cluster actually resolves.
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("@iarna/toml");
  const raw = parse(readFileSync("cluster.toml", "utf8"));
  const inputs = Object.entries(raw.inputs ?? {}).map(([name, v]) => ({
    name,
    provides: v.provides ?? [],
    requires: v.requires ?? [],
  }));
  const { bindings } = matchCapabilities(inputs);
  assert.ok(Array.isArray(bindings));
});
