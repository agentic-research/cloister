// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lint:trust-env-locality — cloister-21e42e rail. Generalizes the
// lint:lease-gate-source single-source pattern to the whole trust-secret env
// surface.
//
// The empty-value footgun (21e42e) — an empty config value silently disabling a
// trust check — hid because trust env vars were read in SCATTERED places
// (mcp.ts read env.INTERLACE_ROOT_PUBKEY directly, so `if (env.…)` empty→off was
// invisible). The structural fix is locality: each trust-secret env var is read
// in exactly ONE resolver, where its emptiness semantics are defined ONCE and
// are reviewable. A read anywhere else is how the next silent empty-default
// sneaks in — so this fails on it.
//
// This is the defense-in-depth companion to the runtime fixes (the gate fails
// closed via ADR-0053; resolveCABundle / the vault KEK / the disclosure HMAC all
// fail closed on empty). Those make emptiness SAFE at each resolver; this rail
// keeps every trust-secret read INSIDE a resolver so a new one can't reintroduce
// the scatter. INTERLACE_ROOT_PUBKEY is owned by lint:lease-gate-source; this
// covers the rest. Extend OWNED when a new trust-secret binding lands.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC = resolve(REPO_ROOT, "src");

// (trust-secret env var) → (files allowed to read it directly). A read of
// `env.<VAR>` in any other src/ file is a violation — route the value through
// the owning resolver instead.
export const OWNED = [
  { name: "VAULT_KEK_SOURCE",         allow: ["src/vault-store.ts"] },
  { name: "VAULT_KEK_TENANT_SCOPED",  allow: ["src/vault-store.ts"] },
  { name: "DEV_VAULT_SEED",           allow: ["src/vault-store.ts"] },
  { name: "RECEIPT_SIGNING_KEY",      allow: ["src/routes/receipt-emitter.ts"] },
  { name: "RECEIPT_ACTOR_FP",         allow: ["src/routes/receipt-emitter.ts"] },
  { name: "RECEIPT_EPOCH",            allow: ["src/routes/receipt-emitter.ts"] },
  { name: "DEV_CA_MASTER",            allow: ["src/storage/ca-bundle-source.ts", "src/routes/lease-gate.ts"] },
  { name: "DEV_CA_EPOCH",             allow: ["src/storage/ca-bundle-source.ts"] },
  { name: "DEV_ALLOWED_SUBS",         allow: ["src/routes/vault-proxy-route.ts"] },
  { name: "DEV_PASSTHROUGH_SERVICES", allow: ["src/routes/vault-proxy-route.ts"] },
];

const WORD_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

/**
 * True if `text` reads `env.<name>` as a whole identifier (the char after the
 * name is not a word char, so `env.RECEIPT_EPOCH` does not match a hypothetical
 * `env.RECEIPT_EPOCHS`). Pure. No regex.
 */
export function readsEnvVar(text, name) {
  const needle = `env.${name}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const after = text[at + needle.length];
    if (after === undefined || !WORD_CHARS.includes(after)) return true;
    from = at + needle.length;
  }
}

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
 * Find trust-env-locality violations in one file's text. Pure — exported for
 * tests. `rel` is the repo-relative POSIX path (used to check the allowlist).
 */
export function findViolations(rel, text) {
  const violations = [];
  const lines = text.split("\n");
  for (const { name, allow } of OWNED) {
    if (allow.includes(rel)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (readsEnvVar(lines[i], name)) {
        violations.push({ rel, line: i + 1, name, allow });
      }
    }
  }
  return violations;
}

/** Walk src/ and collect violations across every .ts file. */
export function collectViolations() {
  const violations = [];
  for (const abs of listTsFiles(SRC)) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    violations.push(...findViolations(rel, readFileSync(abs, "utf8")));
  }
  return violations;
}

// ── CLI ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = collectViolations();
  if (violations.length > 0) {
    console.error("lint-trust-env-locality: FAIL — a trust-secret env var is read outside its resolver (cloister-21e42e):");
    for (const v of violations) {
      console.error(`  ✘ ${v.rel}:${v.line}: reads env.${v.name} directly`);
      console.error(`      → route it through the resolver in ${v.allow.join(" / ")}; a scattered read is how an`);
      console.error(`        empty-value-means-off footgun hides (the emptiness semantics must live in one place).`);
    }
    process.exit(1);
  }
  console.log("lint-trust-env-locality: OK — every trust-secret env var is read only in its resolver.");
}
