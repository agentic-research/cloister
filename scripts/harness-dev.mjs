// SPDX-License-Identifier: AGPL-3.0-or-later
//
// harness:dev — the turnkey local run (ADR-0042). One command:
//
//   1. mint a fresh ephemeral dev master + Interlace cert (rust mint-dev-cert)
//   2. write .dev.vars so `wrangler dev` binds the dev-mode seams:
//      CLOISTER_MODE=dev + DEV_CA_MASTER/EPOCH + DEV_VAULT_SEED + DEV_ALLOWED_SUBS
//   3. launch cloister (`task dev`, :8787) + the lease shim (:8799)
//   4. print the target's base-URL export — point the harness at it
//
// WHICH harness is a declared profile, not a hardcoded one: `--target
// claude-code | codex` selects a row in scripts/harness-targets.mjs, and every
// provider-specific value (service, upstream, key env var, base-URL env var,
// injection header, state dir, executable, supported auth modes) comes from
// that row. This file contains NO provider literals — `lint:harness-target-
// literals` enforces it, so adding a third harness is a new row and no edit
// here. Per cloister-742e19 + ADR-0057.
//
// The API key comes from the target's declared key env var. It is written to
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

import {
  loadHarnessConfig,
  resolveTarget,
  serviceFor,
  credentialHeaders,
  targetNames,
  UsageError,
} from "./harness-targets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_ONLY = process.argv.includes("--setup-only");

// Which harness are we launching? Declared in harness-targets.mjs — this file
// holds NO provider literals (lint:harness-target-literals enforces it).
//
// The target is cross-checked against cluster.toml's vaultProxyServices before
// anything is minted or written: service name, injection strategy, header name,
// and upstream are each declared in BOTH places, and a disagreement should be a
// named error here rather than a provider 401 twenty seconds later with nothing
// pointing at the cause.
let TARGET, SVC, DECLARED = [];
try {
  const cfg = await loadHarnessConfig(resolve(ROOT, "cluster.toml"));
  DECLARED = cfg.targets;
  TARGET = resolveTarget(DECLARED, process.argv);
  SVC = serviceFor(TARGET, cfg.services);
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`harness:dev — ${err.message}`);
    if (DECLARED.length) {
      console.error(`  usage: task harness:dev -- --target <${targetNames(DECLARED).join("|")}>`);
    }
    process.exit(2);
  }
  throw err;
}
const TARGET_NAME = TARGET.name;
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
const SERVICE = TARGET.service;
// Upstream is the SERVICE's declaration, never restated on the target.
const UPSTREAM = SVC.upstreamBaseUrl;

// Mode. AUDIT: no key to vault — forward the harness's OWN auth + receipt
// (ADR-0040 amendment). CUSTODY: vault the key + inject it. Audit is chosen
// explicitly (--audit) or automatically when the target's key env var is unset.
//
// A target declares which modes it supports. Audit only makes sense where the
// provider sells a subscription that vaulting a key would silently bypass, so
// asking for it on a custody-only target is a named refusal — not a silent
// downgrade that would move billing without saying so.
const apiKey = process.env[TARGET.apiKeyEnv];
const wantsAudit = process.argv.includes("--audit");
const supportsAudit = TARGET.authModes.includes("audit");
if (wantsAudit && !supportsAudit) {
  console.error(
    `harness:dev — target ${JSON.stringify(TARGET_NAME)} does not support --audit ` +
      `(declared modes: ${TARGET.authModes.join(", ")}).`,
  );
  process.exit(2);
}
const AUDIT = supportsAudit && (wantsAudit || !apiKey);
if (!AUDIT && !apiKey) {
  const hint = supportsAudit
    ? `, or pass --audit to keep a subscription`
    : ` (this target is custody-only)`;
  console.error(
    `harness:dev — custody mode needs ${TARGET.apiKeyEnv} ` +
      `(vaulted, never in the harness env)${hint}.`,
  );
  process.exit(2);
}
console.error(
  `harness:dev — target ${TARGET_NAME} · ` +
    (AUDIT
      ? "AUDIT mode (forward harness auth + receipt; no key vaulted)"
      : "CUSTODY mode (API key vaulted + injected)"),
);

// The confinement/v1 manifest the harness identity commits to (§7,
// cloister-c80953). A STABLE profile declaration — not per-run paths — so the
// digest the minter commits into the cert matches the one the runner recomputes
// over the SAME manifest inlined in the policy. The nono CapabilityManifest below
// is the kernel-plane enforcement; this is its confinement/v1 shadow (the
// documented impedance: the localhost vault-proxy egress maps to allowHosts
// ["127.0.0.1"], no listener → port.bind 0). Both halves are one declaration.
const CONFINEMENT_MANIFEST = {
  version: "cloister/confinement/v1",
  fs: { allow: [{ path: "workspace", mode: "rw" }, { path: "state", mode: "rw" }] },
  network: { allowHosts: ["127.0.0.1"] },
  port: { bind: 0 },
  credentialSource: `vault://${SERVICE}`,
};
const CONFINEMENT_MANIFEST_PATH = resolve(ROOT, ".harness-confinement.json");
writeFileSync(CONFINEMENT_MANIFEST_PATH, JSON.stringify(CONFINEMENT_MANIFEST, null, 2));

