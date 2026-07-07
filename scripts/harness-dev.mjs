// SPDX-License-Identifier: AGPL-3.0-or-later
//
// harness:dev — the turnkey local run (ADR-0042). One command:
//
//   1. mint a fresh ephemeral dev master + Interlace cert (rust mint-dev-cert)
//   2. write .dev.vars so `wrangler dev` binds the dev-mode seams:
//      CLOISTER_MODE=dev + DEV_CA_MASTER/EPOCH + DEV_VAULT_SEED + DEV_ALLOWED_SUBS
//   3. launch cloister (`task dev`, :8787) + the lease shim (:8799)
//   4. print `export ANTHROPIC_BASE_URL=…` — point Claude Code at it
//
// The Anthropic key comes from ANTHROPIC_API_KEY (env). It is written to
// .dev.vars (gitignored) as the vault seed and injected INSIDE the vault DO —
// never into the harness's environment. Everything here is dev-only +
// runtime-only: .dev.vars + the minted cert are gitignored, regenerated each
// run; lint:no-dev-mode forbids any of it in committed config.
//
// Prereq: run `task dev:bootstrap` once (writes .env.local with VAULT_KEK_SOURCE
// for the local vault). `--setup-only` mints + writes .dev.vars without
// launching (used by the setup test).

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_ONLY = process.argv.includes("--setup-only");
const SHIM_PORT = process.env.HARNESS_SHIM_PORT ?? "8799";
const CLOISTER_BASE = "http://127.0.0.1:8787";
const SERVICE = "anthropic";
const UPSTREAM = "https://api.anthropic.com";

// Mode. AUDIT (Claude Code Max / OAuth): no key to vault — forward the
// harness's OWN auth + receipt (ADR-0040 amendment). CUSTODY (API key): vault
// the key + inject it. Audit is chosen explicitly (--audit) or automatically
// when no ANTHROPIC_API_KEY is set.
const apiKey = process.env.ANTHROPIC_API_KEY;
const AUDIT = process.argv.includes("--audit") || (!apiKey && !SETUP_ONLY) || (SETUP_ONLY && !apiKey);
if (!AUDIT && !apiKey && !SETUP_ONLY) {
  console.error("harness:dev — custody mode needs ANTHROPIC_API_KEY (vaulted, never in the harness env), or pass --audit for a Max/OAuth subscription.");
  process.exit(2);
}
console.error(`harness:dev — ${AUDIT ? "AUDIT mode (Max/OAuth — forward harness auth + receipt; no key vaulted)" : "CUSTODY mode (API key vaulted + injected)"}.`);

// 1. Mint a fresh dev identity.
console.error("harness:dev — minting a fresh ephemeral dev master + cert…");
const dev = JSON.parse(
  execFileSync("cargo", ["run", "-q", "--example", "mint-dev-cert"], {
    cwd: resolve(ROOT, "rs"),
    encoding: "utf8",
  }),
);

// 2. .dev.vars — wrangler dev binds these into the Worker env. Common seams
// (dev CA master + gate + authz overlay) apply to both modes; the credential
// path differs.
const common = [
  `CLOISTER_MODE = "dev"`,
  `DEV_CA_MASTER = ${JSON.stringify(dev.masterPubB64Std)}`,
  `DEV_CA_EPOCH = ${JSON.stringify(String(dev.epoch))}`,
  `DEV_ALLOWED_SUBS = ${JSON.stringify(JSON.stringify([dev.peerFp]))}`,
];
const modeVars = AUDIT
  // Audit: force the service to passthrough — no seed, no vaulted key.
  ? [`DEV_PASSTHROUGH_SERVICES = ${JSON.stringify(SERVICE)}`]
  // Custody: seed the vaulted key for injection.
  : [`DEV_VAULT_SEED = ${JSON.stringify(JSON.stringify({
      peerFp: dev.peerFp, service: SERVICE, upstream: UPSTREAM,
      headers: { "x-api-key": apiKey }, allowedSubs: [dev.peerFp],
    }))}`];
writeFileSync(resolve(ROOT, ".dev.vars"), [...common, ...modeVars].join("\n") + "\n");
console.error(`harness:dev — wrote .dev.vars (peerFp ${dev.peerFp}, service ${SERVICE}, ${AUDIT ? "passthrough" : "vaulted"}).`);

if (SETUP_ONLY) {
  console.error("harness:dev — --setup-only: skipping launch. .dev.vars is ready.");
  process.exit(0);
}

// 3. Launch cloister + shim.
const cloister = spawn("task", ["dev"], { cwd: ROOT, stdio: "inherit" });
await waitForHealth(`${CLOISTER_BASE}/health`, 60_000);

const shim = spawn(process.execPath, ["--import", "tsx", "tools/harness-shim/index.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    HARNESS_SHIM_PORT: SHIM_PORT,
    CLOISTER_BASE_URL: CLOISTER_BASE,
    HARNESS_SHIM_CERT_B64: dev.certDerB64Url,
    HARNESS_SHIM_PRIV_SEED_B64: dev.ephemeralPrivSeedB64Url,
    HARNESS_SHIM_PUBKEY_B64: dev.ephemeralPubB64Url,
    // Audit mode preserves the harness's own Authorization (OAuth) through to
    // cloister's passthrough proxy; custody strips it (cloister injects).
    ...(AUDIT ? { HARNESS_SHIM_PRESERVE_AUTH: "1" } : {}),
  },
});

const bar = "─".repeat(64);
console.error(`\n${bar}\nharness:dev — ready. In your harness shell:\n`);
console.error(`  export ANTHROPIC_BASE_URL="http://127.0.0.1:${SHIM_PORT}/vault/proxy/anthropic"`);
if (AUDIT) {
  console.error(`  # DO NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — either leaves your`);
  console.error(`  # Max subscription. Base-URL only keeps the subscription; cloister receipts`);
  console.error(`  # each call (audit, not custody — there's no key to vault).`);
} else {
  console.error(`  # no ANTHROPIC_API_KEY on the harness — the key is vaulted in cloister.`);
}
console.error(`  claude`);
console.error(`${bar}\n`);

const cleanup = () => {
  shim.kill();
  cloister.kill();
  // Remove the dev-vars so an active dev session doesn't leave state that a
  // later `vitest`/`wrangler` run in the same tree would load. (The proper
  // fix — isolating the dev-run config surface from the test env — is the
  // config de-sprawl direction: docs/superpowers/specs/2026-07-07-config-desprawl-direction.md;
  // this is the interim guard.)
  try { rmSync(resolve(ROOT, ".dev.vars"), { force: true }); } catch { /* best-effort */ }
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
cloister.on("exit", cleanup);
shim.on("exit", cleanup);

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // cloister not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`cloister did not become healthy at ${url} within ${timeoutMs}ms`);
}
