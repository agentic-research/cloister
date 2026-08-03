// SPDX-License-Identifier: AGPL-3.0-or-later
//
// First-party local-development config loading and preflight.
// footgun.
//
// The observed bug (cloister-d2db6d): the local router sources `.env.local` into the
// process environment, but when `.dev.vars` also exists, `wrangler dev` reads
// its own vars and IGNORES the ambient process env. So an `INTERLACE_ROOT_PUBKEY`
// set in `.env.local` becomes invisible to the Worker, and `wrangler.toml`'s
// `= ""` default wins — silently turning the lease gate OFF. Config resolved to
// DIFFERENT values depending on which files were present, with no warning.
//
// This models that exact resolution and fails loudly on two conditions, for the
// `wrangler dev` path (`cloister dev serve` / `cloister run`):
//
//   SHADOWED — `.env.local` sets a non-empty value, `.dev.vars` exists but does
//     NOT set the key, and `wrangler.toml [vars]` provides no non-empty value.
//     The `.env.local` value is silently dropped. This is the gate-off bug.
//
//   CONFLICT — both `.env.local` and `.dev.vars` set the key to DIFFERENT
//     values. `.dev.vars` wins; which one is authoritative is ambiguous. That
//     dup/override is the smell 21f273 targets: each binding wants ONE owner.
//
// Values are NEVER printed — several of these keys are secrets (KEK, seed) and
// the rest (pubkeys) are still config the operator can look up themselves. The
// report names the KEY, the condition, and the fix.
//
// CI-safe: `.env.local` / `.dev.vars` are gitignored and absent in CI, so the
// check is a clean no-op there. Its enforcement point is the developer's local
// local-router preflight, which is exactly where the footgun bites.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

export class ConfigSourceError extends Error {}

/** @typedef {{existsSync?: (path:string) => boolean, readFileSync?: (path:string, encoding:string) => string}} ConfigIo */

/**
 * Parse a dotenv-style file (`.env.local`, `.dev.vars`) into a key→value Map.
 * `KEY=value` or `KEY = value`; blank lines and `#` comment lines are skipped;
 * a surrounding pair of matching quotes is stripped. Inline trailing comments
 * are NOT stripped — a secret value may legitimately contain `#`. Pure;
 * exported for tests.
 */
/** @param {string} text @returns {Map<string,string>} */
export function parseDotenv(text) {
  const out = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    out.set(key, stripQuotes(line.slice(eq + 1).trim()));
  }
  return out;
}

/**
 * Parse the `[vars]` table of a `wrangler.toml` into a key→value Map. Only that
 * one table is read (bindings elsewhere are structural, not value config).
 * Handles quoted values and a trailing `# comment` after a bareword value.
 * Pure; exported for tests.
 */
/** @param {string} text @returns {Map<string,string>} */
export function parseWranglerVars(text) {
  const out = new Map();
  const lines = text.split("\n");
  let inVars = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inVars = line === "[vars]";
      continue;
    }
    if (!inVars || line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    out.set(key, parseTomlValue(line.slice(eq + 1).trim()));
  }
  return out;
}

