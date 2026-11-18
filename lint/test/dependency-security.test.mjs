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

test("lockfile keeps PostCSS, sharp and undici above current advisory floors", () => {
  // lint-allow-rawparse: the lockfile is YAML, but this test deliberately
  // treats it as opaque text and only checks that forbidden version tokens do
  // not return; parsing the whole dependency graph would test pnpm itself.
  const lock = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");

  assert.match(lock, /postcss@<8\.5\.18:\s*\^8\.5\.19/);
  assert.match(lock, /sharp@<0\.35\.5:\s*\^0\.35\.5/);
  assert.match(lock, /undici@>=7\.0\.0 <7\.30\.1:\s*\^7\.30\.1/);
  assert.match(lock, /postcss@8\.5\.(?:1[89]|[2-9]\d)/);
  assert.match(lock, /sharp@0\.35\.(?:[5-9]|\d{2,})/);
  assert.doesNotMatch(lock, /postcss@8\.5\.(?:[0-9]|1[0-7])\b/);
  assert.doesNotMatch(lock, /sharp@0\.(?:34\.|35\.[0-4]\b)/);
  // cloister-6ecd70: 18 open undici advisories were all < 7.30.1, reached
  // through miniflare's exact 7.28.0 pin.
  assert.doesNotMatch(lock, /undici@7\.(?:[0-9]|1\d|2\d|30\.0)\b/);
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
