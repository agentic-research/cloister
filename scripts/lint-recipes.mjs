#!/usr/bin/env node
/**
 * scripts/lint-recipes.mjs — Phase 1 recipe smoke validation
 * (cloister-449f82).
 *
 * Why this exists:
 *
 *   Recipes under `recipes/&lt;name&gt;/` ship as the operator-facing canonical
 *   examples of how to declare a cluster. Today nothing in `task lint`
 *   or `task verify` actually exercises them, so manifest schema
 *   changes / backend-kind renames / canonical-doc additions can
 *   silently break a recipe nobody's testing.
 *
 *   This Phase 1 lint catches the cheap drift surface — file-presence
 *   + canonical-link convention. Phase 2 (deferred) adds capnp/TOML
 *   parse validation; Phase 3 (deferred further) adds local boot
 *   smoke under an opt-in env.
 *
 * Wire:
 *
 *   Exit 0 — every recipe satisfies the Phase 1 contract.
 *   Exit 1 — at least one recipe is missing a required file or
 *            misses the canonical-link convention.
 *   Exit 2 — toolchain error (recipes/ dir missing, etc.).
 *
 * Env:
 *
 *   RECIPES_DIR — override the recipes root (used by tests).
 *                 Defaults to <repo>/recipes/.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const RECIPES_DIR = process.env.RECIPES_DIR
  ? resolve(process.env.RECIPES_DIR)
  : resolve(REPO_ROOT, "recipes");

class ToolchainError extends Error {}

// ── Contract ─────────────────────────────────────────────────────────────

const REQUIRED_FILES = ["README.md"];
const REQUIRED_ONE_OF = [["cloister.capnp", "cluster.toml"]];

/**
 * Canonical reference pages that recipe READMEs SHOULD link to, per
 * the convention shipped under cloister-9d4555 + cloister-9d602f.
 * Soft-required: warn (not block) if a recipe README doesn't link to
 * at least one of these — some recipes are too minimal to need the
 * full topology table. Phase 2 can tighten if drift becomes painful.
 */
const CANONICAL_REFS = [
  "docs/reference/bundle-topology.md",
  "docs/reference/backend-kinds.md",
];

function discoverRecipes() {
  if (!existsSync(RECIPES_DIR) || !statSync(RECIPES_DIR).isDirectory()) {
    throw new ToolchainError(`recipes dir not found at ${RECIPES_DIR}`);
  }
  return readdirSync(RECIPES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: join(RECIPES_DIR, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Phase 2 (cloister-449f82): drive each recipe's `cloister.capnp`
 * through the real `task manifest` pipeline (the same entry point
 * CI + dev + docs use, per the cloister-8e40ad invocation principle)
 * and assert it parses + emits without error. Catches manifest schema
 * changes / backend-kind renames / canonical-doc additions that break
 * a recipe today's Phase 1 file-presence check would miss.
 *
 * Opt-out env: `LINT_RECIPES_SKIP_PARSE=1` (used by the unit test
 * harness — invoking `task manifest` requires the full toolchain so
 * isn't appropriate inside a focused unit test).
 */
function parseCheckRecipe(recipe) {
  if (process.env.LINT_RECIPES_SKIP_PARSE === "1") return null;
  const capnp = join(recipe.path, "cloister.capnp");
  if (!existsSync(capnp)) return null; // only recipes with capnp are checked

  const dir = mkdtempSync(resolve(tmpdir(), "lint-recipes-parse-"));
  const outFile = resolve(dir, "manifest.ts");
  try {
    // Same `task manifest --force` invocation as e2e-manifest-pipeline.test.mjs.
    // CLOISTER_MANIFEST overrides which consumer cloister.capnp gets compiled.
    // --force bypasses Task's checksum cache (env-vars aren't cache keys).
    const r = spawnSync("task", ["manifest", "--force"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLOISTER_MANIFEST: capnp,
        CLOISTER_OUTPUT:   outFile,
      },
      encoding: "utf8",
    });
    if (r.status !== 0) {
      const stderr = (r.stderr || "").trim().split("\n").slice(-5).join("\n");
      return `parse failed (exit ${r.status}):\n        ${stderr}`;
    }
    if (!existsSync(outFile)) {
      return `parse appeared to succeed but no output file was written at ${outFile}`;
    }
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function checkRecipe(recipe) {
  const violations = [];
  const warnings = [];

  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(recipe.path, file))) {
      violations.push(`missing required file: ${file}`);
    }
  }

  for (const group of REQUIRED_ONE_OF) {
    if (!group.some((f) => existsSync(join(recipe.path, f)))) {
      violations.push(`missing required file (one of): ${group.join(", ")}`);
    }
  }

  // Phase 2: parse the recipe's cloister.capnp through the real pipeline.
  const parseErr = parseCheckRecipe(recipe);
  if (parseErr !== null) {
    violations.push(parseErr);
  }

  // Canonical-link convention: soft-required (warn only).
  const readmePath = join(recipe.path, "README.md");
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, "utf8");
    const linksAny = CANONICAL_REFS.some((ref) => readme.includes(ref));
    if (!linksAny) {
      warnings.push(
        `README.md does not link to any canonical reference page. Per cloister-9d4555 + cloister-9d602f, ` +
        `recipes that declare bundles or backends should link to:\n` +
        CANONICAL_REFS.map((r) => `        - ${r}`).join("\n"),
      );
    }
  }

  return { recipe, violations, warnings };
}

// ── Run ──────────────────────────────────────────────────────────────────

let recipes;
try {
  recipes = discoverRecipes();
} catch (e) {
  if (e instanceof ToolchainError) {
    console.error(`lint-recipes: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

if (recipes.length === 0) {
  console.error(`lint-recipes: no recipes found under ${RECIPES_DIR}`);
  process.exit(2);
}

const results = recipes.map(checkRecipe);
const totalViolations = results.reduce((n, r) => n + r.violations.length, 0);
const totalWarnings = results.reduce((n, r) => n + r.warnings.length, 0);

console.log(`lint-recipes: ${recipes.length} recipe(s) scanned`);
for (const r of results) {
  const rel = relative(REPO_ROOT, r.recipe.path);
  if (r.violations.length === 0 && r.warnings.length === 0) {
    console.log(`  ${String.fromCodePoint(0x2713)} ${rel}`);
    continue;
  }
  console.log(`  ${String.fromCodePoint(0x2717)} ${rel}`);
  for (const v of r.violations) {
    console.log(`      [BLOCK] ${v}`);
  }
  for (const w of r.warnings) {
    console.log(`      [WARN]  ${w}`);
  }
}

if (totalViolations > 0) {
  console.error(`\nlint-recipes: ${totalViolations} violation(s) across ${recipes.length} recipe(s) (cloister-449f82)`);
  process.exit(1);
}
if (totalWarnings > 0) {
  console.log(`\nlint-recipes: ${totalWarnings} warning(s) — exit 0 (warnings don't block)`);
}
process.exit(0);
