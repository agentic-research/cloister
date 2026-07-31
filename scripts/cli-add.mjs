#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scripts/cli-add.mjs — `cloister add <ref>` subcommand
// (cloister-66b6a6 / ADR-0026 Phase 2 subpiece 2).
//
// Adds a new [inputs.<name>] block to cluster.toml + runs the
// resolver so cluster.lock.toml stays consistent. Two-step write:
// (a) parse + mutate + serialize cluster.toml, (b) invoke
// resolveInput to compute sha256 + write cluster.lock.toml. If the
// resolve step fails, cluster.toml is left mutated — operator can
// re-run the resolver after correcting the ref, or `git checkout
// cluster.toml` to roll back.
//
// Usage:
//   cloister add <ref> [--name <name>] [--version <ver>]
//                       [--provides <cap>...] [--requires <cap>...]
//
// Examples:
//   cloister add github://anthropic/skills@main
//     → name auto-derived to "skills"; whole-repo tarball pinned.
//   cloister add github://anthropic/skills/python-bridge.md@v1.2.0 \
//                --name python-bridge --provides cloister/skill/v1
//     → single-file fetch + explicit interface declaration.
//   cloister add file:///abs/path/to/skill --name local-skill
//     → local-filesystem dev override.
//
// Exit codes per ADR-0026 implementation convention:
//   0 — added + resolved cleanly.
//   1 — duplicate input name OR resolve failed.
//   2 — usage error (missing ref, malformed args, cluster.toml absent).
//
// Per cloister-66b6a6.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { resolveInput, buildLockfile } from "./resolve-inputs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

// Read env at function-call time (not module-load time) so tests can
// override CLOISTER_CLUSTER_TOML / CLOISTER_LOCKFILE after importing.
function clusterTomlPath() {
  return process.env.CLOISTER_CLUSTER_TOML
    ? resolvePath(process.env.CLOISTER_CLUSTER_TOML)
    : resolvePath(REPO_ROOT, "cluster.toml");
}

function lockfilePath() {
  return process.env.CLOISTER_LOCKFILE
    ? resolvePath(process.env.CLOISTER_LOCKFILE)
    : resolvePath(REPO_ROOT, "cluster.lock.toml");
}

class UsageError extends Error {}
class AddError extends Error {}

// ── Argument parsing ────────────────────────────────────────────────────

/**
 * Parse the `cloister add` flag set. Hand-rolled (matches the style
 * of scripts/cli-init.mjs); the surface is small enough that a
 * yargs/commander dep would cost more than it saves.
 *
 * Shape:
 *   <ref>                        positional, required
 *   --name <s>                   optional, defaults to deriveName(ref)
 *   --version <s>                optional, defaults to ""
 *   --provides <s> (repeatable)  optional, lane-3 capability names
 *   --requires <s> (repeatable)  optional, lane-3 capability names
 *
 * Exported for unit tests.
 */
export function parseArgs(argv) {
  const args = {
    ref:      "",
    name:     "",
    version:  "",
    provides: /** @type {string[]} */ ([]),
    requires: /** @type {string[]} */ ([]),
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      throw new UsageError("__HELP__");
    } else if (a === "--name") {
      args.name = mustValue(argv, ++i, "--name");
    } else if (a === "--version") {
      args.version = mustValue(argv, ++i, "--version");
    } else if (a === "--provides") {
      args.provides.push(mustValue(argv, ++i, "--provides"));
    } else if (a === "--requires") {
      args.requires.push(mustValue(argv, ++i, "--requires"));
    } else if (a.startsWith("-")) {
      throw new UsageError(`unknown flag: ${a}`);
    } else if (args.ref === "") {
      args.ref = a;
    } else {
      throw new UsageError(`unexpected positional argument: ${a} (only one <ref> allowed)`);
    }
    i++;
  }
  if (args.ref === "") {
    throw new UsageError("missing required <ref> positional argument");
  }
  if (args.name === "") {
    args.name = deriveName(args.ref);
  }
  if (args.name === "") {
    throw new UsageError(
      `could not derive --name from ref ${JSON.stringify(args.ref)}; ` +
      `pass --name <name> explicitly`,
    );
  }
  return args;
}

