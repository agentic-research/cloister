// Dependency security floors.
//
// These packages are transitive (Vite → PostCSS and Wrangler/Miniflare →
// sharp), so the lockfile—not package.json—is the artifact that must stay
// above the advisory fixed versions.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("lockfile keeps PostCSS and sharp above current advisory floors", () => {
  // lint-allow-rawparse: the lockfile is YAML, but this test deliberately
  // treats it as opaque text and only checks that forbidden version tokens do
  // not return; parsing the whole dependency graph would test pnpm itself.
  const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");

  assert.match(lock, /postcss@<8\.5\.18:\s*\^8\.5\.19/);
  assert.match(lock, /sharp@<0\.35\.3:\s*\^0\.35\.3/);
  assert.match(lock, /postcss@8\.5\.(?:1[89]|[2-9]\d)/);
  assert.match(lock, /sharp@0\.35\.[3-9]\d*/);
  assert.doesNotMatch(lock, /postcss@8\.5\.(?:[0-9]|1[0-7])\b/);
  assert.doesNotMatch(lock, /sharp@0\.34\./);
});

test("the development toolchain resolves one Miniflare generation", () => {
  // lint-allow-rawparse: count opaque package keys; no YAML value semantics
  // are involved, and a parser would only reproduce pnpm's package inventory.
  const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  const packages = lock.split("\nsnapshots:\n", 1)[0];
  const miniflareVersions = packages.match(/^  miniflare@[^:]+:/gm) ?? [];

  assert.equal(
    miniflareVersions.length,
    1,
    `expected one Miniflare package, found: ${miniflareVersions.join(", ")}`,
  );
});
