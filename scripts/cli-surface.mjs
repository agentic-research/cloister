// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CLI surface, declared once.
//
// `printHelp` used to hardcode the command list and docs/reference/ had no CLI
// page at all — so adding `cloister run` meant editing the dispatcher's help by
// hand and the documentation not mentioning the verb at all. Two statements of
// one fact, one of them missing.
//
// This is the single declaration. The help text and docs/reference/cli.md are
// both PROJECTIONS of it, so a new command appears in both or in neither.
//
// ── Why not scrape `--help` ───────────────────────────────────────────────
//
// The obvious shortcut is to spawn each verb with `--help` and capture stdout.
// It is wrong in three ways: it derives documentation from BEHAVIOUR rather than
// both from a declaration; it puts N subprocess spawns in the lint path; and it
// only works while every `--help` is side-effect free, which is a property that
// has already failed once here (harness-dev.mjs `--help` used to mint a
// credential — cloister-eb33d4). A declaration cannot have that bug.
//
// ── Why plain data, not zod (yet) ─────────────────────────────────────────
//
// zod is the right layer for VALIDATING parsed argv — types, required, defaults,
// refinements — and cli-run.mjs currently does that by hand. But the shape a
// documentation emitter needs, and the shape a future schema-bridge emitter
// would consume, is plain declarative data. Keeping this as data means Phase 2
// (ADR-0036: lift the multi-output IR to LLO once proven across ≥2 schemas) can
// consume it without unwrapping a validation library first. Wiring zod in as the
// argv validator is the natural next step and does not change this shape.
//
// ── Colour lives in the renderer ──────────────────────────────────────────
//
// No chalk here. Colour is a property of the help PROJECTION, not of a command's
// identity — the docs emitter has to get clean markdown from the same source.

/**
 * The env-var contract between `cloister run` and the harness launcher.
 *
 * These names were string literals in TWO files with nothing pairing them:
 * cli-run.mjs wrote them, harness-dev.mjs read them. Rename either side and
 * `cloister run --repo X` silently confines to process.cwd() instead of X — the
 * wrong tree, with every test still green, because a test that only checks the
 * CLI SETS a variable cannot notice the consumer stopped reading it.
 *
 * Declared here so both sides reference one definition, and railed by
 * scripts/test/cli-surface.test.mjs asserting the consumer still honours it.
 * The process boundary between them is a separate concern (cloister-d8599e);
 * this is the part that drifts silently.
 */
export const HARNESS_ENV = Object.freeze({
  /** Absolute path the harness is confined to — the ONLY writable surface. */
  workdir: "HARNESS_WORKDIR",
  workdirs: "HARNESS_WORKDIRS",
  /** Selects the confinement provider. */
  sandbox: "SANDBOX",
  /** The only provider harness-dev.mjs implements. */
  sandboxProvider: "nono",
  /**
   * Absolute path to the harness executable, per-machine.
   *
   * Under confinement there is no $PATH inside the sandbox, so the binary must
   * be named by absolute path. `entryPoint` on the harnessTargets row is the
   * DECLARED form — but the path is machine-local
   * (`/Users/me/.local/bin/claude` is not a fact about the cluster), so
   * committing it to a shared manifest would be wrong. This is the
   * per-invocation rung of the ladder the launcher already implements:
   *
   *     HARNESS_CMD  >  TARGET.entryPoint  >  TARGET.name ($PATH, unconfined only)
   */
  harnessBin: "HARNESS_CMD",
  /**
   * JSON array of arguments passed through to the harness itself.
   *
   * Needed for any non-interactive run: with no TTY inside the sandbox, claude
   * defaults to --print and exits asking for a prompt. Everything after `--` on
   * the cloister run line lands here, which is what makes an ephemeral attested
   * run scriptable rather than interactive-only.
   */
  harnessArgs: "HARNESS_ARGS",
});

