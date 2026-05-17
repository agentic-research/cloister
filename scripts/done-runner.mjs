#!/usr/bin/env node
/**
 * scripts/done-runner.mjs — `task done` gate runner (cloister-0d5e0f).
 *
 * Loads drop-in JSON rule files from `DONE_RULES_DIR` (default
 * `<repo>/done-rules/`), runs each as a shell command, and reports
 * pass / warn / block. Exit code = 0 if no block-severity failures;
 * 1 if any block; 2 on toolchain errors (malformed rule, JSON parse
 * error). Mirrors mache's external smell-rules shape — adding a
 * gate is one drop-in file, no runner edits needed.
 *
 * Rule file shape (one rule per file):
 *
 *   {
 *     "id":          "lint-passes",
 *     "description": "task lint exits 0",
 *     "severity":    "block",      // "block" (default) or "warn"
 *     "run":         "task lint"   // shell command; exit 0 = pass
 *   }
 *
 * The `id` is required + must be unique across the rules dir. The
 * `run` field is required. `severity` defaults to `"block"`
 * (fail-secure: an unannotated rule blocks shipment). `description`
 * is optional but recommended (surfaces in the per-rule output).
 *
 * Rules execute in sorted-id order so output is deterministic for
 * review. Non-`.json` files in the rules dir are ignored.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_RULES_DIR = resolve(REPO_ROOT, "done-rules");
const RULES_DIR = process.env.DONE_RULES_DIR ?? DEFAULT_RULES_DIR;

// ── Load + validate rules ────────────────────────────────────────────────

function loadRules(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort();
  return files.map((name) => loadRuleFile(resolve(dir, name), name));
}

function loadRuleFile(path, name) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ToolchainError(`cannot read rule file ${name}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ToolchainError(`rule file ${name}: JSON parse error: ${e.message}`);
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new ToolchainError(`rule file ${name}: missing required string field 'id'`);
  }
  if (typeof parsed.run !== "string" || parsed.run.length === 0) {
    throw new ToolchainError(`rule file ${name}: missing required string field 'run'`);
  }
  if (parsed.severity !== undefined && parsed.severity !== "block" && parsed.severity !== "warn") {
    throw new ToolchainError(
      `rule file ${name}: severity must be "block" or "warn" (got ${JSON.stringify(parsed.severity)})`,
    );
  }
  return {
    id:          parsed.id,
    description: parsed.description ?? "",
    severity:    parsed.severity ?? "block",      // fail-secure default
    run:         parsed.run,
    _file:       name,
  };
}

class ToolchainError extends Error {}

// ── Execute a single rule ────────────────────────────────────────────────

function runRule(rule) {
  const r = spawnSync("sh", ["-c", rule.run], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Inherit env so rules can read existing context (PATH, CLOISTER_*).
    env: process.env,
  });
  // spawnSync sets status=null when killed by signal; treat as failure.
  const exitCode = r.status === null ? -1 : r.status;
  return {
    ...rule,
    passed:   exitCode === 0,
    exitCode,
    stdout:   r.stdout ?? "",
    stderr:   r.stderr ?? "",
    signal:   r.signal ?? null,
  };
}

// ── Report ───────────────────────────────────────────────────────────────

function reportResults(results) {
  const passes = results.filter((r) => r.passed);
  const blocks = results.filter((r) => !r.passed && r.severity === "block");
  const warns  = results.filter((r) => !r.passed && r.severity === "warn");

  for (const r of results) {
    const icon = r.passed
      ? "✓"
      : r.severity === "warn"
        ? "⚠"
        : "✗";
    const desc = r.description ? ` — ${r.description}` : "";
    console.log(`  ${icon} ${r.id}${desc}`);
    if (!r.passed) {
      const why = r.signal
        ? `signal=${r.signal}`
        : `exit=${r.exitCode}`;
      const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join("\n      ");
      if (tail) {
        console.log(`      [${why}] ${tail}`);
      } else {
        console.log(`      [${why}]`);
      }
    }
  }
  console.log("");
  console.log(`task done: ${passes.length} pass, ${warns.length} warn, ${blocks.length} block`);

  if (blocks.length > 0) {
    console.error("");
    console.error("FAIL — blocking rule(s):");
    for (const b of blocks) console.error(`  - ${b.id}${b.description ? ": " + b.description : ""}`);
  }

  return { passes, warns, blocks };
}

// ── CLI entry ────────────────────────────────────────────────────────────

let rules;
try {
  rules = loadRules(RULES_DIR);
} catch (e) {
  if (e instanceof ToolchainError) {
    console.error(`done-runner: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

console.log(`task done: ${rules.length} rule(s) loaded from ${RULES_DIR}`);

const results = rules.map(runRule);
const { blocks } = reportResults(results);

process.exit(blocks.length > 0 ? 1 : 0);
