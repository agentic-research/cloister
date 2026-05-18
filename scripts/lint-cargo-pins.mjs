#!/usr/bin/env node
/**
 * scripts/lint-cargo-pins.mjs — assert security-sensitive Rust crate
 * pins keep the form ADR-0019 §"Implementation pins" requires.
 *
 * Why this exists (cloister-9bfbf6 + ADR-0019 §15.7):
 *
 *   The trust-anchor-helper signs with `ed25519-dalek 2.1.x`.
 *   Math-friend review of the helper protocol noted that 2.2.x
 *   (whenever it lands) could change constant-time semantics or add an
 *   algorithm-substitution surface the threat model doesn't yet
 *   account for. The defense is a TILDE pin (`~2.1`, semver
 *   `>=2.1.0, <2.2.0`), reviewed when 2.2 actually ships.
 *
 *   The risk this lint closes: cargo accepts CARET shorthand
 *   (`version = "2.1"` ≡ `^2.1` ≡ `>=2.1.0, <3.0.0`) and a friendly
 *   `cargo upgrade` would silently rewrite a tilde pin to caret.
 *   Without a lint, the regression lands as "well, all the tests
 *   still pass" — but the threat-model invariant is gone.
 *
 *   cargo-deny doesn't help here: it operates on RESOLVED versions
 *   (Cargo.lock), not on Cargo.toml version-spec STRINGS. The shape
 *   we care about (`~` vs `^` vs bare vs `*`) is purely syntactic —
 *   cargo's resolver erases it before deny sees it. So this lint
 *   parses the Cargo.toml string directly.
 *
 * Wire:
 *
 *   Exit 0 — every pin in PINNED_CRATES has the documented form.
 *   Exit 1 — at least one violation (caret, bare-2.x, wildcard, etc.).
 *   Exit 2 — toolchain error (Cargo.toml missing, parse failure).
 *
 * Env:
 *
 *   CARGO_PIN_FILE — override path to the Cargo.toml under lint.
 *                    Defaults to rs/crates/sign/Cargo.toml. Used by
 *                    tests + adopted if we ever want to lint a
 *                    different file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_PIN_FILE = resolve(REPO_ROOT, "rs/crates/sign/Cargo.toml");

/**
 * Crates this lint protects. Data over code: add an entry to extend
 * the set; no parser changes needed. `expectedVersion` is the EXACT
 * version-spec string the line must contain (with quotes).
 */
const PINNED_CRATES = [
  {
    name:            "ed25519-dalek",
    expectedVersion: '"~2.1"',
    rationale:
      "ADR-0019 §Implementation pins requires `~2.1` (tilde — allows " +
      "2.1.x patch but NOT 2.2.x). Caret `^2.1` or bare `2.1` would " +
      "auto-upgrade to 2.2.x — that's math-friend's alg-substitution " +
      "+ constant-time defense gone.",
  },
];

// ── Loader ────────────────────────────────────────────────────────────────

function loadCargoToml() {
  const path = process.env.CARGO_PIN_FILE ?? DEFAULT_PIN_FILE;
  if (!existsSync(path)) {
    throw new ToolchainError(`Cargo.toml not found at ${path}`);
  }
  try {
    return { path, content: readFileSync(path, "utf8") };
  } catch (e) {
    throw new ToolchainError(`cannot read ${path}: ${e.message}`);
  }
}

class ToolchainError extends Error {}

// ── Per-crate check ──────────────────────────────────────────────────────

/**
 * Find the dependency line for `crateName`. Matches both inline-table
 * form (`name = { version = "x", features = [...] }`) and plain-string
 * form (`name = "x"`).
 *
 * Returns the version-spec STRING (with surrounding quotes) or null
 * if not present.
 */
function extractVersionSpec(content, crateName) {
  const esc = crateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchored at start-of-line; `\s*=\s*` separator. The word boundary
  // after the escaped name avoids matching `ed25519-dalek-foo`.
  const linePattern = new RegExp(`^${esc}\\s*=\\s*(.*)$`, "m");
  const m = content.match(linePattern);
  if (!m) return null;
  const rhs = m[1].trim();
  if (rhs.startsWith("{")) {
    const vm = rhs.match(/version\s*=\s*("[^"]*")/);
    return vm ? vm[1] : null;
  }
  const sm = rhs.match(/^("[^"]*")/);
  return sm ? sm[1] : null;
}

function checkPin(content, pin) {
  const found = extractVersionSpec(content, pin.name);
  if (found === null) {
    return {
      ok:    false,
      name:  pin.name,
      found: null,
      msg:   `${pin.name} is not declared in the Cargo.toml under lint. ${pin.rationale}`,
    };
  }
  if (found !== pin.expectedVersion) {
    return {
      ok:    false,
      name:  pin.name,
      found,
      msg:
        `${pin.name} pin is ${found} but ADR-0019 requires ${pin.expectedVersion}. ` +
        pin.rationale,
    };
  }
  return { ok: true, name: pin.name, found };
}

// ── Run ──────────────────────────────────────────────────────────────────

let toml;
try {
  toml = loadCargoToml();
} catch (e) {
  if (e instanceof ToolchainError) {
    console.error(`lint-cargo-pins: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const results = PINNED_CRATES.map((p) => checkPin(toml.content, p));
const violations = results.filter((r) => !r.ok);

if (violations.length === 0) {
  console.log(`lint-cargo-pins: OK — ${results.length} pin(s) at expected form`);
  for (const r of results) console.log(`  ✓ ${r.name} = ${r.found}`);
  process.exit(0);
}

console.error(`lint-cargo-pins: ${violations.length} violation(s) in ${toml.path}`);
for (const v of violations) {
  console.error(`  ✗ ${v.name}`);
  if (v.found) console.error(`      found: ${v.found}`);
  console.error(`      ${v.msg}`);
}
process.exit(1);
