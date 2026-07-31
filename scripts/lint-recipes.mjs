#!/usr/bin/env node
/**
 * scripts/lint-recipes.mjs — recipe smoke validation (cloister-449f82
 * Phase 1+2, cloister-6b572a / ADR-0031 Phase 3).
 *
 * Why this exists:
 *
 *   Recipes under `recipes/&lt;name&gt;/` ship as the operator-facing canonical
 *   examples of how to declare a cluster. Without a CI gate, manifest
 *   schema changes / backend-kind renames / canonical-doc additions can
 *   silently break a recipe nobody's testing.
 *
 *   Phase 1 catches the cheap drift surface — file-presence + the
 *   canonical-link convention.
 *
 *   Phase 2 drives each recipe's `cloister.capnp` through the real
 *   `task manifest` pipeline (opt-out via `LINT_RECIPES_SKIP_PARSE=1`
 *   for the unit harness).
 *
 *   Phase 3 (cloister-6b572a / ADR-0031): if a recipe ships a
 *   `cluster.toml` (the post-Phase-3 operator surface), drive it
 *   through `parseTomlToCluster` so schema drift in the TOML lane is
 *   caught independently of the cloister.capnp lane. Opt-out via
 *   `LINT_RECIPES_SKIP_TOML_PARSE=1`.
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

// Lazy import — only loaded if at least one recipe ships a cluster.toml.
// `parseTomlToCluster` lives next to this script; importing it pulls in
// `../src/generated/cluster.zod.ts` (a TS file). Tests that synthesize
// pure-fixture recipe trees don't need this and would fail on missing
// generated files in non-cloister harnesses; the lazy import keeps the
// Phase 1/2 happy path independent of the Phase 3 toml-parse check.
let _parseTomlToCluster = null;
async function getParseTomlToCluster() {
  if (_parseTomlToCluster === null) {
    const mod = await import(resolve(HERE, "toml-to-cluster.mjs"));
    _parseTomlToCluster = mod.parseTomlToCluster;
  }
  return _parseTomlToCluster;
}

// Phase 4a (cloister-c919d7): same lazy-import pattern for the
// cloister.capnp emitter. The drift gate compares emit(cluster.toml)
// against the committed cloister.capnp byte-for-byte.
let _emitCloisterCapnp = null;
async function getEmitCloisterCapnp() {
  if (_emitCloisterCapnp === null) {
    const mod = await import(resolve(HERE, "emit-cloister-capnp.mjs"));
    _emitCloisterCapnp = mod.emitCloisterCapnp;
  }
  return _emitCloisterCapnp;
}

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
    // `_`-prefixed directories are NOT recipes. `recipes/_shared/` holds files
    // every scaffold ships regardless of recipe (the Taskfile that makes a
    // scaffolded cluster runnable), so it has no cluster.toml and would fail
    // every recipe rule. Same convention as the leading dot, one character
    // apart, and chosen so the exclusion is visible in the directory listing
    // rather than living only in a filter.
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
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
/**
 * Phase 3 (cloister-6b572a / ADR-0031): if the recipe ships a
 * `cluster.toml`, drive it through the bidi pipeline's parse leg
 * (`parseTomlToCluster`) and assert it shapes cleanly into a validated
 * Cluster. Catches schema drift independently of the Phase 2
 * cloister.capnp check.
 *
 * Recipes that don't ship cluster.toml are skipped (back-compat for the
 * Phase 1 contract; capnp-only recipes still pass).
 *
 * Opt-out env: `LINT_RECIPES_SKIP_TOML_PARSE=1` (used by the unit test
 * harness — synthesized fixtures don't carry a valid Cluster schema).
 *
 * Failure surface: returns a string describing the parse error; null on
 * success / skip. Same shape as parseCheckRecipe so checkRecipe's
 * violation-list mechanism handles it uniformly.
 */
async function tomlParseCheckRecipe(recipe) {
  if (process.env.LINT_RECIPES_SKIP_TOML_PARSE === "1") return null;
  const toml = join(recipe.path, "cluster.toml");
  if (!existsSync(toml)) return null; // only recipes with cluster.toml are checked

  let tomlBody;
  try {
    tomlBody = readFileSync(toml, "utf8");
  } catch (e) {
    return `cluster.toml read failed: ${e.message}`;
  }

  try {
    const parse = await getParseTomlToCluster();
    await parse(tomlBody);
    return null;
  } catch (e) {
    // Trim multi-line zod errors to the first 5 lines for the violation
    // print — operators get the headline; the full body is one re-run away.
    const msg = String(e?.message ?? e).split("\n").slice(0, 5).join("\n        ");
    return `cluster.toml parse failed:\n        ${msg}`;
  }
}

