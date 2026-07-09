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
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_ONLY = process.argv.includes("--setup-only");
const SHIM_PORT = process.env.HARNESS_SHIM_PORT ?? "8799";

// Pluggable sandbox provider (cloister-24717d). SANDBOX=nono runs the
// harness kernel-confined via the nono CLI (Seatbelt on macOS, Landlock
// on Linux): workdir + harness state rw, localhost TCP to the shim port
// only, external network blocked — exactly the vault-proxy seam. nono is
// used for FILESYSTEM + PROCESS confinement only; the credential path
// stays cloister's /vault/proxy (nono ships its own credential proxy —
// do NOT double-proxy; see tools/harness-sandbox/README.md). Unset =
// current behavior (print the export line; the operator launches the
// harness themselves).
const SANDBOX = process.env.SANDBOX ?? "";
if (SANDBOX && SANDBOX !== "nono") {
  console.error(`harness:dev — unknown SANDBOX provider ${JSON.stringify(SANDBOX)} (supported: nono).`);
  process.exit(2);
}
if (SANDBOX === "nono") {
  try {
    execFileSync("/usr/bin/which", ["nono"], { encoding: "utf8" });
  } catch {
    console.error("harness:dev — SANDBOX=nono needs the nono CLI on PATH (https://nono.sh — brew/cargo install nono).");
    process.exit(2);
  }
}
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
  // Plain value (comma-list form applyDevAllowedSubs accepts), NOT a JSON
  // array — .dev.vars dotenv parsing mangles escaped quotes inside `"[\"…\"]"`,
  // which silently breaks the allowedSubs overlay → manifest_deny. Found live.
  `DEV_ALLOWED_SUBS = ${JSON.stringify(dev.peerFp)}`,
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

const BASE_URL = `http://127.0.0.1:${SHIM_PORT}/vault/proxy/anthropic`;
const bar = "─".repeat(64);
let harness = null;
if (SANDBOX === "nono") {
  // Launch the harness itself, kernel-confined (Seatbelt on macOS,
  // Landlock on Linux). The confinement IS the isolation: workdir +
  // harness state are the only rw surfaces, external network is blocked,
  // and the shim port is the only localhost TCP the harness may use —
  // it can reach the vault proxy but not ~/.ssh, ~/.aws, or the wider
  // internet. nono default-allows system/toolchain paths so binaries
  // load, and default-denies $HOME.
  const cmd = process.env.HARNESS_CMD ?? "claude";
  const workdir = resolve(process.env.HARNESS_WORKDIR ?? process.cwd());
  const stateDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const env = { ...process.env, ANTHROPIC_BASE_URL: BASE_URL };
  // Neither credential form ever enters the confined env: custody vaults
  // the key; audit forwards the harness's own OAuth from its state dir.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  console.error(`\n${bar}\nharness:dev — SANDBOX=nono: launching ${cmd} kernel-confined (nono run).`);
  console.error(`  workdir (rw): ${workdir}`);
  console.error(`  harness state (rw): ${stateDir}`);
  console.error(`  network: --block-net, localhost :${SHIM_PORT} only → ${BASE_URL}\n${bar}\n`);
  harness = spawn("nono", [
    "run",
    "-a", workdir,
    "--allow-cwd",
    // The harness's own state (config, sessions, its OWN OAuth creds in
    // audit mode) — NOT ~/.ssh / ~/.aws, which stay denied by default.
    "-a", stateDir,
    "--allow-file", join(homedir(), ".claude.json"),
    // Localhost-only seam: block outbound, open exactly the shim port.
    // Credential injection is cloister's /vault/proxy job — nono's own
    // --credential proxy is deliberately NOT used here.
    "--block-net",
    "--open-port", SHIM_PORT,
    "--",
    cmd,
  ], { cwd: workdir, stdio: "inherit", env });
} else {
  console.error(`\n${bar}\nharness:dev — ready. In your harness shell:\n`);
  console.error(`  export ANTHROPIC_BASE_URL="${BASE_URL}"`);
  if (AUDIT) {
    console.error(`  # DO NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — either leaves your`);
    console.error(`  # Max subscription. Base-URL only keeps the subscription; cloister receipts`);
    console.error(`  # each call (audit, not custody — there's no key to vault).`);
  } else {
    console.error(`  # no ANTHROPIC_API_KEY on the harness — the key is vaulted in cloister.`);
  }
  console.error(`  claude`);
  console.error(`  # (or: SANDBOX=nono task harness:dev to launch it kernel-confined)`);
  console.error(`${bar}\n`);
}

const cleanup = () => {
  harness?.kill();
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
harness?.on("exit", cleanup);

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
