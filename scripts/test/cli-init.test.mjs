// scripts/test/cli-init.test.mjs
//
// Run with:  node --test scripts/test/cli-init.test.mjs
//
// Smoke tests for `cloister init --recipe <name>` (cloister-ca1dab).
// Runs the CLI for each shipped recipe, asserts the expected files
// land in the target, asserts port substitution flows into
// cluster.compose.yaml, and (when `capnp` is on PATH) `capnp eval`s
// the generated cloister.capnp to verify it parses.
//
// Lives under scripts/test/ (not test/) for the same reason the
// bundle-isolation tests do — vitest's pool-workers runner has no
// `node:child_process`, so it can't spawn the CLI. node --test does.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_SCRIPT = resolve(REPO_ROOT, "scripts/cli-init.mjs");
const RECIPES_DIR = resolve(REPO_ROOT, "recipes");

// ── Recipe discovery ──────────────────────────────────────────────────────

function discoverRecipes() {
  if (!existsSync(RECIPES_DIR)) return [];
  return readdirSync(RECIPES_DIR)
    .filter(
      (name) =>
        existsSync(join(RECIPES_DIR, name, "cloister.capnp")) &&
        existsSync(join(RECIPES_DIR, name, "cluster.compose.yaml")) &&
        // Phase 3 of ADR-0031 (cloister-6b572a) — cluster.toml is the
        // operator-readable surface that ships in every recipe alongside
        // the runtime cloister.capnp.
        existsSync(join(RECIPES_DIR, name, "cluster.toml")),
    )
    .sort();
}

const RECIPES = discoverRecipes();

// ── Harness ───────────────────────────────────────────────────────────────

function runCli(args, opts = {}) {
  return spawnSync("node", [CLI_SCRIPT, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
  });
}

