// SPDX-License-Identifier: AGPL-3.0-or-later
//
// harness-targets — the declared harness profiles (cloister-742e19, ADR-0057).
//
// THIS FILE IS THE ONLY LEGAL HOME FOR PROVIDER LITERALS in the harness path.
// `lint:harness-target-literals` asserts that no provider string ("anthropic",
// "api.openai.com", "ANTHROPIC_API_KEY", …) appears in scripts/harness-dev.mjs
// or anywhere else outside this module. If you are about to add one somewhere
// else, add a target here instead.
//
// Why this shape (ADR-0057, "the declaration model"): a harness is a lattice
// PARTICIPANT, not a target the substrate special-cases. Codex and Claude Code
// are two rows here, not two branches in harness-dev.mjs. Adding a third means
// adding a row — no control-flow edit anywhere.
//
// The `service` + `inject` fields are not free-form: they must correspond to a
// `[[gateway.vaultProxyServices]]` entry in cluster.toml, which independently
// declares the same injection strategy for the vault proxy. `validateTarget()`
// is where those two declarations are checked against each other — the harness
// says which service it wants, the manifest says how that service injects, and
// a disagreement is a build-time error rather than a runtime 401.

/**
 * @typedef {object} HarnessTarget
 * @property {string}   service       Vault service name; MUST match a
 *                                    `[[gateway.vaultProxyServices]].name`.
 * @property {string}   upstream      Provider API base the vault proxy forwards to.
 * @property {string}   apiKeyEnv     Env var the operator sets to supply a key
 *                                    (custody mode). Never enters the harness env.
 * @property {string}   baseUrlEnv    Env var the harness reads to find the proxy.
 * @property {"headerNamed"|"authorizationBearer"} inject
 *                                    Injection strategy; MUST match the manifest's
 *                                    `[[gateway.vaultProxyServices]].injection`.
 * @property {string}  [injectHeader] Header name when inject === "headerNamed".
 * @property {string[]} stripEnv      Credential env vars scrubbed before exec, so
 *                                    the confined harness cannot see a key even
 *                                    if the operator exported one.
 * @property {string}   bin           Default executable name.
 * @property {string}   stateDirEnv   Env var overriding the harness state dir.
 * @property {string}   stateDir      State dir relative to $HOME; granted rw
 *                                    under confinement.
 * @property {("custody"|"audit")[]} authModes
 *                                    Supported auth modes. "custody" vaults an
 *                                    API key and injects it. "audit" forwards
 *                                    the harness's own OAuth and receipts the
 *                                    call — only meaningful where the provider
 *                                    sells a subscription the key would replace.
 */

/** @type {Record<string, HarnessTarget>} */
export const TARGETS = {
  "claude-code": {
    service: "anthropic",
    upstream: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    inject: "headerNamed",
    injectHeader: "x-api-key",
    // ANTHROPIC_AUTH_TOKEN is stripped alongside the key: it is the OAuth
    // credential, and leaving it visible would let a confined harness bypass
    // the vault proxy entirely by talking to the provider directly.
    stripEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    bin: "claude",
    stateDirEnv: "CLAUDE_CONFIG_DIR",
    stateDir: ".claude",
    // Audit mode exists here because a Max subscription is worth preserving:
    // setting a key would silently move billing off it (ADR-0040 amendment).
    authModes: ["custody", "audit"],
  },

  codex: {
    service: "openai",
    upstream: "https://api.openai.com",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    inject: "authorizationBearer",
    stripEnv: ["OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"],
    bin: "codex",
    stateDirEnv: "CODEX_HOME",
    stateDir: ".codex",
    // Custody only, deliberately. Audit mode forwards the harness's own OAuth
    // instead of vaulting a key; that is only correct where a subscription
    // would otherwise be bypassed. Declaring ["custody"] makes an
    // unsupported `--audit` a named refusal instead of a silent no-op.
    authModes: ["custody"],
  },
};

export const DEFAULT_TARGET = "claude-code";

/** Target names, sorted — for usage text and error messages. */
export function targetNames() {
  return Object.keys(TARGETS).sort();
}

/**
 * Resolve `--target <name>` (or HARNESS_TARGET) to a declared profile.
 * Unknown names fail loudly and list what is available — an unknown target
 * must never fall back to a default, or an operator typo silently bills the
 * wrong provider.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ name: string, target: HarnessTarget }}
 */
export function resolveTarget(argv, env = process.env) {
  const flagIdx = argv.indexOf("--target");
  let name = env.HARNESS_TARGET ?? DEFAULT_TARGET;
  if (flagIdx !== -1) {
    const value = argv[flagIdx + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`--target needs a value (one of: ${targetNames().join(", ")})`);
    }
    name = value;
  }
  const target = TARGETS[name];
  if (!target) {
    throw new UsageError(`unknown harness target ${JSON.stringify(name)} (declared: ${targetNames().join(", ")})`);
  }
  return { name, target };
}

