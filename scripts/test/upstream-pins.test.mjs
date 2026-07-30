// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Companion test for scripts/lint-upstream-pins.mjs.
//
// The repo's rule for rails: each must have a test asserting THE SHIPPED TREE
// satisfies it, so the rail cannot pass vacuously. A rail exercised only
// against fixtures proves the matcher works, not that the property holds.
//
// This one carries an extra burden. The rail it guards was, until now, a claim
// in `task lint`'s description and nothing else — so the test must also pin
// that the claim is now backed, and fail if the wiring is removed while the
// description keeps advertising it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@iarna/toml";
import { collectLloPins } from "../lint-upstream-pins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the shipped Rust workspace pins ley-line-open at exactly one rev + version", () => {
  const pins = collectLloPins();
  assert.ok(pins.length >= 3, `expected ≥3 LLO pins, found ${pins.length}`);

  const revs = [...new Set(pins.map((p) => p.rev))];
  const versions = [...new Set(pins.map((p) => p.version))];

  assert.deepEqual(
    revs.length,
    1,
    `LLO pinned at ${revs.length} revs — cargo would compile the shared crates ` +
    `once per rev:\n${pins.map((p) => `  ${p.file}: ${p.name} @ ${p.rev.slice(0, 8)}`).join("\n")}`,
  );
  assert.deepEqual(versions.length, 1, `LLO pinned at versions ${versions.join(", ")}`);
});

test("the pins span more than one manifest — the cross-file case is real", () => {
  // The missed pin that motivated this rail was in a DIFFERENT Cargo.toml from
  // the other four. If every pin ever collapses into one manifest, the
  // cross-file walk stops being exercised and this test should be revisited
  // rather than silently covering nothing.
  const files = new Set(collectLloPins().map((p) => p.file));
  assert.ok(
    files.size >= 2,
    `all LLO pins now live in one manifest (${[...files]}); the cross-manifest ` +
    `walk is no longer exercised by the real tree`,
  );
});

test("the shipped tree states ONE ley-line-open version across all three channels", () => {
  // The property the first version of this rail lacked entirely. It compared
  // Cargo pins to EACH OTHER, so three internally-consistent channels reading
  // 0.11.3 / 0.12.0 / 0.12.1 simultaneously produced no complaint — they were
  // realigned by hand, which is maintenance, not a fix.
  //
  // Read here independently of the lint's own readers, so a bug in those does
  // not make both agree on a wrong answer.
  const cargo = [...new Set(collectLloPins().map((p) => p.version))];
  assert.equal(cargo.length, 1, `cargo states ${cargo.length} versions: ${cargo}`);

  const toml = parseToml(readFileSync(resolve(ROOT, "cluster.toml"), "utf8"));
  const input = toml.inputs?.llo?.version;
  assert.ok(input, "[inputs.llo] must declare a version");

  const gen = JSON.parse(readFileSync(resolve(ROOT, "schema-bridge.lock.json"), "utf8")).version;
  assert.ok(gen, "schema-bridge.lock.json must declare a version");

  // ADR-0041: the `v` prefix is a per-repo convention, not a mandate, so a
  // Cargo semver field and a release tag legitimately differ by it.
  const strip = (v) => String(v).replace(/^v/, "");
  assert.deepEqual(
    [...new Set([strip(cargo[0]), strip(input), strip(gen)])].length,
    1,
    `channels disagree — cargo=${cargo[0]} input=${input} generator=${gen}`,
  );
});

test("the rail is wired into `task lint`, not merely described by it", () => {
  // lint-allow-rawparse: reads Taskfile TEXT because the assertion is about a
  // name appearing in a deps array, and this must keep holding if deps move
  // between inline and block form.
  const tf = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");

  const lintDeps = /^ {2}lint:\n(?:.*\n)*?\s+deps:\s*\[([^\]]*)\]/m.exec(tf);
  assert.ok(lintDeps, "could not locate `lint`'s deps array");
  assert.ok(
    lintDeps[1].split(",").map((s) => s.trim()).includes("lint:upstream-pins"),
    "`lint` no longer depends on lint:upstream-pins — the description's " +
    "\"cargo-pin lint\" claim would be unbacked again, which is the exact " +
    "condition this rail was written to end",
  );
});

test("the rail actually fails on a divergent rev (not just on nothing)", (t) => {
  // A green rail proves nothing unless it can go red. Rather than mutating the
  // real manifests, run the collector over a temp tree.
  const dir = mkdtempSync(join(tmpdir(), "upstream-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const U = "https://github.com/agentic-research/ley-line-open";
  for (const [sub, rev] of [["a", "1".repeat(40)], ["b", "2".repeat(40)]]) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(
      join(dir, sub, "Cargo.toml"),
      `[dependencies]\nleyline-core = { git = "${U}", rev = "${rev}", version = "0.1.0" }\n`,
    );
  }
  const revs = new Set(collectLloPins(dir).map((p) => p.rev));
  assert.equal(revs.size, 2, "collector must see both divergent revs");

  // And the CLI must exit non-zero on the real failure shape. Driven as a
  // process because that is how the gate invokes it.
  const r = spawnSync(process.execPath, [resolve(ROOT, "scripts/lint-upstream-pins.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `the real tree must pass:\n${r.stderr}${r.stdout}`);
});

test("an inline-table pin and a [dependencies.x] table pin are both seen", (t) => {
  // Cargo accepts both forms. A line-anchored regex reads whichever the author
  // used and misses the other — the failure mode that produced four phantom
  // binding-parity violations before @iarna/toml replaced that regex.
  const dir = mkdtempSync(join(tmpdir(), "upstream-pins-forms-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const U = "https://github.com/agentic-research/ley-line-open";
  const REV = "3".repeat(40);

  mkdirSync(join(dir, "inline"), { recursive: true });
  writeFileSync(
    join(dir, "inline", "Cargo.toml"),
    `[dependencies]\nleyline-core = { git = "${U}", rev = "${REV}", version = "0.1.0" }\n`,
  );
  mkdirSync(join(dir, "table"), { recursive: true });
  writeFileSync(
    join(dir, "table", "Cargo.toml"),
    `[dependencies.leyline-sign]\ngit = "${U}"\nrev = "${REV}"\nversion = "0.1.0"\n`,
  );
  mkdirSync(join(dir, "targeted"), { recursive: true });
  writeFileSync(
    join(dir, "targeted", "Cargo.toml"),
    `[target.'cfg(unix)'.dependencies]\n` +
    `leyline-fs = { git = "${U}", rev = "${REV}", version = "0.1.0", package = "leyline-fs" }\n`,
  );

  const names = collectLloPins(dir).map((p) => p.name).sort();
  assert.deepEqual(names, ["leyline-core", "leyline-fs", "leyline-sign"]);
});
