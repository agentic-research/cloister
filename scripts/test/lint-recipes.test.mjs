// scripts/test/lint-recipes.test.mjs
//
// Run with:  node --test scripts/test/lint-recipes.test.mjs
//
// Contract tests for scripts/lint-recipes.mjs — Phase 1 recipe smoke
// validation (cloister-449f82). Tests synthesize a tmpdir with a fake
// recipes/ tree, then spawn the lint with RECIPES_DIR pointing at it.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LINT_SCRIPT = resolve(REPO_ROOT, "scripts/lint-recipes.mjs");

function makeRecipesDir(recipes) {
  const dir = mkdtempSync(resolve(tmpdir(), "recipes-lint-"));
  for (const [name, files] of Object.entries(recipes)) {
    const recipePath = resolve(dir, name);
    mkdirSync(recipePath, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(resolve(recipePath, filename), content);
    }
  }
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function runLint(recipesDir) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, RECIPES_DIR: recipesDir },
    encoding: "utf8",
  });
}

// ── Tests ────────────────────────────────────────────────────────────

test("happy path: recipe with README + cloister.capnp + canonical link → exit 0 clean", () => {
  const fx = makeRecipesDir({
    "good-recipe": {
      "README.md": "See [bundle topology](../../docs/reference/bundle-topology.md).\n",
      "cloister.capnp": "@0x0;\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /1 recipe\(s\) scanned/);
    assert.match(r.stdout, /good-recipe/);
  } finally { fx.cleanup(); }
});

test("missing README.md → exit 1 (BLOCK)", () => {
  const fx = makeRecipesDir({
    "broken-recipe": {
      "cloister.capnp": "@0x0;\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing required file: README\.md/);
  } finally { fx.cleanup(); }
});

test("missing cloister.capnp AND cluster.toml → exit 1 (one-of group)", () => {
  const fx = makeRecipesDir({
    "no-manifest": {
      "README.md": "See [bundle topology](../../docs/reference/bundle-topology.md).\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing required file \(one of\): cloister\.capnp, cluster\.toml/);
  } finally { fx.cleanup(); }
});

test("either cloister.capnp OR cluster.toml satisfies the one-of group", () => {
  const fx = makeRecipesDir({
    "toml-only": {
      "README.md": "See [bundle topology](../../docs/reference/bundle-topology.md).\n",
      "cluster.toml": '[metadata]\nname = "test"\n',
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  } finally { fx.cleanup(); }
});

test("missing canonical link → WARN (exit 0, but flagged)", () => {
  const fx = makeRecipesDir({
    "no-canonical-link": {
      "README.md": "Just a plain readme with no canonical reference.\n",
      "cloister.capnp": "@0x0;\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0);  // warn only, doesn't block
    assert.match(r.stdout, /WARN/);
    assert.match(r.stdout, /does not link to any canonical reference page/);
  } finally { fx.cleanup(); }
});

test("either canonical reference (bundle-topology OR backend-kinds) satisfies the link gate", () => {
  const fx = makeRecipesDir({
    "links-backend-kinds-only": {
      "README.md": "See [backends](../../docs/reference/backend-kinds.md).\n",
      "cloister.capnp": "@0x0;\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /WARN/);
  } finally { fx.cleanup(); }
});

test("multiple recipes: BLOCK in one fails the whole run", () => {
  const fx = makeRecipesDir({
    "good": {
      "README.md": "See [bundle topology](../../docs/reference/bundle-topology.md).\n",
      "cloister.capnp": "@0x0;\n",
    },
    "broken": {
      "cloister.capnp": "@0x0;\n",
      // no README → BLOCK
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /2 recipe\(s\) scanned/);
    assert.match(r.stdout, /missing required file: README\.md/);
  } finally { fx.cleanup(); }
});

test("dotfile directories are skipped", () => {
  const fx = makeRecipesDir({
    ".hidden": { "README.md": "skipped" },
    "real": {
      "README.md": "See [bundle topology](../../docs/reference/bundle-topology.md).\n",
      "cloister.capnp": "@0x0;\n",
    },
  });
  try {
    const r = runLint(fx.dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /1 recipe\(s\) scanned/);
    assert.doesNotMatch(r.stdout, /\.hidden/);
  } finally { fx.cleanup(); }
});

test("missing recipes/ dir → exit 2 (toolchain error)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recipes-lint-empty-"));
  try {
    const r = runLint(resolve(dir, "does-not-exist"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /recipes dir not found/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("empty recipes/ dir → exit 2", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recipes-lint-empty-"));
  try {
    const r = runLint(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no recipes found/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
