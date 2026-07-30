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
// ── This file is a DOOR, not the room ─────────────────────────────────────
//
// The orchestration above lives in scripts/lib/harness/launch.mjs. This file
// translates argv + process.env into a LaunchRequest and maps thrown errors to
// exit codes. That is the whole job.
//
// It used to BE the orchestration, which meant `cloister run` could only
// re-launch it — serializing its parsed flags back into environment variables
// and spawning node to re-parse them. Reading process.env here and nowhere
// downstream is what makes the environment an operator interface
// (`SANDBOX=nono task harness:dev`) rather than a channel cloister uses to talk
// to itself.
//
// WHICH harness is a declared profile: `--target claude-code | codex` selects a
// row in scripts/harness-targets.mjs, and every provider-specific value comes
// from that row. No provider literals here — `lint:harness-target-literals`
// enforces it, so adding a third harness is a new row and no edit to this path.
// Per cloister-742e19 + ADR-0057.
//
// The API key comes from the target's declared key env var. It is written to
// .dev.vars (gitignored) as the vault seed and injected INSIDE the vault DO —
// never into the harness's environment. Everything here is dev-only +
// runtime-only; lint:no-dev-mode forbids any of it in committed config.
//
// Prereq: run `task dev:bootstrap` once (writes .env.local with VAULT_KEK_SOURCE
// for the local vault). `--setup-only` mints + writes .dev.vars without
// launching (used by the setup test).

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHarnessConfig, targetNames } from "./harness-targets.mjs";
import { launch, LaunchUsageError, PreconditionError } from "./lib/harness/launch.mjs";
import { HARNESS_ENV } from "./cli-surface.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── --help, before ANY side effect (cloister-eb33d4) ──────────────────────
//
// `--help` used to fall through to the main path, so asking what the command
// does MINTED AN EPHEMERAL DEV MASTER AND CERT and wrote .dev.vars. `--help` is
// what you type when you do not yet know what something does; making it the most
// side-effectful path inverts that, and the side effect was minting a credential.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    `harness:dev — launch a harness against a local cloister, kernel-confined.\n\n` +
    `  --target <name>   harness to launch (default: the declared DEFAULT_TARGET)\n` +
    `  --setup-only      mint the dev identity + write .dev.vars, do not launch\n` +
    `  --audit           forward harness auth and emit a receipt; no key vaulted\n` +
    `  --help            this text — mints nothing, writes nothing\n\n` +
    `  SANDBOX=nono      apply the declared default-deny confinement profile\n` +
    `  ${HARNESS_ENV.workdirs}  JSON array of writable roots (first is the harness cwd)\n` +
    `  ${HARNESS_ENV.workdir}   single writable root; the one-path spelling\n\n` +
    `Prereq: \`task dev:bootstrap\` once (writes .env.local). Checked before minting.\n` +
    `Or, first-party: \`cloister run --harness <name> --repo <abs> [--repo <abs> …]\`\n`,
  );
  process.exit(0);
}

/**
 * The writable roots, from the operator's environment.
 *
 * HARNESS_WORKDIRS (JSON array) is authoritative; HARNESS_WORKDIR is the
 * single-path spelling that predates it and still works on its own. When both
 * are set they must AGREE on the primary — a disagreement is refused rather than
 * resolved, because either choice silently confines the harness to a tree the
 * caller did not name, and that failure looks exactly like success.
 */
export function workdirsFromEnv(env = process.env) {
  const one = env[HARNESS_ENV.workdir];
  const many = env[HARNESS_ENV.workdirs];
  if (!many) return [resolve(one ?? process.cwd())];

  let parsed;
  try {
    parsed = JSON.parse(many);
  } catch (e) {
    throw new LaunchUsageError(`${HARNESS_ENV.workdirs} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((p) => typeof p !== "string")) {
    throw new LaunchUsageError(
      `${HARNESS_ENV.workdirs} must be a non-empty JSON array of paths.`,
    );
  }
  const dirs = parsed.map((p) => resolve(p));
  if (one && resolve(one) !== dirs[0]) {
    throw new LaunchUsageError(
      `${HARNESS_ENV.workdir} (${resolve(one)}) disagrees with the first ` +
      `${HARNESS_ENV.workdirs} entry (${dirs[0]}). Refusing rather than picking: the ` +
      `primary workspace is the harness's cwd and is not something to guess.`,
    );
  }
  return dirs;
}

/** argv + env → LaunchRequest. The only place either is read. */
export function requestFromEnv(argv = process.argv, env = process.env) {
  const sandboxProvider = env[HARNESS_ENV.sandbox] ?? "";
  if (sandboxProvider && sandboxProvider !== HARNESS_ENV.sandboxProvider) {
    throw new LaunchUsageError(
      `unknown SANDBOX provider ${JSON.stringify(sandboxProvider)} ` +
      `(supported: ${HARNESS_ENV.sandboxProvider}).`,
    );
  }
  const targetIdx = argv.indexOf("--target");
  return {
    root: ROOT,
    targetName: targetIdx >= 0 ? argv[targetIdx + 1] ?? null : null,
    setupOnly: argv.includes("--setup-only"),
    wantsAudit: argv.includes("--audit"),
    credentialEnv: env,
    shimPort: env.HARNESS_SHIM_PORT ?? undefined,
    sandbox: sandboxProvider
      ? {
          provider: HARNESS_ENV.sandboxProvider,
          workdirs: workdirsFromEnv(env),
          // So a duplicate/nested pair reported by the shared validator names
          // what the operator actually typed, not the CLI's flag.
          label: HARNESS_ENV.workdirs,
          harnessBin: env[HARNESS_ENV.harnessBin] || null,
          harnessArgs: env[HARNESS_ENV.harnessArgs] ? JSON.parse(env[HARNESS_ENV.harnessArgs]) : [],
        }
      : null,
  };
}

/**
 * Map a thrown pipeline error to the exit code and message this bin has always
 * produced. One vocabulary: LaunchUsageError → 2, PreconditionError → its own
 * code, anything else rethrows with a stack.
 */
export async function runBin(request, deps = {}) {
  const errLog = deps.errLog ?? ((m) => process.stderr.write(`${m}\n`));
  try {
    const { session } = await launch(request, { ...deps, errLog });
    if (!session) return 0;

    // shutdown() is idempotent, so a signal and a natural child exit can both
    // reach it — which they do, and used to double-kill.
    const onSignal = () => { void session.shutdown(); };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const end = await session.done;
    return end.code ?? 0;
  } catch (err) {
    if (err instanceof LaunchUsageError) {
      errLog(`harness:dev — ${err.message}`);
      try {
        const cfg = await loadHarnessConfig(resolve(request.root, "cluster.toml"));
        if (cfg.targets.length) {
          errLog(`  usage: task harness:dev -- --target <${targetNames(cfg.targets).join("|")}>`);
        }
      } catch { /* lint-allow-silent: the usage hint is a nicety; the error above is the report */ }
      return 2;
    }
    if (err instanceof PreconditionError) {
      errLog(`harness:dev — ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let request;
  try {
    request = requestFromEnv();
  } catch (e) {
    process.stderr.write(`harness:dev — ${e.message}\n`);
    process.exit(2);
  }
  const code = await runBin(request);
  if (code !== null) process.exit(code);
}
