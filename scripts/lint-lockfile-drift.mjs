#!/usr/bin/env node
// scripts/lint-lockfile-drift.mjs
//
// Drift gate for cluster.lock.toml — asserts the committed sha256 for
// each `file://`-resourced input still matches the bytes on disk. The
// 2026-06-24 LLO-contract incident motivated this: cluster.lock.toml
// was pinned to an older LLO `server.json` (bytes=1_213, 3 groups)
// while the actual on-disk server.json had advanced to 2603 bytes
// (7 groups). Cloister silently kept advertising the smaller claim
// set — the `query` group's 16 nodes-related tools (`get_node`,
// `inspect_symbol`, `find_callers`, `read_content`, …) were missing
// from `src/generated/manifest.ts` until an operator noticed and
// ran `task cluster:resolve` by hand.
//
// This gate catches that class of drift mechanically.
//
// ── Scope ────────────────────────────────────────────────────────────────
//
// Only checks `from = "file://…"` inputs. http(s)://, github://, and
// io.github.org/ inputs are intentionally OUT of scope: re-fetching
// them on every `task lint` would either (a) hit the network on each
// inner-loop run or (b) require a local cache that wouldn't catch
// upstream drift anyway. The committed digest is enough for them —
// content-addressed pinning by design.
//
// Adding an https:// drift check is a separate decision (probably
// driven by ADR-0026 Phase 3 + Interlace receipt verification, not
// by this gate).
//
// ── Exit codes ───────────────────────────────────────────────────────────
//
//   0 — every file:// input's digest matches the lockfile
//   1 — drift; per-input mismatch on stderr with fix suggestion
//   2 — toolchain error (cluster.toml unreadable, lockfile missing, …)
//
// ── Run ──────────────────────────────────────────────────────────────────
//
//   pnpm exec tsx scripts/lint-lockfile-drift.mjs

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@iarna/toml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

// Env overrides used by scripts/test/lint-lockfile-drift.test.mjs to
// point the lint at a synthesized cluster.toml + lockfile pair inside
// a tmpdir, without mutating the real repo files. Production callers
// (task lint:lockfile-drift) leave both env vars unset.
const CLUSTER_TOML  = process.env.LINT_LOCKFILE_CLUSTER_TOML  ?? resolvePath(REPO_ROOT, "cluster.toml");
const LOCKFILE_TOML = process.env.LINT_LOCKFILE_LOCKFILE_TOML ?? resolvePath(REPO_ROOT, "cluster.lock.toml");

function readToml(path) {
  if (!existsSync(path)) {
    console.error(`lint-lockfile-drift: missing ${path}`);
    process.exit(2);
  }
  try {
    return parseToml(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`lint-lockfile-drift: failed to parse ${path}: ${e.message}`);
    process.exit(2);
  }
}

function fileUrlToPath(url) {
  if (url.startsWith("file:///")) return "/" + url.slice("file:///".length);
  if (url.startsWith("file://"))  return url.slice("file://".length);
  return null;
}

function main() {
  const cluster = readToml(CLUSTER_TOML);
  const lock    = readToml(LOCKFILE_TOML);

  const inputs = cluster.inputs ?? {};
  const locked = lock.inputs    ?? {};

  const mismatches = [];
  let checked = 0;

  for (const [name, spec] of Object.entries(inputs)) {
    const from = spec?.from;
    if (typeof from !== "string" || !from.startsWith("file://")) continue;

    const lockedRow = locked[name];
    if (!lockedRow || typeof lockedRow.sha256 !== "string") {
      mismatches.push({
        name,
        reason: `present in cluster.toml but missing from cluster.lock.toml`,
        fix:    `run \`task cluster:resolve\``,
      });
      continue;
    }

    const path = fileUrlToPath(from);
    if (!path || !existsSync(path)) {
      mismatches.push({
        name,
        reason: `cluster.toml from = ${from} but path does not exist`,
        fix:    `fix the from= path or remove the input`,
      });
      continue;
    }

    const bytes  = readFileSync(path);
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    checked += 1;

    if (actual !== lockedRow.sha256) {
      mismatches.push({
        name,
        reason: `lockfile sha256 ${lockedRow.sha256.slice(0, 19)}… ≠ source sha256 ${actual.slice(0, 19)}…`,
        fix:    `run \`task cluster:resolve\` to re-pin (then \`task manifest\` + commit)`,
      });
    }
  }

  if (mismatches.length > 0) {
    console.error(`lint-lockfile-drift: ${mismatches.length} drift(s) detected`);
    for (const m of mismatches) {
      console.error(`  ✘ ${m.name}: ${m.reason}`);
      console.error(`      fix: ${m.fix}`);
    }
    process.exit(1);
  }

  console.log(`lint-lockfile-drift: ok — ${checked} file:// input(s) verified`);
}

main();