/**
 * @typedef {{flag: string, value?: string, summary: string, required?: boolean}} Flag
 * @typedef {{name: string, usage: string, summary: string, detail?: string,
 *            flags?: Flag[], seeAlso?: string}} Command
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: "run",
    usage: "cloister run --harness <name> --repo <abs> [--repo <abs> …] [-- <harness args...>]",
    summary: "Run a harness confined to the repos you name",
    detail:
      "Executes a harness with the named repositories as its ONLY readable and " +
      "writable paths. Every other path is kernel-denied — `~/.ssh`, other " +
      "repositories, and outbound network — with EPERM rather than ENOENT, so " +
      "the boundary does not leak whether a path exists. Loopback to cloister " +
      "stays open, which is what makes cloister the only route tools arrive by.\n\n" +
      "`--repo` repeats. The first is the primary workspace and becomes the " +
      "harness's working directory. WHICH repos you name does not change the " +
      "attested confinement digest — the manifest holds symbolic paths — but HOW " +
      "MANY does, because more writable roots is a wider boundary and the cert " +
      "commits to the shape.",
    flags: [
      { flag: "--repo", value: "<abs>", required: true,
        summary: "a directory the harness may read and write; repeat for more, and the first is the primary (the harness's cwd). Must be absolute — a relative path is rejected rather than resolved against the current directory, because the confinement boundary is not something to infer. Duplicate or nested paths are refused: they would make the attested shape claim more roots than the confinement has" },
      { flag: "--harness", value: "<name>", summary: "harness to launch (default: the declared default target)" },
      { flag: "--dry-run", summary: "print what would be confined; mint nothing, launch nothing" },
      { flag: "--setup-only", summary: "mint the identity and write .dev.vars, do not launch" },
      { flag: "--audit", summary: "forward harness auth and emit a receipt; no key vaulted" },
      { flag: "--harness-bin", value: "<abs>", summary: "absolute path to the harness executable. Required under confinement when the target declares no entryPoint, because there is no $PATH inside the sandbox — and the path is machine-local, so it belongs on the invocation rather than in a shared manifest" },
      { flag: "--no-sandbox", summary: "DANGEROUS: skip kernel confinement (debugging only)" },
      { flag: "--", value: "<args...>", summary: "everything after this is passed to the harness itself. Required for a non-interactive run: with no TTY inside the sandbox the harness has no prompt to read" },
    ],
    seeAlso: "docs/reference/confinement-model.md",
  },
  {
    name: "init",
    usage: "cloister init --recipe <name> --out <dir> [--port N]",
    summary: "Scaffold a cluster recipe",
    flags: [
      { flag: "--recipe", value: "<name>", required: true, summary: "recipe to instantiate" },
      { flag: "--out", value: "<dir>", required: true, summary: "destination directory" },
      { flag: "--port", value: "<N>", summary: "port to expose" },
    ],
  },
  {
    name: "add",
    usage: "cloister add <ref> [--name <name>] [--version <ver>]",
    summary: "Add and resolve a tool input",
    detail:
      "Resolves the ref, records its content digest in cluster.lock.toml, and " +
      "derives the backend declarations from the tool's own server.json. " +
      "Refuses rather than guesses when the input declares no transport.",
    flags: [
      { flag: "--name", value: "<name>", summary: "input name (default: derived from the ref)" },
      { flag: "--version", value: "<ver>", summary: "expected version" },
    ],
  },
  {
    name: "skills list",
    usage: "cloister skills list [--dir <cluster>] [--state-dir <path>]",
    summary: "Show which skills are pinned, unpinned, undeclared, or CHANGED",
    detail:
      "Surveys the harness skills directory against a cluster's " +
      "`[[gateway.skills]]` declarations. Exits non-zero when a PINNED skill's " +
      "bytes no longer match — that is the state worth acting on, and an exit " +
      "code makes it usable from a script.",
    flags: [
      { flag: "--dir", value: "<cluster>", summary: "cluster directory holding cluster.toml (default: the current directory)" },
      { flag: "--state-dir", value: "<path>", summary: "harness state dir; skills are read from <path>/skills (default: ~/.claude)" },
    ],
    seeAlso: "docs/adr/0061-skills-declared-and-verified.md",
  },
  {
    name: "skills pin",
    usage: "cloister skills pin [--dir <cluster>] [--write] [--force]",
    summary: "Emit [[gateway.skills]] declarations with current digests",
    detail:
      "Prints the declarations to paste into cluster.toml. Pinning is an act of " +
      "TRUST — it says you have looked at these bytes — so it does NOT edit your " +
      "manifest by default: a command that rewrote it silently would turn " +
      "vouching into a keystroke, and the reflex after a failed verification is " +
      "to re-run it.\n\n" +
      "`--write` appends for the first-run case. Skills already pinned are left " +
      "alone; re-pinning one whose bytes CHANGED needs `--force`, because " +
      "adopting an unpinned skill is bookkeeping while changing an existing pin " +
      "is a decision.",
    flags: [
      { flag: "--dir", value: "<cluster>", summary: "cluster directory holding cluster.toml (default: the current directory)" },
      { flag: "--state-dir", value: "<path>", summary: "harness state dir; skills are read from <path>/skills (default: ~/.claude)" },
      { flag: "--write", summary: "append to cluster.toml instead of printing" },
      { flag: "--force", summary: "also re-pin skills whose bytes changed under an existing pin" },
    ],
    seeAlso: "docs/adr/0061-skills-declared-and-verified.md",
  },
  {
    name: "cluster up",
    usage: "cloister cluster up [--dir <path>] [--detach]",
    summary: "Bring a declared cluster up via compose",
    detail:
      "Runs the cluster declared by `cluster.compose.yaml` in --dir (default: " +
      "the current directory), using nerdctl, podman or docker — whichever is " +
      "present, or COMPOSE_CMD if set.\n\n" +
      "A scaffolded cluster includes a small Taskfile, and its `task up` command " +
      "delegates to this CLI command. Both paths therefore use one implementation " +
      "of starting a cluster.",
    flags: [
      { flag: "--dir", value: "<path>", summary: "cluster directory (default: the current directory). Present from the start because the next shape is many cloisters, and a cwd-only verb would foreclose it" },
      { flag: "--detach", summary: "run in the background (compose -d)" },
    ],
  },
  {
    name: "cluster down",
    usage: "cloister cluster down [--dir <path>] [--destroy]",
    summary: "Tear a cluster down, preserving volumes",
    detail:
      "Stops the cluster and KEEPS its volumes. Durable-Object SQLite state " +
      "lives in those volumes, so removing them is unrecoverable and is never " +
      "the default for a routine-looking verb — pass --destroy to opt in.",
    flags: [
      { flag: "--dir", value: "<path>", summary: "cluster directory (default: the current directory)" },
      { flag: "--destroy", summary: "ALSO remove volumes — unrecoverable; DO state lives there" },
    ],
  },
  { name: "artifacts pull", usage: "cloister artifacts pull [options]",
    summary: "Acquire lockfile-pinned OCI artifacts" },
  { name: "runtime plan", usage: "cloister runtime plan <bundle> --workspace <absolute-path> [options]",
    summary: "Emit a fail-closed host launch plan",
    flags: [
      { flag: "--workspace", value: "<abs>", required: true, summary: "workspace the plan is scoped to" },
      { flag: "--control-socket", value: "<path>", summary: "host-runtime control socket" },
      { flag: "--output", value: "<path>", summary: "write the JSON plan here" },
    ] },
  { name: "runtime run", usage: "cloister runtime run <plan>",
    summary: "Run a plan through the krunvm backend" },
  { name: "runtime doctor", usage: "cloister runtime doctor",
    summary: "Check runtime prerequisites and storage" },
  { name: "runtime storage init", usage: "cloister runtime storage init",
    summary: "Create/attach bounded krunvm storage" },
  { name: "runtime storage status", usage: "cloister runtime storage status",
    summary: "Show bounded storage state" },
  { name: "runtime storage gc", usage: "cloister runtime storage gc",
    summary: "Preview or execute safe reclamation" },
];

/**
 * Per-command help, derived.
 *
 * cli-run.mjs used to hardcode its own option list, which is how `--harness-bin`
 * could be declared, documented and parsed while `cloister run --help` did not
 * mention it — the same defect as the top-level list, one level down. Both help
 * texts and the docs page now read from this one declaration.
 *
 * @param {string} name
 * @returns {string}
 */
