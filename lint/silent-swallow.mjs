// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:silent-swallow — cloister-bd7210 Phase 2 rail.
//
// A bare `catch {` (no error binding) that returns a silent default
// (null/false/undefined) *discards the error entirely* — you can't tell "notme
// is down" from "notme is misconfigured" from "the bytes were malformed". That
// exact pattern turned a two-line key mismatch into a P2 debugging nightmare
// (cloister-3ad090: notmeBundleFetcher's bare `catch { return null }`).
//
// But many silent returns are legitimate — a verify PREDICATE returning
// `false`/`null` on bad input IS its contract. So the gate is not "never return
// a default"; it is "never DISCARD the error silently WITHOUT saying why". Each
// such site must either surface the error (log it / return a typed error /
// rethrow) or carry an inline `lint-allow-silent: <reason>` justification.
//
// Scope: the trust/IO surface (storage, wire, routes) — where losing the error
// has security or debuggability cost. The allowlist-by-annotation is
// edit-stable (unlike line numbers) and self-documenting: the reason lives
// next to the code. This is the repeatable half of the audit; the reasons
// collected here are also the raw material for the logging story (bd7e51).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCAN_DIRS = ["src/storage", "src/wire", "src/routes"].map((d) => resolve(REPO_ROOT, d));

const SILENT_RETURNS = ["return null", "return false", "return undefined"];
// A block "surfaces" the error (not a silent discard) if it does any of these.
const SURFACES = ["console.", "throw", "lint-allow-silent", "logger", "log("];

function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listTsFiles(abs));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/**
 * Extract the body text of the `catch { … }` block starting at line index
 * `startIdx` (which contains a bare `catch {`), by brace-counting. Returns the
 * joined body lines. Pure helper.
 */
function catchBlockBody(lines, startIdx) {
  let depth = 0;
  let started = false;
  const body = [];
  for (let i = startIdx; i < lines.length; i++) {
    // On the first line, count braces starting AT the catch's own `{` — ignore
    // the try's closing `}` that may precede `catch {` on the same line (a
    // `} catch {` line would otherwise net to zero and terminate immediately).
    let countFrom = lines[i];
    if (i === startIdx) {
      const ci = lines[i].indexOf("catch {");
      if (ci >= 0) countFrom = lines[i].slice(ci);
    }
    for (const ch of countFrom) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; }
    }
    body.push(lines[i]); // push the full line for content matching
    if (started && depth <= 0) break;
  }
  return body.join("\n");
}

/**
 * Find silent-swallow violations in one file's text. A violation is a bare
 * `catch {` (no error binding) whose block returns a silent default and does
 * NOT surface the error or carry a `lint-allow-silent:` justification. Pure —
 * exported for tests. `rel` is the repo-relative POSIX path (for messages).
 */
export function findSilentSwallows(rel, text) {
  const violations = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Bare catch with no binding: `catch {` (not `catch (e) {`).
    const trimmed = lines[i].trimStart();
    const isBareCatch = trimmed.startsWith("catch {") || trimmed.startsWith("} catch {");
    if (!isBareCatch) continue;
    const body = catchBlockBody(lines, i);
    const silent = SILENT_RETURNS.some((r) => body.includes(r));
    if (!silent) continue;
    const surfaced = SURFACES.some((s) => body.includes(s));
    if (surfaced) continue;
    violations.push({ rel, line: i + 1 });
  }
  return violations;
}

/** Walk the trust/IO surface and collect violations. */
export function collectSilentSwallows() {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of listTsFiles(dir)) {
      const rel = relative(REPO_ROOT, abs).split("\\").join("/");
      violations.push(...findSilentSwallows(rel, readFileSync(abs, "utf8")));
    }
  }
  return violations;
}

// ── CLI ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = collectSilentSwallows();
  if (violations.length > 0) {
    console.error("lint-silent-swallow: FAIL — a bare `catch {}` silently discards an error (cloister-bd7210):");
    for (const v of violations) console.error(`  ✘ ${v.rel}:${v.line}`);
    console.error("\n  Each must SURFACE the error — log it, return a typed error, or rethrow —");
    console.error("  or carry an inline `lint-allow-silent: <reason>` when the silent default is");
    console.error("  the contract (e.g. a verify predicate). A discarded error is the cloister-3ad090");
    console.error("  class: you lose the difference between down / misconfigured / malformed.");
    process.exit(1);
  }
  console.log("lint-silent-swallow: OK — no unjustified silent error-discards on the trust/IO surface.");
}
