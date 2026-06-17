#!/usr/bin/env node
// scripts/cli-init.mjs — `cloister init` scaffold subcommand (cloister-ca1dab).
//
// Usage:
//   cloister init --recipe <name> --out <dir> [--port N] [--force]
//   node scripts/cli-init.mjs --recipe <name> --out <dir>
//
// Lays a known-good starter manifest down into <out>. Recipes live
// verbatim under `recipes/<name>/` at the repo root — no codegen at
// runtime, just file copies with optional port substitution.
//
// Recipes are discovered at runtime by listing the `recipes/` directory
// next to the script. Adding a new recipe means dropping a directory
// containing `cluster.compose.yaml`, `cloister.capnp`, `README.md`,
// and (post Phase 3 of ADR-0031) `cluster.toml`; no CLI changes needed.
//
// The CLI is hand-rolled (no commander/yargs dep) — the surface is
// small enough that pulling in a parser would be more cost than value.
// Lives in `scripts/` (not `src/cli/`) because src/ is the worker
// bundle path; CLI tooling that uses node:fs / process belongs under
// scripts/ where tsc's worker config doesn't see it. Per bead
// cloister-ca1dab option (a).

import {
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Recipe discovery ──────────────────────────────────────────────────────

// Recipes live at <repo-root>/recipes/. The script lives at
// <repo-root>/scripts/cli-init.mjs, so one level up is the repo root.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up from `start` looking for a directory containing both
 * `recipes/` and `package.json`. Returns the first match or null.
 *
 * Exported so tests can override the search root.
 *
 * @param {string} start
 * @returns {string | null}
 */
export function findRecipesRoot(start) {
  let cur = start;
  // Cap the walk so a misconfigured invocation doesn't hit / and beyond.
  for (let i = 0; i < 8; i++) {
    const recipes = join(cur, "recipes");
    const pkg = join(cur, "package.json");
    if (existsSync(recipes) && existsSync(pkg)) return recipes;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Files every recipe ships. Order matters for the smoke test.
 *
 * cluster.toml is the post-ADR-0031-Phase-3 operator-readable surface
 * (cloister-6b572a). It's copied alongside cloister.capnp; both ship in
 * the scaffold output so the operator can read the TOML and the
 * runtime can consume the capnp. Phase 4 retires cloister.capnp once
 * the emitter consumes `[gateway]` from cluster.toml.
 */
export const RECIPE_FILES = Object.freeze([
  "cluster.compose.yaml",
  "cluster.toml",
  "cloister.capnp",
  "README.md",
]);

/**
 * Return the list of recipe names available under <recipesRoot>.
 *
 * @param {string} recipesRoot
 * @returns {string[]}
 */
export function listRecipes(recipesRoot) {
  if (!existsSync(recipesRoot)) return [];
  return readdirSync(recipesRoot)
    .filter((name) => {
      const full = join(recipesRoot, name);
      if (!statSync(full).isDirectory()) return false;
      // A valid recipe ships at least:
      //   - cloister.capnp        (runtime artifact)
      //   - cluster.compose.yaml  (compose topology)
      //   - cluster.toml          (operator-readable surface, Phase 3 of ADR-0031)
      return (
        existsSync(join(full, "cloister.capnp")) &&
        existsSync(join(full, "cluster.compose.yaml")) &&
        existsSync(join(full, "cluster.toml"))
      );
    })
    .sort();
}

// ── Arg parsing ───────────────────────────────────────────────────────────

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {{recipe: string|null, out: string|null, port: number|null, force: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const opts = {
    recipe: null,
    out: null,
    port: null,
    force: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
      i++;
      continue;
    }
    if (a === "--force") {
      opts.force = true;
      i++;
      continue;
    }
    if (a === "--recipe" || a === "-r") {
      opts.recipe = argv[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (a === "--out" || a === "-o") {
      opts.out = argv[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (a === "--port" || a === "-p") {
      const raw = argv[i + 1] ?? "";
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new UsageError(
          `invalid --port value: ${JSON.stringify(raw)} (must be 1..65535)`,
        );
      }
      opts.port = n;
      i += 2;
      continue;
    }
    // `=` form support: --recipe=foo
    if (a.startsWith("--recipe=")) {
      opts.recipe = a.slice("--recipe=".length);
      i++;
      continue;
    }
    if (a.startsWith("--out=")) {
      opts.out = a.slice("--out=".length);
      i++;
      continue;
    }
    if (a.startsWith("--port=")) {
      const raw = a.slice("--port=".length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new UsageError(
          `invalid --port value: ${JSON.stringify(raw)} (must be 1..65535)`,
        );
      }
      opts.port = n;
      i++;
      continue;
    }
    throw new UsageError(`unknown argument: ${a}`);
  }

  return opts;
}

// ── Scaffold logic ────────────────────────────────────────────────────────

/**
 * Run the init command. Returns the list of files written (absolute
 * paths). Throws UsageError on bad args / known-bad inputs.
 *
 * @param {{recipe: string|null, out: string|null, port: number|null, force: boolean, help: boolean}} opts
 * @param {{recipesRoot?: string, log?: (s: string) => void}} [runOpts]
 * @returns {string[]}
 */
export function runInit(opts, runOpts = {}) {
  const log = runOpts.log ?? ((s) => console.log(s));

  const recipesRoot = runOpts.recipesRoot ?? findRecipesRoot(HERE);
  if (!recipesRoot) {
    throw new UsageError(
      "could not locate the recipes/ directory — run this CLI from inside the cloister repo, or pass an explicit recipesRoot",
    );
  }

  const known = listRecipes(recipesRoot);

  if (!opts.recipe) {
    throw new UsageError(
      `--recipe is required. Known recipes: ${known.join(", ") || "(none found)"}`,
    );
  }
  if (!known.includes(opts.recipe)) {
    throw new UsageError(
      `unknown recipe: ${JSON.stringify(opts.recipe)}. Known: ${known.join(", ")}`,
    );
  }
  if (!opts.out) {
    throw new UsageError("--out is required (target directory)");
  }

  const outDir = resolve(opts.out);
  const srcDir = join(recipesRoot, opts.recipe);

  // Refuse to clobber an existing non-empty directory unless --force.
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (entries.length > 0 && !opts.force) {
      throw new UsageError(
        `--out target exists and is not empty: ${outDir} (pass --force to overwrite)`,
      );
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  // Copy + optionally template the recipe files.
  const written = [];
  for (const filename of RECIPE_FILES) {
    const src = join(srcDir, filename);
    if (!existsSync(src)) {
      // README.md is the only file we permit to be missing; everything
      // else in RECIPE_FILES is mandatory. cluster.toml is the post
      // ADR-0031-Phase-3 operator surface and is required for every
      // recipe in the cloister-6b572a shape.
      if (filename === "README.md") continue;
      throw new UsageError(
        `recipe ${opts.recipe} is missing required file: ${filename}`,
      );
    }
    let body = readFileSync(src, "utf8");
    if (opts.port !== null) {
      body = applyPortSubstitution(body, opts.port, filename);
    }
    const dst = join(outDir, filename);
    writeFileSync(dst, body);
    written.push(dst);
  }

  // Print next-steps banner.
  log("");
  log(`Scaffolded recipe ${JSON.stringify(opts.recipe)} into ${outDir}`);
  log("Files written:");
  for (const f of written) log(`  - ${basename(f)}`);
  log("");
  log("Next steps:");
  log(`  cd ${outDir}`);
  log("  task dev:bootstrap   # one-time vault KEK + .env.local");
  log(
    opts.port !== null
      ? `  task dev             # wrangler dev on :${opts.port}`
      : "  task dev             # wrangler dev on :8787",
  );

  return written;
}

/**
 * Replace the default port (8787) wherever it appears in `body`.
 *
 * We don't try a full structural rewrite; the recipes only mention
 * :8787 in cluster.compose.yaml. Plain string replace is correct
 * here — if a recipe grows new port references that shouldn't be
 * remapped, exempt them by writing a non-8787 sentinel in the recipe.
 *
 * @param {string} body
 * @param {number} port
 * @param {string} filename
 * @returns {string}
 */
export function applyPortSubstitution(body, port, filename) {
  if (port === 8787) return body;
  if (filename === "cluster.compose.yaml") {
    // Replace `"8787:8787"` → `"<port>:8787"` (host port only — the
    // container's listening port stays 8787 because that's what the
    // image binds inside).
    return body.replaceAll('"8787:8787"', `"${port}:8787"`);
  }
  // For other files, leave the body alone — recipes don't currently
  // hard-code a port in cloister.capnp. READMEs mention 8787
  // prosaically; leaving them is fine.
  return body;
}

// ── Help text ─────────────────────────────────────────────────────────────

/**
 * @param {(s: string) => void} log
 * @param {string | null} recipesRoot
 */
function printHelp(log, recipesRoot) {
  log("Usage: cloister init --recipe <name> --out <dir> [--port N] [--force]");
  log("");
  log("Scaffold a known-good starter cluster from a curated recipe.");
  log("");
  log("Options:");
  log("  -r, --recipe <name>   Recipe name (required)");
  log("  -o, --out <dir>       Output directory (required; must not exist or be empty)");
  log("  -p, --port <N>        Override the gateway host port (default 8787)");
  log("      --force           Overwrite an existing non-empty --out");
  log("  -h, --help            Show this help");
  log("");
  if (recipesRoot) {
    const recipes = listRecipes(recipesRoot);
    log("Known recipes:");
    if (recipes.length === 0) {
      log("  (none — recipes/ is empty)");
    } else {
      for (const r of recipes) log(`  - ${r}`);
    }
  } else {
    log("(no recipes/ directory located)");
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────

/**
 * Accepts either:
 *   - `init --recipe X --out Y ...` (proper subcommand form), or
 *   - `--recipe X --out Y ...`      (legacy bare form, for `node scripts/cli-init.mjs`).
 *
 * Only one subcommand exists today (`init`). When future subcommands
 * land (`add`, `scaffold`, etc.) extend the dispatch below.
 *
 * @param {readonly string[]} argv
 * @returns {number}
 */
export function main(argv) {
  // Top-level --help / -h.
  if (argv[0] === "--help" || argv[0] === "-h") {
    const recipesRoot = findRecipesRoot(HERE);
    printHelp((s) => console.log(s), recipesRoot);
    return 0;
  }

  // Strip an `init` subcommand if present; flag-only invocations still
  // route to runInit.
  const rest = argv[0] === "init" ? argv.slice(1) : argv;

  let opts;
  try {
    opts = parseArgs(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }

  if (opts.help) {
    const recipesRoot = findRecipesRoot(HERE);
    printHelp((s) => console.log(s), recipesRoot);
    return 0;
  }

  try {
    runInit(opts);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

// Run when invoked directly (handles both `node cli-init.mjs` and import).
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] &&
      fileURLToPath(import.meta.url) === resolve(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // Drop `node` + script path; pass the rest to main.
  process.exit(main(process.argv.slice(2)));
}