export function renderCommandHelp(name) {
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) throw new Error(`no declared command ${JSON.stringify(name)}`);
  const lines = [`Usage: ${c.usage}`, "", c.detail ?? c.summary, ""];
  const required = (c.flags ?? []).filter((f) => f.required);
  const optional = (c.flags ?? []).filter((f) => !f.required);
  const width = Math.max(...(c.flags ?? []).map((f) => `${f.flag} ${f.value ?? ""}`.trim().length), 10) + 2;
  const row = (f) => `  ${`${f.flag} ${f.value ?? ""}`.trim().padEnd(width)} ${f.summary}`;
  if (required.length) { lines.push("Required:", ...required.map(row), ""); }
  if (optional.length) { lines.push("Options:", ...optional.map(row), ""); }
  lines.push("  --help".padEnd(width + 2) + " this text — mints nothing, writes nothing", "");
  return lines.join("\n");
}

/** The top-level help text, derived. Colour is applied by the caller, not here. */
export function renderHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 12;
  const lines = ["Usage: cloister <command> [options]", "", "Commands:"];
  for (const c of COMMANDS) {
    lines.push(`  ${`cloister ${c.name} ...`.padEnd(width)} ${c.summary}`);
  }
  lines.push("", "Run `cloister <command> --help` for command-specific options.");
  return lines.join("\n");
}