function mustValue(argv, idx, flag) {
  if (idx >= argv.length) throw new UsageError(`${flag} requires a value`);
  return argv[idx];
}

/**
 * Derive a default input name from a ref. Examples:
 *   github://anthropic/skills@main                   → "skills"
 *   github://anthropic/skills/python-bridge.md@main  → "python-bridge"
 *   file:///abs/path/to/skill.md                     → "skill"
 *   https://example.com/foo/bar.tar.gz               → "bar"
 *
 * Returns "" if no usable name fell out; the caller demands an
 * explicit --name in that case.
 *
 * Exported for unit tests.
 */
export function deriveName(ref) {
  if (typeof ref !== "string" || ref.length === 0) return "";

  // Strip scheme + leading authority.
  let rest;
  if (ref.startsWith("github://")) {
    rest = ref.slice("github://".length);
    // Strip @<git-ref> suffix.
    const atIdx = rest.lastIndexOf("@");
    if (atIdx !== -1) rest = rest.slice(0, atIdx);
    // github://owner/repo[/path]
    const parts = rest.split("/");
    if (parts.length < 2) return "";
    if (parts.length === 2) {
      // Whole-repo ref → use repo name.
      return stripExtension(parts[1]);
    }
    // Path within repo → use basename without extension.
    return stripExtension(parts[parts.length - 1]);
  }

  if (ref.startsWith("file://") || ref.startsWith("https://") || ref.startsWith("http://")) {
    // Trim trailing slash, take basename.
    const cleaned = ref.replace(/\/+$/, "");
    const idx = cleaned.lastIndexOf("/");
    if (idx === -1 || idx === cleaned.length - 1) return "";
    return stripExtension(cleaned.slice(idx + 1));
  }

  return "";
}

/**
 * Strip common archive/file extensions from a basename. `foo.tar.gz` →
 * `foo`; `bar.md` → `bar`; `baz` → `baz`. Removes at most two
 * dot-extensions to handle `.tar.gz` / `.tar.xz`.
 */
function stripExtension(name) {
  let out = name;
  for (let pass = 0; pass < 2; pass++) {
    const dot = out.lastIndexOf(".");
    if (dot <= 0) break; // dot at position 0 = hidden file like .gitignore; keep
    const ext = out.slice(dot + 1);
    if (ext.length === 0 || ext.length > 6) break; // implausible extension
    out = out.slice(0, dot);
  }
  return out;
}

// ── cluster.toml mutation ───────────────────────────────────────────────

/**
 * Mutate the cluster.toml document body to add a new [inputs.<name>]
 * block. Returns the new TOML string. Throws AddError if the named
 * input already exists.
 *
 * Exported for unit tests.
 */
export function addInputToClusterToml(tomlString, name, spec) {
  let parsed;
  try {
    parsed = parseToml(tomlString);
  } catch (e) {
    throw new AddError(`failed to parse cluster.toml: ${e.message}`);
  }

  if (!parsed.inputs) parsed.inputs = {};
  if (parsed.inputs[name] !== undefined) {
    throw new AddError(
      `input "${name}" already exists in cluster.toml ` +
      `(edit the [inputs.${name}] block directly, or pick a different --name)`,
    );
  }

  const entry = {
    ref:      spec.ref,
    version:  spec.version ?? "",
    digest:   "",
    from:     "",
    provides: spec.provides ?? [],
    requires: spec.requires ?? [],
  };
  parsed.inputs[name] = entry;

  return stringifyToml(parsed);
}

// ── Entry ───────────────────────────────────────────────────────────────

