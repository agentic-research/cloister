#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:binding-parity — a binding read in src/ must exist on BOTH deployment
// paths (cloister-9aeb3f).
//
// CLAUDE.md says config.capnp and wrangler.toml "must stay in sync"; ADR-0001
// recorded it as a known weakness ("kept in sync manually — two sources of
// truth for bindings"). Nothing enforced it, and it had drifted: six bindings
// existed in wrangler.toml, were READ in src/, and were absent from
// config.capnp — including INTERLACE_ROOT_PUBKEY, the lease-gate authority.
//
// The consequence was not an auth bypass (ADR-0053 fails closed on absent
// authority) but a testability hole: the lease gate, disclosure HMAC and
// receipt signing could not be exercised under workerd at all, so
// `task serve:local` and `task smoke` structurally could not cover the
// surface the threat model treats as the contract.
//
// ── What this checks ──────────────────────────────────────────────────────
//
// For every binding NAME read as `env.X` in src/: it must appear in both
// config.capnp and wrangler.toml, or carry a declared asymmetry with a
// reason. Reading src/ rather than diffing the two files is deliberate — an
// unread binding in one file is housekeeping, but an unread-nowhere binding
// difference is noise, and a READ binding missing on a path is a real hole.
//
// Exit 0 clean, 1 on violations.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Bindings that legitimately exist on ONE path only, with the reason.
 *
 * These are differences in binding MECHANISM, not missing bindings: workerd
 * wires in-process peers as service bindings, while the CF path reaches the
 * same peer over HTTP via a `*_URL` var. A rail that flagged these would cry
 * wolf on five correct declarations, so they are declared rather than
 * suppressed — the exemption is explicit, reasoned, and greppable, matching
 * the `lint-allow-*` convention used elsewhere in this tree.
 */
export const DECLARED_ASYMMETRY = {
  MACHE_MCP:     "workerd service binding; the CF path reaches mache via MACHE_MCP_URL over HTTP",
  LSP_MCP:       "workerd service binding; the CF path reaches LLO's LSP via LLO_MCP_URL over HTTP",
  ROSARY_MCP:    "workerd service binding; the CF path reaches rosary via ROSARY_MCP_URL over HTTP",
  COMPANION_MCP: "workerd service binding; the CF path reaches the companion via COMPANION_URL over HTTP",
  KEK_HELPER:    "workerd-only: the local sign-only KEK helper (ADR-0014 / ADR-0019) has no CF analogue; CF uses vault slices",
  // Inverse direction from the five above: CF-only, not workerd-only.
  NOTME_JWT:     "CF-only: an RPC entrypoint binding (notme's JwtSigner, ADR-015). config.capnp declares notme-bot as a NETWORK service (allow = [\"public\"]), and a network service is reached by fetch — an RPC entrypoint cannot bind to one. Local dev gets no delegated JWT signing and /oauth/token returns 503, which is what it already did against the 404 that replaced /internal/sign-jwt",
};