/**
 * Cross-check a target against the manifest's vaultProxyServices declaration.
 *
 * Two independent statements exist about how a service authenticates: this
 * module's `inject`, and `[[gateway.vaultProxyServices]].injection` in
 * cluster.toml. They must agree. When they disagree the failure mode is a
 * runtime 401 from the provider with no indication which half is wrong — so
 * this collapses it into a build-time error naming both sides.
 *
 * @param {HarnessTarget} target
 * @param {Array<{name: string, injection: string}>} services
 */
export function validateTarget(target, services) {
  const svc = services.find((s) => s.name === target.service);
  if (!svc) {
    throw new UsageError(
      `target declares service ${JSON.stringify(target.service)}, which no ` +
        `[[gateway.vaultProxyServices]] entry declares ` +
        `(available: ${services.map((s) => s.name).sort().join(", ") || "none"})`,
    );
  }

  // `injection` is a TAGGED UNION in the manifest ({headerNamed:{name}} /
  // {authorizationBearer:null}), not a string — same shape as WireTransport.
  // Read the tag rather than comparing to the object, which would always differ.
  const declared = injectionTag(svc.injection);
  if (declared !== target.inject) {
    throw new UsageError(
      `injection mismatch for service ${JSON.stringify(target.service)}: ` +
        `harness target declares ${JSON.stringify(target.inject)}, ` +
        `cluster.toml declares ${JSON.stringify(declared)}`,
    );
  }

  // For headerNamed the HEADER NAME is also declared twice. Injecting under the
  // wrong header is a 401 from the provider with nothing pointing at the cause,
  // so check it here where both halves are in hand.
  if (declared === "headerNamed") {
    const manifestHeader = svc.injection?.headerNamed?.name;
    if (manifestHeader && manifestHeader !== target.injectHeader) {
      throw new UsageError(
        `injection header mismatch for service ${JSON.stringify(target.service)}: ` +
          `harness target declares ${JSON.stringify(target.injectHeader)}, ` +
          `cluster.toml declares ${JSON.stringify(manifestHeader)}`,
      );
    }
  }

  // Upstream is declared in both places too. A harness pointed at one provider
  // while the vault proxy forwards to another is a silent cross-provider leak
  // of whatever credential is vaulted.
  if (svc.upstreamBaseUrl && svc.upstreamBaseUrl !== target.upstream) {
    throw new UsageError(
      `upstream mismatch for service ${JSON.stringify(target.service)}: ` +
        `harness target declares ${JSON.stringify(target.upstream)}, ` +
        `cluster.toml declares ${JSON.stringify(svc.upstreamBaseUrl)}`,
    );
  }
}

/** Tag name of an injection union — accepts the manifest object or a bare string. */
function injectionTag(injection) {
  if (typeof injection === "string") return injection;
  if (injection && typeof injection === "object") return Object.keys(injection)[0];
  return undefined;
}

/**
 * The credential headers for a custody-mode vault seed, derived from the
 * declared injection strategy rather than hardcoded per provider.
 *
 * @param {HarnessTarget} target
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function credentialHeaders(target, apiKey) {
  if (target.inject === "authorizationBearer") {
    return { Authorization: `Bearer ${apiKey}` };
  }
  if (!target.injectHeader) {
    throw new UsageError(`target with inject="headerNamed" must declare injectHeader`);
  }
  return { [target.injectHeader]: apiKey };
}

/**
 * Read `[[gateway.vaultProxyServices]]` from the operator surface.
 *
 * Deliberately parses cluster.toml rather than importing
 * src/generated/cluster.ts: `task harness:dev` runs under plain `node`, and
 * making the turnkey path depend on tsx to validate a config field would add a
 * toolchain requirement to the one command meant to Just Work. cluster.toml is
 * also the surface an operator edits, so a mismatch is reported against what
 * they actually changed.
 *
 * @param {string} clusterTomlPath
 * @returns {Array<{name: string, injection: unknown, upstreamBaseUrl?: string}>}
 */
export async function loadVaultProxyServices(clusterTomlPath) {
  const { readFileSync } = await import("node:fs");
  const TOML = (await import("@iarna/toml")).default;
  const parsed = TOML.parse(readFileSync(clusterTomlPath, "utf8"));
  return parsed?.gateway?.vaultProxyServices ?? [];
}

/** Thrown for operator-facing misuse; callers exit 2 rather than stack-trace. */
export class UsageError extends Error {}
