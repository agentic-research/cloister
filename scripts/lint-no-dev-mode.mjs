// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:no-dev-mode — the ADR-0042 safety rail.
//
// The `task harness:dev` seams (static CA bundle, vault boot-seed, authz
// overlay) are gated by CLOISTER_MODE=dev + the DEV_* bindings. They relax
// where the trust anchors come from (local, ephemeral) — safe for a laptop,
// NEVER for a deployed cluster. This lint makes that structural: it fails the
// strict gate if any COMMITTED config enables a dev-mode seam. Dev convenience
// cannot ship.
//
// Checked files (committed operator/runtime config):
//   - config.capnp        (workerd-local bindings)
//   - wrangler.toml       (CF-prod bindings)
//   - cluster.toml        (operator surface)
//   - src/generated/cluster.ts / manifest.ts (generated runtime config)
//
// A violation is: CLOISTER_MODE set to a dev value, or any of DEV_CA_MASTER /
// DEV_CA_EPOCH / DEV_VAULT_SEED / DEV_ALLOWED_SUBS present with a non-empty
// value. The dev run supplies these at runtime (process env / a gitignored
// dev env file), never through committed config.
//
// Exit 0 = clean; exit 1 = a committed config enables dev mode.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "config.capnp",
  "wrangler.toml",
  "cluster.toml",
  "cluster.lock.toml",
  "src/generated/cluster.ts",
  "src/generated/manifest.ts",
];

const DEV_KEYS = ["DEV_CA_MASTER", "DEV_CA_EPOCH", "DEV_VAULT_SEED", "DEV_ALLOWED_SUBS",
  // A per-run acknowledgement that macOS leaves bind/inbound unenforced
  // (cloister-2d420c). Committed config must never carry it: the whole point is
  // that the weaker boundary is re-declared by whoever starts the run, not
  // inherited silently by a deployment.
  "CLOISTER_ACCEPT_UNENFORCED_BIND"];

// Match `CLOISTER_MODE` assigned a dev-ish value across TOML (`= "dev"`),
// capnp (`text = "dev"` near the name), and TS (`"CLOISTER_MODE": "dev"`).
// We keep it broad: any CLOISTER_MODE line whose value contains "dev".
const CLOISTER_MODE_DEV = /CLOISTER_MODE[^\n]*\bdev\b/i;

// A DEV_* key present with a non-empty string/text value. Empty ("") is fine —
// that's a placeholder binding, not an enablement.
function devKeyWithValue(text, key) {
  // e.g. DEV_CA_MASTER = "abc"  |  "DEV_CA_MASTER": "abc"  |  text = "abc" after name=DEV_CA_MASTER
  const re = new RegExp(`${key}[^\\n]*?["']([^"']+)["']`, "i");
  const m = text.match(re);
  return m && m[1].trim().length > 0 ? m[1] : null;
}

const violations = [];

for (const rel of FILES) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, "utf8");

  if (CLOISTER_MODE_DEV.test(text)) {
    violations.push(`${rel}: CLOISTER_MODE is set to a dev value in committed config`);
  }
  for (const key of DEV_KEYS) {
    const val = devKeyWithValue(text, key);
    if (val !== null) {
      violations.push(`${rel}: ${key} has a committed value ("${val.slice(0, 16)}…") — dev seams must be runtime-only`);
    }
  }
}

if (violations.length > 0) {
  console.error("lint-no-dev-mode: FAIL — committed config enables an ADR-0042 dev-mode seam:");
  for (const v of violations) console.error(`  ✘ ${v}`);
  console.error("\n  Dev-mode (CLOISTER_MODE=dev + DEV_* vars) is supplied at RUNTIME by");
  console.error("  `task harness:dev` (process env / a gitignored dev env file), never in");
  console.error("  committed config. Remove the value(s) above. Per ADR-0042.");
  process.exit(1);
}

console.log(`lint-no-dev-mode: clean ✓ (${FILES.length} config file(s) scanned, 0 dev-mode enablements)`);