const SKIP_DIR = new Set(["node_modules", "generated", ".git"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Binding names read as `env.X` / `env["X"]` anywhere in src/. */
export function bindingsReadInSrc(root = ROOT) {
  const names = new Set();
  for (const file of walk(resolve(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]);
    for (const m of text.matchAll(/\benv\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g)) names.add(m[1]);
  }
  return names;
}

/**
 * Binding names declared in config.capnp (the workerd path).
 *
 * Still pattern-matched, because config.capnp is capnp text and parsing it
 * properly needs `capnp eval` — a toolchain dependency this rail should not
 * carry. The assumption is therefore stated rather than implied: in a workerd
 * config, `name = "..."` appears on BINDINGS (SCREAMING_SNAKE) and on
 * services/sockets (lower-kebab: "cloister", "mache-mcp", "do-storage"), so
 * the case discriminates them. Verified against the tree: 33 `name =`
 * declarations, 22 bindings, 11 lower-kebab service/socket names.
 *
 * MIN_EXPECTED_BINDINGS guards the direction that matters. A pattern that
 * silently under-matches reports CLEAN — worse than false positives, because
 * a phantom finding gets investigated while a phantom pass gets trusted. If
 * the file's shape changes enough to break extraction, this fails loudly
 * instead of quietly certifying parity it never checked.
 */
const MIN_EXPECTED_BINDINGS = 15;

export function bindingsInConfigCapnp(root = ROOT) {
  const text = readFileSync(resolve(root, "config.capnp"), "utf8");
  const names = new Set([...text.matchAll(/name = "([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1]));
  if (names.size < MIN_EXPECTED_BINDINGS) {
    throw new Error(
      `lint-binding-parity: extracted only ${names.size} binding(s) from config.capnp, ` +
      `expected at least ${MIN_EXPECTED_BINDINGS}. The file's shape likely changed and this ` +
      `rail can no longer read it — fix the extraction rather than lowering the floor, or ` +
      `the rail reports parity it never verified.`,
    );
  }
  return names;
}

/**
 * Binding names declared in wrangler.toml (the Cloudflare path).
 *
 * PARSED, not regexed. The first attempt matched `name = "X"` line-anchored
 * and silently missed every Durable Object binding, because wrangler declares
 * them as INLINE tables:
 *
 *   bindings = [ { name = "BEAD_STORE", class_name = "BeadStore" }, ... ]
 *
 * The rail then reported four false violations — a lint that invents findings
 * is worse than no lint, since the fix for a phantom is to weaken the rail.
 * TOML has a parser; use it.
 */
export function bindingsInWrangler(root = ROOT) {
  const doc = parseToml(readFileSync(resolve(root, "wrangler.toml"), "utf8"));
  const names = new Set();

  const addFrom = (scope) => {
    if (!scope || typeof scope !== "object") return;
    for (const key of Object.keys(scope.vars ?? {})) names.add(key);
    for (const section of ["durable_objects", "services", "kv_namespaces", "r2_buckets", "queues"]) {
      const s = scope[section];
      const rows = Array.isArray(s) ? s : Array.isArray(s?.bindings) ? s.bindings : [];
      for (const row of rows) {
        const n = row?.binding ?? row?.name;
        if (typeof n === "string") names.add(n);
      }
    }
  };

  addFrom(doc);
  for (const envScope of Object.values(doc.env ?? {})) addFrom(envScope);
  return names;
}

export function findViolations(root = ROOT) {
  const read = bindingsReadInSrc(root);
  const cfg = bindingsInConfigCapnp(root);
  const wr = bindingsInWrangler(root);
  const out = [];
  for (const name of [...read].sort()) {
    if (name in DECLARED_ASYMMETRY) continue;
    const inCfg = cfg.has(name);
    const inWr = wr.has(name);
    if (inCfg && inWr) continue;
    if (!inCfg && !inWr) continue; // declared nowhere — a different problem
    out.push({ name, missingFrom: inCfg ? "wrangler.toml" : "config.capnp" });
  }
  return out;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    const n = bindingsReadInSrc().size;
    console.log("lint-binding-parity: clean ✓");
    console.log(`  ${n} binding(s) read in src/ resolve on both deployment paths`);
    console.log(`  ${Object.keys(DECLARED_ASYMMETRY).length} declared asymmetr(ies) skipped`);
    return 0;
  }
  console.error(`lint-binding-parity: ${violations.length} binding(s) exist on one path only\n`);
  for (const v of violations) {
    console.error(`  ${v.name}`);
    console.error(`    read in src/, missing from ${v.missingFrom}`);
  }
  console.error(`\n  A binding present on one path and absent on the other means code`);
  console.error(`  reading it gets a value in one deployment and undefined in the other.`);
  console.error(`  Declare it on both (empty text is fine — it declares the binding`);
  console.error(`  without committing a value), or add it to DECLARED_ASYMMETRY with the`);
  console.error(`  reason it is legitimately one-sided.`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
