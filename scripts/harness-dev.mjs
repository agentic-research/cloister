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
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_ONLY = process.argv.includes("--setup-only");
const SHIM_PORT = process.env.HARNESS_SHIM_PORT ?? "8799";

// Pluggable sandbox provider (cloister-24717d). SANDBOX=nono runs the
// harness kernel-confined via the `cloister-harness` binary
// (tools/harness-sandbox): it applies a DECLARED, default-deny nono
// CapabilityManifest programmatically (Seatbelt on macOS, Landlock on
// Linux) — NOT hand-assembled `nono run` flags — then execs the harness.
// workdir + harness state rw, localhost TCP to the shim port only,
// external network blocked — exactly the vault-proxy seam. The confinement
// is FILESYSTEM + PROCESS only; the credential path stays cloister's
// /vault/proxy (no double-proxy). Unset = print the export line; the
// operator launches the harness themselves. See tools/harness-sandbox/README.md.
const SANDBOX = process.env.SANDBOX ?? "";
const CONFINE_BIN = resolve(ROOT, "tools/harness-sandbox/target/release/cloister-harness");
if (SANDBOX && SANDBOX !== "nono") {
  console.error(`harness:dev — unknown SANDBOX provider ${JSON.stringify(SANDBOX)} (supported: nono).`);
  process.exit(2);
}
if (SANDBOX === "nono" && !existsSync(CONFINE_BIN)) {
  console.error("harness:dev — SANDBOX=nono: building the confinement binary (cloister-harness)…");
  try {
    execFileSync(
      "cargo",
      ["build", "--release", "--manifest-path", resolve(ROOT, "tools/harness-sandbox/Cargo.toml")],
      { stdio: "inherit" },
    );
  } catch {
    console.error("harness:dev — failed to build tools/harness-sandbox (needs the nono crate + rustc 1.95).");
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
  execFileSync("cargo", ["run", "-q", "-p", "cloister-cas", "--example", "mint-dev-cert"], {
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
  // Kernel-confine the harness via the cloister-harness binary: emit a
  // DECLARED, default-deny nono CapabilityManifest and let the binary apply
  // it + exec the harness. workdir + harness state are the only rw surfaces,
  // external network is blocked, the shim port is the only localhost TCP —
  // it reaches the vault proxy but not ~/.ssh / ~/.aws / the wider internet.
  const home = homedir();
  const cmd = process.env.HARNESS_CMD ?? "claude";
  const workdir = resolve(process.env.HARNESS_WORKDIR ?? process.cwd());
  const stateDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  // Resolve the harness to a full path — the confined binary is a DECLARED
  // grant and we exec it by path (no $PATH lookup inside the sandbox), which
  // is why `claude: command not found` used to happen.
  const harnessBin = cmd.includes("/")
    ? cmd
    : execFileSync("/usr/bin/which", [cmd], { encoding: "utf8" }).trim();

  // nono's macOS system defaults — replicated from `nono run -v` (the
  // system_read_macos / system_write_macos / user_tools / homebrew groups the
  // CLI seeds but the library apply() does not). Read-only unless noted; lets
  // binaries + dylibs + the harness itself load.
  const sysRead = [
    "/bin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/lib", "/usr/local/lib",
    "/usr/share", "/System/Library", "/Library", "/Library/Frameworks",
    "/private/var/db", "/private/etc", "/private/var", "/private",
    "/System/Volumes", "/System/Cryptexes", "/opt", "/opt/homebrew",
    join(home, ".local/bin"), join(home, ".local/share"),
  ];
  const sysRw = ["/dev", "/private/tmp", "/private/var/folders"];
  const grants = [
    ...sysRead.map((path) => ({ path, access: "read", type: "directory" })),
    ...sysRw.map((path) => ({ path, access: "readwrite", type: "directory" })),
    { path: workdir, access: "readwrite", type: "directory" },
    { path: stateDir, access: "readwrite", type: "directory" },
  ];
  const policy = {
    capabilities: {
      version: "0.1.0",
      filesystem: {
        grants,
        // Belt-and-suspenders: the allow-list already excludes these, but
        // deny takes precedence on Seatbelt, so name the credential dirs.
        deny: [
          { path: join(home, ".ssh") },
          { path: join(home, ".aws") },
          { path: join(home, ".config/gcloud") },
        ],
      },
      // DEFAULT-DENY network: blocked, with the single vault-proxy localhost
      // port as the only egress. cloister-harness refuses any non-blocked mode.
      network: { mode: "blocked", ports: { localhost: [Number(SHIM_PORT)] } },
    },
    // Credentials never enter the confined env — cloister injects at the proxy.
    env_strip: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    env_set: { ANTHROPIC_BASE_URL: BASE_URL },
    harness_bin: harnessBin,
    harness_args: process.env.HARNESS_ARGS ? JSON.parse(process.env.HARNESS_ARGS) : [],
  };
  const policyPath = resolve(ROOT, ".harness-policy.json");
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));

  console.error(`\n${bar}\nharness:dev — SANDBOX=nono: launching ${harnessBin} kernel-confined (cloister-harness).`);
  console.error(`  policy: ${policyPath} (declared nono manifest, default-deny)`);
  console.error(`  rw: ${workdir}, ${stateDir}`);
  console.error(`  network: blocked, localhost :${SHIM_PORT} only → ${BASE_URL}\n${bar}\n`);
  // Wait for the shim to bind before launching the confined harness — otherwise
  // the harness's first request races the shim's startup (connect-refused).
  await waitForPort(BASE_URL, 15_000);
  harness = spawn(CONFINE_BIN, [policyPath], { cwd: workdir, stdio: "inherit" });
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
  try { rmSync(resolve(ROOT, ".harness-policy.json"), { force: true }); } catch { /* best-effort */ }
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

// The shim is up once a request connects — any HTTP response (even 404) means
// it is bound; only a connect error (fetch throws) means not-yet-listening.
async function waitForPort(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch {
      // shim not bound yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`shim did not bind at ${url} within ${timeoutMs}ms`);
}