/**
 * Phase 4a (cloister-c919d7 / ADR-0031): per-recipe Pure Model A drift
 * gate. For recipes that ship BOTH `cluster.toml` AND `cloister.capnp`,
 * regenerate the cloister.capnp from the cluster.toml via the emitter
 * and assert it matches the committed copy byte-for-byte. Catches the
 * case where an operator hand-edits a recipe's cloister.capnp without
 * propagating the change to cluster.toml (the post-Phase-4a operator
 * surface).
 *
 * Skipped (returns null) when:
 *   - LINT_RECIPES_SKIP_CAPNP_DRIFT=1 (unit test harness opt-out)
 *   - the recipe lacks cluster.toml (capnp-only recipe; Pure Model A
 *     doesn't apply — the cloister.capnp IS the source of truth)
 *   - the recipe lacks cloister.capnp (cluster.toml-only recipe;
 *     the cluster.toml IS the source of truth, no drift to gate)
 *
 * Returns a violation string on drift; null on success / skip.
 */
async function capnpDriftCheckRecipe(recipe) {
  if (process.env.LINT_RECIPES_SKIP_CAPNP_DRIFT === "1") return null;
  const toml = join(recipe.path, "cluster.toml");
  const capnp = join(recipe.path, "cloister.capnp");
  if (!existsSync(toml) || !existsSync(capnp)) return null;

  let tomlBody, capnpBody;
  try {
    tomlBody = readFileSync(toml, "utf8");
  } catch (e) {
    return `cluster.toml read failed: ${e.message}`;
  }
  try {
    capnpBody = readFileSync(capnp, "utf8");
  } catch (e) {
    return `cloister.capnp read failed: ${e.message}`;
  }

  let parsed;
  try {
    const parse = await getParseTomlToCluster();
    parsed = await parse(tomlBody);
  } catch (e) {
    // Schema-level parse errors surface via tomlParseCheckRecipe;
    // skip the drift gate here so the operator only sees one violation.
    return null;
  }

  let emitted;
  try {
    const emit = await getEmitCloisterCapnp();
    // Quiet — the Phase 4a fall-through warning is signal for
    // interactive emit calls, but the drift gate runs in CI where
    // it'd just be noise.
    emitted = emit(parsed, { quiet: true });
  } catch (e) {
    return `cloister.capnp emit failed: ${e.message}`;
  }

  if (emitted === capnpBody) return null;

  // Provide a compact diff hint — the first divergent line points
  // operators at the field they need to fix in cluster.toml (or to the
  // file they hand-edited without canonicalizing).
  const emittedLines = emitted.split("\n");
  const capnpLines = capnpBody.split("\n");
  const len = Math.max(emittedLines.length, capnpLines.length);
  let firstDelta = null;
  for (let i = 0; i < len; i++) {
    if (emittedLines[i] !== capnpLines[i]) {
      firstDelta = { i: i + 1, want: emittedLines[i] ?? "<EOF>", have: capnpLines[i] ?? "<EOF>" };
      break;
    }
  }
  let hint = "";
  if (firstDelta) {
    hint = `\n        first delta at line ${firstDelta.i}:\n` +
           `          want (emit): ${firstDelta.want.slice(0, 80)}\n` +
           `          have (file): ${firstDelta.have.slice(0, 80)}`;
  }
  return (
    `cloister.capnp drift (Pure Model A invariant violated):\n` +
    `        emit(cluster.toml) differs from the committed cloister.capnp.\n` +
    `        Run \`task emit:cloister-capnp\` inside the recipe (or update\n` +
    `        cluster.toml to match the desired cloister.capnp) and commit both.\n` +
    `        Per cloister-c919d7 / ADR-0031 Phase 4a.${hint}`
  );
}

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

async function checkRecipe(recipe) {
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

  // Phase 3 (cloister-6b572a / ADR-0031): parse the recipe's cluster.toml
  // through the bidi pipeline. Catches schema-shape drift in cluster.toml
  // independently of cloister.capnp (which Phase 2 already validates).
  // Opt-out via `LINT_RECIPES_SKIP_TOML_PARSE=1` for the unit test harness
  // (synthesized fixture recipes don't carry a valid schema).
  const tomlErr = await tomlParseCheckRecipe(recipe);
  if (tomlErr !== null) {
    violations.push(tomlErr);
  }

  // Phase 4a (cloister-c919d7 / ADR-0031): Pure Model A drift gate.
  // For recipes shipping BOTH cluster.toml + cloister.capnp, the
  // committed cloister.capnp MUST be byte-identical to
  // emit(cluster.toml). Closes the gap left by Phase 3 Hybrid Model A
  // (where the two files could drift independently because the emitter
  // pinned gateway.metadata / actor / policy to ART-default).
  // Opt-out via `LINT_RECIPES_SKIP_CAPNP_DRIFT=1` for the unit test harness.
  const capnpDriftErr = await capnpDriftCheckRecipe(recipe);
  if (capnpDriftErr !== null) {
    violations.push(capnpDriftErr);
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

const results = [];
for (const r of recipes) {
  results.push(await checkRecipe(r));
}
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