function printHelp(log) {
  log("Usage: cloister add <ref> [--name <name>] [--version <ver>]");
  log("                          [--provides <cap>...] [--requires <cap>...]");
  log("");
  log("Add an input to cluster.toml and resolve it into cluster.lock.toml.");
  log("");
  log("Positional:");
  log("  <ref>                  Required. file://, https://, or github://owner/repo[/path]@<ref>");
  log("");
  log("Options:");
  log("  --name <name>          Input name (default: derived from <ref> basename)");
  log("  --version <ver>        Semver range or exact version (default: \"\")");
  log("  --provides <cap>       Capability this input PROVIDES (repeatable); lane-3");
  log("                         shape per ADR-0028 (cloister/<name>/v<n>)");
  log("  --requires <cap>       Capability this input REQUIRES (repeatable)");
  log("  -h, --help             Show this help");
  log("");
  log("Examples:");
  log("  cloister add github://anthropic/skills@main");
  log("  cloister add github://anthropic/skills/python-bridge.md@v1.2.0 \\");
  log("               --name python-bridge --provides cloister/skill/v1");
  log("  cloister add file:///abs/path/to/skill --name local-skill");
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError && e.message === "__HELP__") {
      printHelp((s) => console.log(s));
      return 0;
    }
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      console.error("");
      printHelp((s) => console.error(s));
      return 2;
    }
    throw e;
  }

  const clusterPath = clusterTomlPath();
  const lockPath = lockfilePath();

  if (!existsSync(clusterPath)) {
    console.error(`error: cluster.toml not found at ${clusterPath}`);
    return 2;
  }

  let mutated;
  try {
    const raw = readFileSync(clusterPath, "utf8");
    mutated = addInputToClusterToml(raw, opts.name, {
      ref:      opts.ref,
      version:  opts.version,
      provides: opts.provides,
      requires: opts.requires,
    });
  } catch (e) {
    if (e instanceof AddError) {
      console.error(`cloister add: ${e.message}`);
      return 1;
    }
    throw e;
  }

  writeFileSync(clusterPath, mutated);
  console.log(`cloister add: added [inputs.${opts.name}] to ${clusterPath}`);

  // Resolve the new input + refresh the lockfile. If this fails the
  // cluster.toml mutation stays — operator can re-run after fixing the
  // ref, or `git checkout cluster.toml` to roll back.
  try {
    await resolveAllAndWriteLockfile(mutated, lockPath);
    console.log(`cloister add: ${opts.name} resolved; wrote ${lockPath}`);
    return 0;
  } catch (e) {
    console.error(`cloister add: resolve failed: ${e.message}`);
    console.error(
      `  cluster.toml was mutated; either fix the ref + re-run \`task verify\`,`,
    );
    console.error(`  or roll back with \`git checkout ${clusterPath}\`.`);
    return 1;
  }
}

/**
 * Resolve every input in the (already-mutated) cluster.toml body and
 * write cluster.lock.toml. Mirrors the body of scripts/resolve-inputs.mjs
 * main() without re-reading the file from disk (defensive: read once,
 * use the same bytes for both mutation and resolution).
 */
async function resolveAllAndWriteLockfile(tomlString, lockPath) {
  const parsed = parseToml(tomlString);
  const metadata = parsed.metadata ?? { name: "unknown", version: "0.0.0" };
  const inputsTable = parsed.inputs ?? {};
  const specs = Object.entries(inputsTable).map(([name, spec]) => ({
    name,
    ref:            typeof spec.ref            === "string" ? spec.ref            : "",
    version:        typeof spec.version        === "string" ? spec.version        : "",
    digest:         typeof spec.digest         === "string" ? spec.digest         : "",
    from:           typeof spec.from           === "string" ? spec.from           : "",
    // urlBinding / serviceBinding pass through to generated_backends
    // rows (cloister-cb7263, P3).
    urlBinding:     typeof spec.urlBinding     === "string" ? spec.urlBinding     : "",
    serviceBinding: typeof spec.serviceBinding === "string" ? spec.serviceBinding : "",
    provides:       Array.isArray(spec.provides) ? spec.provides : [],
    requires:       Array.isArray(spec.requires) ? spec.requires : [],
  }));

  const resolved = [];
  for (const spec of specs) {
    const row = await resolveInput(spec);
    resolved.push(row);
  }
  const doc = buildLockfile(metadata, resolved);
  writeFileSync(lockPath, stringifyToml(doc));
}

// Run when invoked as a script (not when imported by tests).
const invokedAsScript = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`cloister add: unexpected error: ${e.message}`);
      process.exit(2);
    },
  );
}
