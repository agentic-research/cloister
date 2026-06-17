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

function runLint(recipesDir, opts = {}) {
  return spawnSync("node", [LINT_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RECIPES_DIR: recipesDir,
      // Phase 2 parse-check shells out to `task manifest` which is too
      // heavy for synthesized unit fixtures; opt out by default so the
      // Phase 1 file-presence + canonical-link tests stay focused.
      // The Phase 2 contract is exercised against REAL recipes via the
      // top-level `task lint:recipes` (Phase 1 + Phase 2 combined) and
      // by the dedicated parse-check test below.
      LINT_RECIPES_SKIP_PARSE: opts.skipParse === false ? "" : "1",
      // Phase 3 (cloister-6b572a / ADR-0031) parses cluster.toml through
      // the bidi pipeline. Synthesized fixture recipes don't carry a
      // valid Cluster schema; opt out for unit tests + flip on for the
      // dedicated Phase 3 test cases below.
      LINT_RECIPES_SKIP_TOML_PARSE: opts.skipTomlParse === false ? "" : "1",
    },
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

// ── Phase 2 (cloister-449f82): recipe cloister.capnp parses through the real pipeline

test("Phase 2: broken recipe cloister.capnp fails the lint", () => {
  // Synthesize a recipe with intentionally broken capnp: missing the
  // required `gateway` symbol that `task manifest` evaluates.
  const t = makeRecipesDir({
    "broken-recipe": {
      "README.md":      "# broken-recipe\n\nlinks to docs/reference/bundle-topology.md\n",
      "cloister.capnp": `# Intentionally broken capnp — no @id, no Gateway value.
# task manifest invocation should fail at capnp eval time.
this is not a valid capnp file at all
`,
    },
  });
  try {
    // Phase 2 ON for this test — exercises the actual task manifest path.
    const r = runLint(t.dir, { skipParse: false });
    assert.notEqual(r.status, 0, "expected lint to fail on broken recipe");
    // Diagnostic mentions parse failure shape
    assert.match(r.stdout + r.stderr, /parse failed/);
  } finally {
    t.cleanup();
  }
});

test("Phase 2: recipe WITHOUT cloister.capnp is skipped (cluster.toml-only recipes OK)", () => {
  // The REQUIRED_ONE_OF check still requires cloister.capnp OR cluster.toml;
  // a recipe with just cluster.toml should pass Phase 1 + skip Phase 2.
  // (cluster.toml parse is the cluster:toml task's responsibility, not
  // this lint's — Phase 3 territory.)
  const t = makeRecipesDir({
    "toml-only-recipe": {
      "README.md":   "# toml-only\n\nlinks to docs/reference/backend-kinds.md\n",
      "cluster.toml": "# A minimal cluster.toml — Phase 2 lint should not invoke task manifest here.\n",
    },
  });
  try {
    const r = runLint(t.dir, { skipParse: false });
    // Phase 1 satisfied (README + one-of), Phase 2 no-op for cluster.toml-only.
    assert.equal(r.status, 0, `expected ok, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    t.cleanup();
  }
});

// ── Phase 3 (cloister-6b572a / ADR-0031): cluster.toml parses through the bidi pipeline

test("Phase 3: broken cluster.toml fails the lint", () => {
  // Synthesize a recipe with a cluster.toml that violates the schema —
  // missing the required `metadata` table. parseTomlToCluster should
  // reject it; the lint should surface the rejection.
  const t = makeRecipesDir({
    "broken-toml-recipe": {
      "README.md":   "# broken-toml\n\nlinks to docs/reference/bundle-topology.md\n",
      // Valid TOML syntax but missing the required `metadata` field —
      // zod's ClusterSchema.parse will reject this.
      "cluster.toml": `# Intentionally schema-incomplete — no [metadata].
[storage]
doStoragePath = "/data/do"
`,
    },
  });
  try {
    // Phase 3 ON, Phase 2 OFF (so the cloister.capnp parse doesn't get in the way).
    const r = runLint(t.dir, { skipTomlParse: false });
    assert.notEqual(r.status, 0, "expected lint to fail on broken cluster.toml");
    assert.match(r.stdout + r.stderr, /cluster\.toml parse failed/);
  } finally {
    t.cleanup();
  }
});

test("Phase 3: recipe WITHOUT cluster.toml is skipped", () => {
  // Recipes that still ship only cloister.capnp must continue to pass —
  // Phase 3 doesn't make cluster.toml mandatory, it just validates it
  // when present.
  const t = makeRecipesDir({
    "capnp-only-recipe": {
      "README.md":      "# capnp-only\n\nlinks to docs/reference/backend-kinds.md\n",
      "cloister.capnp": "@0x0;\n",
    },
  });
  try {
    const r = runLint(t.dir, { skipTomlParse: false });
    assert.equal(r.status, 0, `expected ok, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    t.cleanup();
  }
});
