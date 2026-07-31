// SPDX-License-Identifier: AGPL-3.0-or-later
//
// harness-targets — read the declared harness profiles (cloister-742e19, ADR-0057).
//
// The profiles themselves live in `cluster.toml` under
// `[[gateway.harnessTargets]]`, projected through manifest/cluster.capnp like
// every other operator-facing declaration. This module only READS them.
//
// Why not a table in this file: cloister's rule is that operator configuration
// goes in the manifest, not in code ("hand-coded route registration goes in the
// manifest, not in TS"). A JS table would be a second config surface an
// operator cannot reach without editing JavaScript — the same defect as the
// hardcoded constants it replaced, one file over. Adding a third harness is a
// TOML row.
//
// What a target deliberately does NOT declare: upstream URL and injection
// strategy. Those belong to the vault service (`[[gateway.vaultProxyServices]]`)
// and are read from there via `service`. Restating them would create two
// statements of one fact that can disagree — which is exactly the class of
// defect this substrate keeps finding.

/**
 * A skill admitted to the trust boundary (ADR-0061). Verified at LOAD — the
 * skills dir stays writable because nono grants are a union, not an
 * intersection, so a substituted skill fails the NEXT run.
 *
 * @typedef {object} SkillDeclaration
 * @property {string} name    directory under the harness skills dir
 * @property {string} digest  `sha256:<hex>`; empty ⇒ declared but UNPINNED
 */

/**
 * @typedef {object} HarnessTarget
 * @property {string}   name        `--target <name>` selector.
 * @property {string}   service     Vault service; names a vaultProxyServices entry.
 * @property {string}   entryPoint  Absolute path to the executable. Empty ⇒ resolve
 *                                  `name` on $PATH (convenience only; unavailable
 *                                  under confinement, which execs by path).
 * @property {string}   executable  Binary NAME when it differs from `name`
 *                                  (claude-code's binary is `claude`). Empty ⇒
 *                                  use `name`. Distinct from entryPoint, which
 *                                  is absolute. Per ADR-0060.
 * @property {string}   apiKeyEnv   Env var supplying a key in custody mode.
 * @property {string}   baseUrlEnv  Env var the harness reads for the proxy URL.
 * @property {string[]} stripEnv    Credential env vars scrubbed before exec.
 * @property {string}   stateDirEnv Env var overriding the state dir.
 * @property {string}   stateDir    State dir relative to $HOME.
 * @property {string[]} authModes   "custody" and/or "audit".
 */

/** Thrown for operator-facing misuse; callers exit 2 rather than stack-trace. */
export class UsageError extends Error {}

export const DEFAULT_TARGET = "claude-code";

/**
 * Load `[[gateway.harnessTargets]]` + `[[gateway.vaultProxyServices]]` from the
 * operator surface.
 *
 * Parses cluster.toml rather than importing src/generated/cluster.ts because
 * `task harness:dev` runs under plain `node` — making the turnkey path require
 * tsx to read one field would add a toolchain dependency to the single command
 * meant to just work. cluster.toml is also what the operator edits, so errors
 * name the file they changed.
 *
 * @param {string} clusterTomlPath
 * @returns {Promise<{targets: HarnessTarget[], services: any[], skills: SkillDeclaration[]}>}
 */
export async function loadHarnessConfig(clusterTomlPath) {
  const { readFileSync } = await import("node:fs");
  // Named import, not `.default` — smol-toml has no default export, and a
  // dynamic import like this is invisible to a grep for `from "…"`, which is
  // exactly how it survived the migration sweep and failed only at runtime.
  const { parse: parseToml } = await import("smol-toml");
  // The TOML parser returns AnyJson; the shape below is cluster.toml's declared
  // gateway block, checked for real by `task cluster:toml` on the way in.
  const parsed = /** @type {any} */ (parseToml(readFileSync(clusterTomlPath, "utf8")));
  const gateway = parsed?.gateway ?? {};
  return {
    targets: gateway.harnessTargets ?? [],
    services: gateway.vaultProxyServices ?? [],
    // ADR-0061 — declared skills, verified at load by verifySkills().
    skills: gateway.skills ?? [],
  };
}

/**
 * Declared target names, sorted — for usage text and error messages.
 * @param {HarnessTarget[]} targets
 */
export function targetNames(targets) {
  return targets.map((t) => t.name).sort();
}

/**
 * Resolve `--target <name>` (or HARNESS_TARGET) against the declared set.
 *
 * An unknown name fails and lists what is declared. It must never fall back to
 * a default: a typo would silently launch a different provider and bill the
 * wrong account with nothing indicating anything was wrong.
 *
 * @param {HarnessTarget[]} targets
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 * @returns {HarnessTarget}
 */
export function resolveTarget(targets, argv, env = process.env) {
  if (targets.length === 0) {
    throw new UsageError(
      "no harness targets declared — add a [[gateway.harnessTargets]] entry to cluster.toml",
    );
  }
  const flagIdx = argv.indexOf("--target");
  let name = env.HARNESS_TARGET ?? DEFAULT_TARGET;
  if (flagIdx !== -1) {
    const value = argv[flagIdx + 1];
    if (!value || value.startsWith("--")) {
      throw new UsageError(`--target needs a value (declared: ${targetNames(targets).join(", ")})`);
    }
    name = value;
  }
  const target = targets.find((t) => t.name === name);
  if (!target) {
    throw new UsageError(
      `unknown harness target ${JSON.stringify(name)} (declared: ${targetNames(targets).join(", ")})`,
    );
  }
  return target;
}

/**
 * The vault service a target authenticates through.
 *
 * This is the only cross-reference left: the target names a service, the
 * service owns upstream + injection. There is nothing to reconcile because
 * nothing is stated twice.
 *
 * @param {HarnessTarget} target
 * @param {any[]} services
 */
export function serviceFor(target, services) {
  const svc = services.find((s) => s.name === target.service);
  if (!svc) {
    throw new UsageError(
      `harness target ${JSON.stringify(target.name)} names service ` +
        `${JSON.stringify(target.service)}, which no [[gateway.vaultProxyServices]] ` +
        `entry declares (available: ${services.map((s) => s.name).sort().join(", ") || "none"})`,
    );
  }
  return svc;
}

/**
 * Credential headers for a custody-mode vault seed, derived from the SERVICE's
 * declared injection strategy.
 *
 * In cluster.toml the strategy is a string tag with its parameters in a sibling
 * table (`injection = "headerNamed"` + `[gateway.vaultProxyServices.headerNamed]
 * name = "x-api-key"`). In the generated manifest the same thing is a tagged
 * union object. Both shapes are accepted so this works against either surface.
 *
 * @param {any} service
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function credentialHeaders(service, apiKey) {
  const tag = typeof service.injection === "string"
    ? service.injection
    : Object.keys(service.injection ?? {})[0];

  if (tag === "authorizationBearer") return { Authorization: `Bearer ${apiKey}` };
  if (tag === "headerNamed") {
    const header = service.headerNamed?.name ?? service.injection?.headerNamed?.name;
    if (!header) {
      throw new UsageError(
        `service ${JSON.stringify(service.name)} declares injection "headerNamed" ` +
          `but no header name`,
      );
    }
    return { [header]: apiKey };
  }
  throw new UsageError(
    `service ${JSON.stringify(service.name)} declares injection ${JSON.stringify(tag)}, ` +
      `which the harness path does not support (expected headerNamed or authorizationBearer)`,
  );
}