function makeTmp(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Build a `capnp eval -I <root>` schema root by symlinking the real
 * manifest into a `<tmp>/cloister/manifest/` shape so the
 * `using Cloister = import "/cloister/manifest/cloister.capnp"` line
 * in each recipe resolves.
 */
function makeCapnpSchemaRoot() {
  const tmp = makeTmp("recipe-capnp-root");
  const cloisterDir = resolve(tmp.dir, "cloister");
  const manifestDir = resolve(cloisterDir, "manifest");
  mkdirSync(manifestDir, { recursive: true });
  symlinkSync(
    resolve(REPO_ROOT, "manifest", "cloister.capnp"),
    resolve(manifestDir, "cloister.capnp"),
  );
  return tmp;
}

function capnpAvailable() {
  const r = spawnSync("capnp", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

const CAPNP = capnpAvailable();

// ── Sanity: at least one recipe ships ─────────────────────────────────────

test("recipes/ ships at least one recipe", () => {
  assert.ok(RECIPES.length > 0, "no recipes found under recipes/");
});

// ── Help + error-path coverage ────────────────────────────────────────────

test("--help prints usage and exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /Usage: cloister init/);
  assert.match(r.stdout, /Known recipes:/);
});

test("`init` subcommand form is accepted (for `cloister init ...` via bin)", () => {
  const tmp = makeTmp("recipe-subcommand");
  try {
    const r = runCli(["init", "--recipe", RECIPES[0], "--out", tmp.dir, "--force"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(existsSync(resolve(tmp.dir, "cloister.capnp")));
  } finally {
    tmp.cleanup();
  }
});

test("missing --recipe exits 2", () => {
  const r = runCli(["--out", "/tmp/whatever-does-not-exist"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--recipe is required/);
});

test("unknown --recipe exits 2 with usage error", () => {
  const r = runCli(["--recipe", "bogus", "--out", "/tmp/whatever-does-not-exist"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown recipe/);
});

test("missing --out exits 2", () => {
  const r = runCli(["--recipe", RECIPES[0]]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out is required/);
});

test("--port out of range exits 2", () => {
  const r = runCli([
    "--recipe", RECIPES[0],
    "--out", "/tmp/whatever-does-not-exist",
    "--port", "99999",
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid --port/);
});

test("non-empty --out without --force exits 2", () => {
  const tmp = makeTmp("recipe-nonempty");
  writeFileSync(resolve(tmp.dir, "preexisting.txt"), "hello\n");
  try {
    const r = runCli(["--recipe", RECIPES[0], "--out", tmp.dir]);
    assert.equal(r.status, 2, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /not empty/);
  } finally {
    tmp.cleanup();
  }
});

test("--force overwrites an existing non-empty --out", () => {
  const tmp = makeTmp("recipe-force");
  writeFileSync(resolve(tmp.dir, "preexisting.txt"), "hello\n");
  try {
    const r = runCli([
      "--recipe", RECIPES[0],
      "--out", tmp.dir,
      "--force",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.ok(existsSync(resolve(tmp.dir, "cloister.capnp")));
    // Pre-existing file should still be there (we don't wipe).
    assert.ok(existsSync(resolve(tmp.dir, "preexisting.txt")));
  } finally {
    tmp.cleanup();
  }
});

// ── Per-recipe smoke ──────────────────────────────────────────────────────

for (const recipe of RECIPES) {
  test(`recipe ${recipe} — scaffolds expected files`, () => {
    const tmp = makeTmp(`recipe-${recipe}`);
    try {
      const r = runCli([
        "--recipe", recipe,
        "--out", tmp.dir,
        "--force", // tmp.dir is empty but --force is a no-op there
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.ok(
        existsSync(resolve(tmp.dir, "cluster.compose.yaml")),
        "missing cluster.compose.yaml",
      );
      assert.ok(
        existsSync(resolve(tmp.dir, "cloister.capnp")),
        "missing cloister.capnp",
      );
      assert.ok(
        existsSync(resolve(tmp.dir, "cluster.toml")),
        "missing cluster.toml (Phase 3 of ADR-0031, cloister-6b572a)",
      );
      assert.ok(
        existsSync(resolve(tmp.dir, "README.md")),
        "missing README.md",
      );

      // Sanity: cloister.capnp body contains a Gateway literal.
      const body = readFileSync(resolve(tmp.dir, "cloister.capnp"), "utf8");
      assert.match(body, /const gateway :Cloister\.Gateway/);

      // Sanity: cluster.toml body declares the metadata table (the
      // operator-readable surface entry point).
      const tomlBody = readFileSync(resolve(tmp.dir, "cluster.toml"), "utf8");
      assert.match(tomlBody, /\[metadata\]/);

      // Sanity: compose body declares cloister-router.
      const compose = readFileSync(resolve(tmp.dir, "cluster.compose.yaml"), "utf8");
      assert.match(compose, /cloister-router/);
    } finally {
      tmp.cleanup();
    }
  });

  test(`recipe ${recipe} — --port substitutes into cluster.compose.yaml`, () => {
    const tmp = makeTmp(`recipe-${recipe}-port`);
    try {
      const r = runCli([
        "--recipe", recipe,
        "--out", tmp.dir,
        "--port", "12345",
        "--force",
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const compose = readFileSync(
        resolve(tmp.dir, "cluster.compose.yaml"),
        "utf8",
      );
      // Host port should be 12345; container side stays 8787.
      assert.match(compose, /"12345:8787"/);
      assert.doesNotMatch(compose, /"8787:8787"/);
    } finally {
      tmp.cleanup();
    }
  });

  // capnp-eval check: gated on capnp binary availability so contributors
  // without capnp installed don't fail this test.
  if (CAPNP) {
    test(`recipe ${recipe} — generated cloister.capnp parses via capnp eval`, () => {
      const tmp = makeTmp(`recipe-${recipe}-eval-out`);
      const schemaRoot = makeCapnpSchemaRoot();
      try {
        const r = runCli([
          "--recipe", recipe,
          "--out", tmp.dir,
          "--force",
        ]);
        assert.equal(r.status, 0);

        const e = spawnSync(
          "capnp",
          [
            "eval",
            "-I", schemaRoot.dir,
            "--no-standard-import",
            resolve(tmp.dir, "cloister.capnp"),
            "gateway",
            "-o", "json",
          ],
          { encoding: "utf8" },
        );
        assert.equal(
          e.status,
          0,
          `capnp eval failed for recipe ${recipe}:\nstderr: ${e.stderr}\nstdout: ${e.stdout}`,
        );
        // The output must be a JSON-shaped Gateway literal.
        const parsed = JSON.parse(e.stdout);
        assert.equal(typeof parsed.metadata?.name, "string");
        assert.ok(Array.isArray(parsed.routes), "routes missing");
      } finally {
        tmp.cleanup();
        schemaRoot.cleanup();
      }
    });
  }
}
