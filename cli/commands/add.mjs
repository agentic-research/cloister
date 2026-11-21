#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `cloister add <ref>` subcommand
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

import { resolveInput, buildLockfile } from "../lib/cluster/resolve-inputs.mjs";
import { writeLockfile } from "../lib/cluster/lockfile.mjs";
import { startedAsScript } from "../lib/started-as-script.mjs";
import { FlagsError, parseFlags } from "../lib/flags.mjs";
import { helpFor } from "../help.mjs";
import { renderCommandHelp } from "../surface.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../..");

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
 * Parse `cloister add`'s arguments from its declaration in cli/surface.mjs
 * (cli/lib/flags.mjs, ADR-0077 Part 3): the required `<ref>`, `--name`,
 * `--version`, and the repeatable `--provides` and `--requires`. Anything else
 * is refused by name, as a UsageError. `--name` defaults to a name derived from
 * the ref, and is required when none can be.
 *
 * Exported for unit tests.
 */
export function parseArgs(argv) {
  let flags;
  try {
    flags = parseFlags("add", argv);
  } catch (error) {
    if (error instanceof FlagsError) throw new UsageError(error.message);
    throw error;
  }
  const args = {
    ref:      flags.ref,
    name:     flags.name ?? "",
    version:  flags.version ?? "",
    provides: flags.provides,
    requires: flags.requires,
  };
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

export async function main(argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const errLog = deps.errLog ?? ((line) => console.error(line));
  // Help is the declaration's (cli/help.mjs), however main is reached.
  const help = helpFor(["add", ...argv]);
  if (help !== undefined) {
    log(help);
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      errLog(`error: ${e.message}`);
      errLog("");
      errLog(renderCommandHelp("add"));
      return 2;
    }
    throw e;
  }

  const clusterPath = clusterTomlPath();
  const lockPath = lockfilePath();

  if (!existsSync(clusterPath)) {
    errLog(`error: cluster.toml not found at ${clusterPath}`);
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
      errLog(`cloister add: ${e.message}`);
      return 1;
    }
    throw e;
  }

  writeFileSync(clusterPath, mutated);
  log(`cloister add: added [inputs.${opts.name}] to ${clusterPath}`);

  // Resolve the new input + refresh the lockfile. If this fails the
  // cluster.toml mutation stays — operator can re-run after fixing the
  // ref, or `git checkout cluster.toml` to roll back.
  try {
    await resolveAllAndWriteLockfile(mutated, lockPath);
    log(`cloister add: ${opts.name} resolved; wrote ${lockPath}`);
    return 0;
  } catch (e) {
    errLog(`cloister add: resolve failed: ${e.message}`);
    errLog(
      `  cluster.toml was mutated; either fix the ref + re-run \`cloister cluster resolve\`,`,
    );
    errLog(`  or roll back with \`git checkout ${clusterPath}\`.`);
    return 1;
  }
}

/**
 * Resolve every input in the (already-mutated) cluster.toml body and
 * write cluster.lock.toml. Mirrors cli/lib/cluster/resolve-inputs.mjs
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
  // The one lock writer: carries a recorded rootfs forward (this used to
  // rebuild the lock without it, erasing `runtime import --bundle`'s record)
  // and writes atomically (cloister-991e65).
  writeLockfile(lockPath, doc);
}

// Run when invoked as a script (not when imported by tests).
const invokedAsScript = startedAsScript(import.meta.url);
if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`cloister add: unexpected error: ${e.message}`);
      process.exit(2);
    },
  );
}
