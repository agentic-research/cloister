// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:dev-escape — enforce the ADR-0026 rule that `manifest/cluster.capnp`
// already states in prose but nothing checked:
//
//   "Optional: dev-loop override pointing at a local checkout.
//    Format: file:///abs/path. CI rejects manifests with non-empty `from`
//    (per ADR-0026 §'Why filesystem from = ... is the dev-loop escape only')."
//
// The rule was documented and unenforced, so it drifted:
// `recipes/rosary-dev/cluster.toml` shipped
// `from = "file:///Users/<author>/remotes/art/ley-line-open/server.json"` — an
// absolute path from one machine, committed into a RECIPE that other people
// scaffold from via `task init --recipe`. It resolves for exactly one person on
// exactly one machine, and it leaks that machine's layout into the repo.
//
// `from` is the dev-loop escape hatch: it wins over `ref` (see
// scripts/resolve-inputs.mjs), so a committed `from` silently overrides the
// durable, content-addressed `ref` for everyone who checks the tree out. That is
// the same class as the empty-value footguns from cloister-21e42e: a value whose
// presence quietly changes resolution, with no signal.
//
// IMPORTANT — `from` is overloaded in cluster.toml, and a naive check is wrong:
//
//   [[wires]]
//   from = "cloister-router"        ← a BUNDLE NAME. Legitimate; 12 in-tree.
//
//   [inputs.llo]
//   from = "file:///abs/path"       ← the ADR-0026 dev escape. Never committed.
//
// So this rail is scoped to `[inputs.*]` sections only. Section tracking is a
// plain line scan (no regex, per the operator's standing rule).

import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Strip a matching pair of surrounding quotes, if present. */
function stripQuotes(v) {
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}

/**
 * Take the value of a TOML `key = value` right-hand side: the quoted string if
 * quoted, otherwise the bareword up to a trailing `#` comment.
 */
function tomlValue(rhs) {
  const t = rhs.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    const close = t.indexOf(q, 1);
    return close > 0 ? t.slice(1, close) : "";
  }
  const hash = t.indexOf("#");
  return (hash >= 0 ? t.slice(0, hash) : t).trim();
}

/**
 * Find committed dev-escape violations in one cluster.toml's text: a non-empty
 * `from` inside an `[inputs.*]` section. Pure — exported for tests. `rel` is the
 * repo-relative POSIX path (for messages).
 */
export function findDevEscapes(rel, text) {
  const violations = [];
  const lines = text.split("\n");
  let inInputsSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    // Section header. `[inputs.llo]` is in scope; `[[wires]]`, `[gateway]` etc.
    // are not. Note `[[inputs]]` (array-of-tables form) counts too.
    if (line.startsWith("[")) {
      inInputsSection = line.startsWith("[inputs.") || line.startsWith("[[inputs");
      continue;
    }
    if (!inInputsSection) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== "from") continue;
    const value = stripQuotes(tomlValue(line.slice(eq + 1)));
    if (value !== "") violations.push({ rel, line: i + 1, value });
  }
  return violations;
}

// Directories that are not repo source: build output, deps, and the libkrun
// spike's VM rootfs (which contains dangling symlinks — `stat` on those throws
// ENOENT, so the walk uses `lstat` and never follows a link out of the tree).
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "rootfs", ".task", "workspace"]);

/** Every cluster.toml in the tree (repo root + recipes/). */
function listClusterTomls(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = resolve(dir, name);
    let st;
    // lstat, not stat: a broken symlink must not abort the whole walk, and a
    // symlinked directory must not be recursed into.
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) listClusterTomls(abs, out);
    else if (name === "cluster.toml") out.push(abs);
  }
  return out;
}

/** Walk the committed cluster.toml surface and collect violations. */
export function collectDevEscapes(rootDir = REPO_ROOT) {
  const violations = [];
  for (const abs of listClusterTomls(rootDir)) {
    const rel = relative(rootDir, abs).split("\\").join("/");
    violations.push(...findDevEscapes(rel, readFileSync(abs, "utf8")));
  }
  return violations;
}

// ── CLI ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = collectDevEscapes();
  if (violations.length > 0) {
    console.error("lint-dev-escape: FAIL — a committed cluster.toml carries an [inputs.*] `from` dev-escape (ADR-0026):");
    for (const v of violations) {
      console.error(`  ✘ ${v.rel}:${v.line}  from = ${JSON.stringify(v.value)}`);
    }
    console.error("\n  `from` is the dev-loop escape hatch and WINS over `ref`, so committing it");
    console.error("  silently overrides the durable content-addressed ref for everyone who checks");
    console.error("  the tree out — and an absolute path resolves on exactly one machine.");
    console.error("  Fix: delete the `from` line (the `ref` already resolves), or keep it in a");
    console.error("  local uncommitted overlay. See manifest/cluster.capnp `from @4` + ADR-0026.");
    process.exit(1);
  }
  console.log("lint-dev-escape: OK — no committed [inputs.*] dev-escape overrides.");
}
