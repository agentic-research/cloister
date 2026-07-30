// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness launch pipeline, typed. Three phases with one-way data flow:
//
//   resolvePlan(request)        reads config + stats paths. WRITES NOTHING,
//                               MINTS NOTHING.
//   performSetup(plan)          the ONLY code that mints or writes files.
//   launchSession(plan, setup)  the ONLY code that spawns children.
//
// A phase's input type is the previous phase's output type, and each output
// type has exactly ONE producer. So "launch without minting" and "mint before
// preflight" are not expressible as calls that type-check — the two ordering
// bugs this file exists to make unrepresentable are today enforced only by the
// order of statements in a 426-line script:
//
//   cloister-eb27ae  minted a cert, THEN discovered .env.local was missing,
//                    leaving a stray key per attempt.
//   cloister-eb33d4  --help fell through to the main path and minted.
//
// Types alone do not enforce anything unless something checks them. `scripts/`
// is NOT in the root tsconfig (which covers src/**/*.ts only) and has no
// checkJs, so JSDoc here would be decoration. scripts/lib/harness/tsconfig.json
// turns it on for this directory and `task lint:harness-types` runs it — the
// same shape as tools/harness-shim's standalone tsconfig + lint:shim, which
// exists for exactly this reason.

/** @typedef {0|1|2} ExitCode */

/**
 * Operator-facing misuse: bad flag, unknown target, unsupported mode.
 *
 * Callers map this to exit 2, matching harness-targets.mjs's UsageError
 * convention ("callers exit 2 rather than stack-trace"). resolvePlan re-throws
 * that UsageError as-is so there is one vocabulary, not two.
 */
export class LaunchUsageError extends Error {}

/**
 * A missing prerequisite of the SECURITY-RELEVANT step: .env.local absent, the
 * confine binary unbuildable, the harness executable unresolvable.
 *
 * Thrown from resolvePlan — i.e. BEFORE minting. That is the cloister-eb27ae
 * invariant expressed as an ordering of TYPES rather than an ordering of
 * statements: performSetup cannot run without a LaunchPlan, and a LaunchPlan
 * only exists once every precondition passed.
 *
 * `exitCode` preserves today's observable codes: a missing .env.local exits 1,
 * toolchain and exec-resolution failures exit 2.
 */
