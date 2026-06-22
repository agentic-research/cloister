#!/usr/bin/env node
// scripts/lint-vault-id-source.mjs
//
// Forward-guard lint for cloister-93b0c2 (C6 of adversarial cycle
// 2026-06-22 / threat-model §13.7.3): vault DO ids MUST be derived via
// `idFromName(bundleIdName)` per ADR-0021, NEVER via `.newUniqueId()`.
//
// ── Why this lint exists ─────────────────────────────────────────────────
//
// `src/vault-store.ts:632` reads
//
//     const tenantName = this.ctx.id.name ?? "cluster";
//
// inside `#resolveKekSource` (the tenant-scoped KEK derivation under
// `VAULT_KEK_TENANT_SCOPED=1`). The `?? "cluster"` fallback exists for
// the legitimate dev-path where `ctx.id.name` is absent — the DO was
// constructed via the default `idFromName("cluster")` substrate seam.
//
// But `DurableObjectNamespace.newUniqueId()` produces ids with NO name
// — `id.name` is `undefined` for every unique id. If a vault caller ever
// drifts to `env.VAULT_STORE.newUniqueId()`, EVERY such DO instance
// silently collapses to the same `"cluster"` tenant name, which means
// every per-instance vault KEK derives identically to the cluster
// fallback KEK. Cross-tenant isolation is lost, and there's no log
// signal because the fallback is the legitimate dev path.
//
// The threat is "no current code does this, but a future refactor
// could." That's exactly what a forward-guard lint is for. Per
// cloister-93b0c2 (P3) — defensive, not closing a live bug.
//
// ── What this lint checks ────────────────────────────────────────────────
//
// Walks a fixed set of vault-touching source files (the directories where
// vault DO bindings get dereferenced) and rejects any literal
// `.newUniqueId(` call. The legitimate id-source for vault is
// `idFromName(...)` exclusively.
//
// Non-vault DOs (BeadStore, TrustStore, BlobStore) may legitimately use
// `newUniqueId` for other purposes; those files are out of scope.
//
// ── Failure mode (intentional) ───────────────────────────────────────────
//
// The lint is a literal string match — no AST parse. If a future
// refactor renames `newUniqueId` (workerd API change), the lint will
// silently pass against the new name. The protection is best-effort
// against incremental drift, not adversarial obfuscation. If you're
// running this lint, you're inside the trust boundary; the threat is
// a hurried `git grep` -driven addition that misses the invariant,
// not a malicious commit.
//
// ── Wire ─────────────────────────────────────────────────────────────────
//
// Exit 0 — no `.newUniqueId(` found in any monitored file.
// Exit 1 — at least one violation (paths + line numbers on stderr).
// Exit 2 — toolchain failure (a monitored file is missing, etc.).
//
// Env:
//   VAULT_ID_SOURCE_FILES — colon-separated override list of files to scan,
//                           used by the test harness to point at synthesized
//                           fixtures. Defaults to the embedded MONITORED list.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = process.cwd();

/**
 * Files where vault DO ids are derived. Add new vault-binding-dereferencing
 * files here as they land. Globs intentionally avoided — explicit list is
 * the audit surface.
 */
const MONITORED = [
  "src/vault-store.ts",
  "src/routes/vault-do-credential-store.ts",
  "src/routes/vault-proxy.ts",
  "src/routes/vault-proxy-credential-store.ts",
];

function resolveTargets() {
  const env = process.env.VAULT_ID_SOURCE_FILES;
  if (env && env.trim().length > 0) {
    return env.split(":").map((p) => resolve(REPO, p));
  }
  return MONITORED.map((p) => resolve(REPO, p));
}

/**
 * Match `.newUniqueId(` with optional whitespace before the paren.
 * Capture-free: we only need the line number for the report.
 */
const VIOLATION_RE = /\.newUniqueId\s*\(/g;

function scanFile(absPath) {
  if (!existsSync(absPath)) {
    throw new Error(`monitored file not found: ${absPath}`);
  }
  const src = readFileSync(absPath, "utf8");
  const lines = src.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines that are clearly comments — single-line `//` only;
    // block comments (`/* ... */`) are not stripped because a literal
    // `.newUniqueId(` inside a block-comment example would be rare AND
    // worth flagging anyway (docs lie if they reference a forbidden
    // call as if it were normal).
    if (line.trimStart().startsWith("//")) continue;
    VIOLATION_RE.lastIndex = 0;
    if (VIOLATION_RE.test(line)) {
      hits.push({ line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

// ── Run ──────────────────────────────────────────────────────────────────

const targets = resolveTargets();
const violations = [];

try {
  for (const file of targets) {
    const hits = scanFile(file);
    for (const h of hits) {
      violations.push({ file, ...h });
    }
  }
} catch (e) {
  console.error(`lint-vault-id-source: ${e.message}`);
  process.exit(2);
}

if (violations.length > 0) {
  console.error(`\n✗ lint-vault-id-source: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const rel = v.file.startsWith(REPO + "/") ? v.file.slice(REPO.length + 1) : v.file;
    console.error(`  ${rel}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error("");
  console.error("Vault DO ids MUST be derived via `idFromName(bundleIdName)` per ADR-0021.");
  console.error("`.newUniqueId()` produces a nameless id, which silently collapses");
  console.error("the per-tenant KEK to the \"cluster\" fallback (vault-store.ts:632) —");
  console.error("cross-tenant isolation is lost with no log signal.");
  console.error("");
  console.error("See cloister-93b0c2 + threat-model §13.7.3.");
  process.exit(1);
}

console.log(`lint-vault-id-source: clean ✓ (${targets.length} file(s) scanned)`);