/** @param {string} v */
function stripQuotes(v) {
  if (v.length >= 2) {
    const first = v[0];
    if ((first === '"' || first === "'") && v[v.length - 1] === first) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** @param {string} rhs */
function parseTomlValue(rhs) {
  if (rhs.startsWith('"')) {
    const close = rhs.indexOf('"', 1);
    return close > 0 ? rhs.slice(1, close) : "";
  }
  // Bareword — cut a trailing comment, then trim.
  const hash = rhs.indexOf("#");
  return (hash >= 0 ? rhs.slice(0, hash) : rhs).trim();
}

/**
 * The value a key resolves to under `wrangler dev` when `.dev.vars` is present:
 * `.dev.vars` wins, then `wrangler.toml [vars]`. The ambient process env (where
 * `.env.local` lives after the local router loads it) is NOT consulted — that is the
 * shadow. Returns undefined if neither source defines the key.
 */
/** @param {string} key @param {Map<string,string>} devVars @param {Map<string,string>} wranglerVars */
export function wranglerDevEffective(key, devVars, wranglerVars) {
  if (devVars.has(key)) return devVars.get(key);
  return wranglerVars.get(key);
}

/**
 * Given the three parsed sources, find SHADOWED + CONFLICT issues for the
 * `wrangler dev` path. Only meaningful when `.dev.vars` exists (otherwise the
 * process env flows through and nothing is shadowed). Pure; exported for tests.
 * Returns `{ key, kind }[]` — `kind` is "shadowed" or "conflict". No values.
 *
 * Dev-mode awareness: a `.dev.vars` that declares `CLOISTER_MODE=dev` (the
 * ADR-0042 harness flow) intentionally REPLACES the prod/`.env.local` config
 * surface with dev seams (DEV_CA_MASTER supersedes INTERLACE_ROOT_PUBKEY,
 * DEV_VAULT_SEED supersedes VAULT_KEK_SOURCE). Shadowing there is by design, so
 * SHADOWED is suppressed under dev mode. A CONFLICT — the SAME key set to two
 * DIFFERENT values in both files — is always ambiguous ownership and is flagged
 * regardless of mode.
 */
/**
 * @param {{envLocal:Map<string,string>, devVars:Map<string,string>,
 *          wranglerVars:Map<string,string>, devVarsExists:boolean}} sources
 * @returns {{key:string, kind:"shadowed"|"conflict"}[]}
 */
export function findConfigSourceIssues({ envLocal, devVars, wranglerVars, devVarsExists }) {
  if (!devVarsExists) return [];
  const devMode = devVars.get("CLOISTER_MODE") === "dev";
  /** @type {{key:string, kind:"shadowed"|"conflict"}[]} */
  const issues = [];
  for (const [key, value] of envLocal) {
    if (value === "") continue; // an empty .env.local value isn't a lost secret
    if (devVars.has(key)) {
      if (devVars.get(key) !== value) issues.push({ key, kind: "conflict" });
      continue;
    }
    if (devMode) continue; // dev seams intentionally supersede the .env.local surface
    const effective = wranglerDevEffective(key, devVars, wranglerVars);
    if (effective === undefined || effective === "") issues.push({ key, kind: "shadowed" });
  }
  issues.sort((a, b) => a.key.localeCompare(b.key));
  return issues;
}

/** Read the repo's config sources and collect issues. Skips absent files. */
/** @param {string|URL} [rootDir] @param {ConfigIo} [io] */
export function collectConfigSourceIssues(rootDir = REPO_ROOT, io = {}) {
  const exists = io.existsSync ?? existsSync;
  const read = io.readFileSync ?? readFileSync;
  const root = rootDir instanceof URL ? fileURLToPath(rootDir) : rootDir;
  const envLocalPath = resolve(root, ".env.local");
  if (!exists(envLocalPath)) return []; // nothing sourced → nothing to shadow
  const devVarsPath = resolve(root, ".dev.vars");
  const wranglerPath = resolve(root, "wrangler.toml");
  const devVarsExists = exists(devVarsPath);
  return findConfigSourceIssues({
    envLocal: parseDotenv(read(envLocalPath, "utf8")),
    devVars: devVarsExists ? parseDotenv(read(devVarsPath, "utf8")) : new Map(),
    wranglerVars: exists(wranglerPath) ? parseWranglerVars(read(wranglerPath, "utf8")) : new Map(),
    devVarsExists,
  });
}

/** Load .env.local into a COPY of the supplied environment. */
/**
 * @param {string|URL} [rootDir]
 * @param {Record<string,string|undefined>} [baseEnv]
 * @param {ConfigIo} [io]
 */
export function loadLocalEnv(rootDir = REPO_ROOT, baseEnv = process.env, io = {}) {
  const exists = io.existsSync ?? existsSync;
  const read = io.readFileSync ?? readFileSync;
  const root = rootDir instanceof URL ? fileURLToPath(rootDir) : rootDir;
  const file = resolve(root, ".env.local");
  const env = { ...baseEnv };
  if (!exists(file)) return env;
  for (const [key, value] of parseDotenv(read(file, "utf8"))) env[key] = value;
  return env;
}

/** @param {{key:string, kind:"shadowed"|"conflict"}[]} issues */
function issueReport(issues) {
  const lines = [
    "config-source override problem on the `wrangler dev` path (cloister-21f273):",
  ];
  for (const { key, kind } of issues) {
    if (kind === "shadowed") {
      lines.push(
        `  ${key} — SHADOWED: .dev.vars exists, so wrangler ignores the value from .env.local.`,
        `  Fix: declare ${key} in .dev.vars, or remove .dev.vars for the plain \`cloister dev serve\` flow.`,
      );
    } else {
      lines.push(
        `  ${key} — CONFLICT: .env.local and .dev.vars set different values.`,
        `  Fix: give ${key} one owner: .dev.vars or .env.local, not both.`,
      );
    }
  }
  lines.push("Values are intentionally omitted; configuration output must not reveal secrets.");
  return lines.join("\n");
}

/** @param {string|URL} [rootDir] @param {ConfigIo} [io] */
export function assertConfigSourcesSafe(rootDir = REPO_ROOT, io = {}) {
  const issues = collectConfigSourceIssues(rootDir, io);
  if (issues.length > 0) throw new ConfigSourceError(issueReport(issues));
  return issues;
}

/**
 * @param {string[]} [_argv]
 * @param {{log?:(line:string)=>void, errLog?:(line:string)=>void,
 *          root?:string|URL, io?:ConfigIo}} [deps]
 */
export function main(_argv = [], deps = {}) {
  const log = deps.log ?? console.log;
  const errLog = deps.errLog ?? console.error;
  const issues = collectConfigSourceIssues(deps.root ?? REPO_ROOT, deps.io ?? {});
  if (issues.length > 0) {
    errLog(`config:check: FAIL — ${issueReport(issues)}`);
    return 1;
  }
  log("config:check: OK — no config-source shadowing or override conflicts.");
  return 0;
}