export class PreconditionError extends Error {
  /**
   * @param {string} message
   * @param {ExitCode} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "PreconditionError";
    this.exitCode = exitCode;
  }
}

/**
 * Kernel confinement as REQUESTED, before resolution.
 *
 * @typedef {object} SandboxRequest
 * @property {"nono"} provider    The only provider. An unknown string is a
 *                                LaunchUsageError at the bin boundary, so this
 *                                type never carries one.
 * @property {string[]} workdirs  The writable roots, in the order given. The
 *                                FIRST is the primary and becomes the harness's
 *                                cwd, so order is meaningful and is never sorted.
 *                                Absolutized by resolvePlan.
 * @property {string|null} [harnessBin]  Declared executable override.
 * @property {string[]} [harnessArgs]    Passed through to the harness verbatim.
 * @property {string} [stateDir]         Overrides the target's declared state dir.
 * @property {string} [label]            How the door spells a root in errors
 *                                       (`--repo`, `HARNESS_WORKDIRS`), so one
 *                                       validator can speak both vocabularies.
 */

/**
 * What the CALLER wants, before any resolution.
 *
 * Both bins construct one — harness-dev.mjs from argv + process.env, cli-run.mjs
 * from its already-parsed args with no env round-trip. Nothing downstream of
 * this type reads process.argv or process.env, which is what lets `cloister run`
 * call the pipeline directly instead of spawning node to re-parse an
 * environment it just constructed.
 *
 * @typedef {object} LaunchRequest
 * @property {string}      root        Repo root, absolute.
 * @property {string|null} targetName  null ⇒ the declared default target.
 * @property {boolean}     setupOnly
 * @property {boolean}     wantsAudit  --audit was passed explicitly.
 * @property {Record<string, string|undefined>} credentialEnv
 *                                     Where the target's declared key env var is
 *                                     read from, AFTER the target is known —
 *                                     which env var to read is the target's
 *                                     declaration, so the door cannot resolve it
 *                                     in advance without restating that mapping.
 *                                     Both doors pass process.env: an API key is
 *                                     genuinely an operator-supplied environment
 *                                     value, unlike the confinement shape, which
 *                                     is an argument and travels as one.
 * @property {SandboxRequest|null} sandbox  null ⇒ unconfined.
 * @property {string} [shimPort]       Defaults to the declared shim port.
 */

/**
 * Auth, resolved.
 *
 * A tagged union so "custody without a key" is not a representable state. Today
 * that correlation is two independent variables plus a runtime check.
 *
 * @typedef {{mode: "custody", apiKey: string} | {mode: "audit"}} AuthPlan
 */

/**
 * Kernel confinement, fully resolved.
 *
 * THE EXISTENCE of this object means: nono was requested, the confine binary
 * exists, workdir and stateDir are absolute, and the harness executable
 * resolved to an absolute path.
 *
 * There is deliberately no `{enabled: boolean}` — absence (null) is the only
 * "off". A boolean would make "confined run whose provider was never applied"
 * a representable state, which is precisely the failure that would be silent.
 *
 * @typedef {object} SandboxPlan
 * @property {"nono"} provider
 * @property {string} confineBin   Absolute path to cloister-harness; existence-checked.
 * @property {string[]} workdirs   Absolute. The ONLY writable trees, with stateDir.
 *                                 A LIST rather than a string because the count is
 *                                 part of the attested shape: the confinement
 *                                 manifest gains a `workspace.N` entry per extra
 *                                 root, so a cert minted against one root does not
 *                                 satisfy the §7 check for a run confined to five.
 * @property {string} stateDir     Absolute.
 * @property {string} harnessBin   Absolute: declared entryPoint or $PATH-resolved.
 * @property {string[]} harnessArgs
 */

/**
 * Everything setup and launch consume.
 *
 * Produced ONLY by resolvePlan(), which runs every precondition check. So
 * holding a LaunchPlan is proof the preflight passed AND that nothing has been
 * minted or written yet.
 *
 * @typedef {object} LaunchPlan
 * @property {string} root
 * @property {import("../../harness-targets.mjs").HarnessTarget} target
 *                                         The harness-targets.mjs row.
 * @property {any} service                 The vaultProxyServices row.
 * @property {import("../../harness-targets.mjs").SkillDeclaration[]} skills
 *                                         Declared skills, verified BEFORE
 *                                         minting (ADR-0061).
 * @property {AuthPlan} auth
 * @property {SandboxPlan|null} sandbox
 * @property {string} shimPort
 * @property {string} baseUrl
 * @property {boolean} setupOnly
 * @property {object} confinementManifest  The confinement/v1 declaration, built
 *                                         from the plan and NOT yet written.
 */

/**
 * The mint-dev-cert JSON, typed once. It is parsed blind today.
 *
 * @typedef {object} DevIdentity
 * @property {string} peerFp
 * @property {string} masterPubB64Std
 * @property {number} epoch
 * @property {string} certDerB64Url
 * @property {string} ephemeralPrivSeedB64Url
 * @property {string} ephemeralPubB64Url
 */

/**
 * Produced ONLY by performSetup().
 *
 * The proof-token that the identity was minted and .dev.vars + the confinement
 * manifest were written. launchSession() REQUIRES one, so launching without
 * having minted does not type-check. Today that ordering is line numbers.
 *
 * @typedef {object} SetupArtifacts
 * @property {DevIdentity} identity
 * @property {string} devVarsPath
 * @property {string} confinementManifestPath
 * @property {string[]} ephemeralPaths  Everything teardown removes. DATA, so the
 *                                      cleanup cannot drift from what was written
 *                                      — today it is a hand-mirrored rm list.
 */

/**
 * A running launch.
 *
 * The launch phase owns long-lived children and outlives a normal return, which
 * is why it is a handle rather than a promise of a value. `done` resolves when
 * the harness exits; `shutdown()` is idempotent so a signal handler and a
 * natural exit can both call it.
 *
 * @typedef {object} HarnessSession
 * @property {Promise<SessionEnd>} done
 * @property {(end?: SessionEnd) => Promise<void>} shutdown  Idempotent.
 * @property {any|null} confined  The confined child, or null when unconfined.
 *                                Non-null iff plan.sandbox was non-null —
 *                                asserted by rail, since this is the pairing
 *                                whose breakage would be silent.
 * @property {string[]} ephemeralPaths  What shutdown() removed, accumulated at
 *                                      each write site rather than restated.
 */

/**
 * @typedef {object} SessionEnd
 * @property {number|null} code
 * @property {string|null} signal
 */

/**
 * Re-exported so the pipeline's own typedefs can name it without every consumer
 * reaching back into harness-targets.mjs.
 *
 * @typedef {import("../../harness-targets.mjs").HarnessTarget} HarnessTarget
 */

/**
 * Injectable seams, so the pipeline is testable without spawning a toolchain.
 *
 * Every field is optional and defaults to the real thing. A test supplies the
 * two or three it needs; nothing in the pipeline reaches for a global directly.
 *
 * @typedef {object} LaunchDeps
 * @property {Function} [execFileSync]
 * @property {Function} [spawn]
 * @property {(path: string, data: string) => void} [writeFileSync]
 * @property {(path: string, options?: object) => void} [rmSync]
 * @property {(path: string) => boolean} [exists]
 * @property {(message: string) => void} [errLog]
 * @property {(url: string, timeoutMs: number) => Promise<void>} [waitForHealth]
 * @property {(url: string, timeoutMs: number) => Promise<void>} [waitForPort]
 */

export {};
