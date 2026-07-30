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
  /** Selects the confinement provider. */
  sandbox: "SANDBOX",
  /** The only provider harness-dev.mjs implements. */
  sandboxProvider: "nono",
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
    usage: "cloister run --harness <name> --repo <absolute-path>",
    summary: "Run a harness confined to one repo",
    detail:
      "Executes a harness with the named repository as its ONLY readable and " +
      "writable path. Every other path is kernel-denied — `~/.ssh`, other " +
      "repositories, and outbound network — with EPERM rather than ENOENT, so " +
      "the boundary does not leak whether a path exists. Loopback to cloister " +
      "stays open, which is what makes cloister the only route tools arrive by.",
    flags: [
      { flag: "--repo", value: "<abs>", required: true,
        summary: "the ONLY directory the harness may read or write. Must be absolute — a relative path is rejected rather than resolved against the current directory, because the confinement boundary is not something to infer" },
      { flag: "--harness", value: "<name>", summary: "harness to launch (default: the declared default target)" },
      { flag: "--dry-run", summary: "print what would be confined; mint nothing, launch nothing" },
      { flag: "--setup-only", summary: "mint the identity and write .dev.vars, do not launch" },
      { flag: "--audit", summary: "forward harness auth and emit a receipt; no key vaulted" },
      { flag: "--no-sandbox", summary: "DANGEROUS: skip kernel confinement (debugging only)" },
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