// 1. Mint a fresh dev identity. CLOISTER_CONFINEMENT_MANIFEST points the minter
// at the manifest above so the cert commits its §6/BLAKE3 digest (Interlace
// extension OID .1.7) — the anchor the runner's §7 check verifies against.
console.error("harness:dev — minting a fresh ephemeral dev master + cert…");
const dev = JSON.parse(
  execFileSync("cargo", ["run", "-q", "-p", "cloister-cas", "--example", "mint-dev-cert"], {
    cwd: resolve(ROOT, "rs"),
    encoding: "utf8",
    env: { ...process.env, CLOISTER_CONFINEMENT_MANIFEST: CONFINEMENT_MANIFEST_PATH },
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
      headers: credentialHeaders(SVC, apiKey), allowedSubs: [dev.peerFp],
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

const BASE_URL = `http://127.0.0.1:${SHIM_PORT}/vault/proxy/${SERVICE}`;
const bar = "─".repeat(64);
let harness = null;
if (SANDBOX === "nono") {
  // Kernel-confine the harness via the cloister-harness binary: emit a
  // DECLARED, default-deny nono CapabilityManifest and let the binary apply
  // it + exec the harness. workdir + harness state are the only rw surfaces,
  // external network is blocked, the shim port is the only localhost TCP —
  // it reaches the vault proxy but not ~/.ssh / ~/.aws / the wider internet.
  const home = homedir();
  const workdir = resolve(process.env.HARNESS_WORKDIR ?? process.cwd());
  const stateDir = process.env[TARGET.stateDirEnv] ?? join(home, TARGET.stateDir);

  // The executable is a DECLARED absolute path — the same concept as a bundle's
  // `entryPoint`, and for the same reason: confined exec resolves by path with
  // no $PATH inside the sandbox. A declared path is the supported form.
  //
  // Falling back to `$PATH` lookup when entryPoint is empty is a convenience for
  // the unconfined case only. It uses `which` off $PATH rather than a hardcoded
  // /usr/bin/which (which is not where it lives on every distro), and failure is
  // a named error pointing at the declaration — the silent version of this is
  // where `claude: command not found` came from.
  const cmd = process.env.HARNESS_CMD || TARGET.entryPoint || TARGET.name;
  let harnessBin = cmd;
  if (!cmd.includes("/")) {
    try {
      harnessBin = execFileSync("which", [cmd], { encoding: "utf8" }).trim();
    } catch {
      console.error(
        `harness:dev — could not resolve ${JSON.stringify(cmd)} on $PATH. ` +
          `Declare an absolute \`entryPoint\` on the ${JSON.stringify(TARGET.name)} ` +
          `[[gateway.harnessTargets]] row in cluster.toml (required under confinement).`,
      );
      process.exit(2);
    }
  }

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
  // /tmp is a symlink to /private/tmp on macOS; grant both so a harness that
  // writes to the literal /tmp path (claude's runtime dir) isn't denied.
  const sysRw = ["/dev", "/tmp", "/private/tmp", "/private/var/folders"];
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
    // §7 confinement commitment (cloister-c80953): the runner verifies, BEFORE
    // Sandbox::apply, that this manifest matches the digest committed in dev's
    // identity cert — fail-closed on drift. Same manifest the minter digested.
    confinement: {
      manifest: CONFINEMENT_MANIFEST,
      cert_der_b64url: dev.certDerB64Url,
      master_pub_b64std: dev.masterPubB64Std,
    },
    // Credentials never enter the confined env — cloister injects at the proxy.
    env_strip: TARGET.stripEnv,
    env_set: { [TARGET.baseUrlEnv]: BASE_URL },
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
  console.error(`  export ${TARGET.baseUrlEnv}="${BASE_URL}"`);
  if (AUDIT) {
    console.error(`  # DO NOT set ${TARGET.stripEnv.join(" / ")} — either leaves your`);
    console.error(`  # Max subscription. Base-URL only keeps the subscription; cloister receipts`);
    console.error(`  # each call (audit, not custody — there's no key to vault).`);
  } else {
    console.error(`  # no ${TARGET.apiKeyEnv} on the harness — the key is vaulted in cloister.`);
  }
  console.error(`  ${TARGET.entryPoint || TARGET.name}`);
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
  try { rmSync(CONFINEMENT_MANIFEST_PATH, { force: true }); } catch { /* best-effort */ }
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
