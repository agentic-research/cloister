// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scripts/pull-inputs.mjs — ADR-0026 Phase 1c (cloister-cf7a3b follow-up)
//
// The "install" half of the resolve → install → run flow. `cluster:resolve`
// fetches each input's `server.json` and pins its self-declared `oci` image
// (ADR-0038 `packages[].oci`) into `cluster.lock.toml`. This script reads
// those pinned rows and pulls the image BYTES into the local container store
// so `task cluster:up` — which emits `pull_policy: never` for reproducible,
// no-surprise-fetch boots — has everything it needs offline.
//
// Analogy: `cluster:resolve` is `npm install` writing the lockfile;
// `inputs:pull` is `npm ci` materializing exactly what the lockfile pins.
// The runtime never pulls, because the fetch already happened here,
// deliberately, against committed digests.
//
// Pull-ref precedence (mirrors emit-compose's resolveBundleImage, ADR-0038):
//
//   identifier@digest   — digest-pinned, content-addressed, reproducible
//   identifier:version  — tag-pinned (WARN: not content-addressed)
//   identifier          — registry default/latest (WARN)
//
// Runtime: $CONTAINER_CMD, else docker, else nerdctl, else podman.
//
// Flags:
//   --print   list the images the lockfile pins; pull nothing (CI / preview).
//
// Wire:
//   Exit 0 — all images pulled (or --print).
//   Exit 1 — one or more pulls failed (unpublished image / not authed).
//   Exit 2 — toolchain error (lockfile missing, no runtime, unparseable).

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { parse as parseToml } from "@iarna/toml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

const LOCKFILE_PATH = process.env.CLOISTER_LOCKFILE
  ? resolvePath(process.env.CLOISTER_LOCKFILE)
  : resolvePath(REPO_ROOT, "cluster.lock.toml");

/**
 * Compute the pullable image reference for one lockfile `oci` row, using
 * the ADR-0038 precedence. Returns `null` when the row is absent or names
 * no identifier (→ the caller skips + warns).
 *
 * Exported for unit tests.
 */
export function ociPullRef(oci) {
  if (!oci || typeof oci !== "object") return null;
  const identifier = typeof oci.identifier === "string" ? oci.identifier.trim() : "";
  if (!identifier) return null;
  if (oci.digest)  return `${identifier}@${oci.digest}`;
  if (oci.version) return `${identifier}:${oci.version}`;
  return identifier;
}

/**
 * Walk a parsed lockfile document's `[inputs.*]` tables and return one
 * row per input: `{ name, ref, pinned }`. `ref` is null when the input
 * carries no oci image; `pinned` is true only for digest-pinned refs
 * (content-addressed, reproducible).
 *
 * Exported for unit tests.
 */
export function collectOciRefs(lockDoc) {
  const inputs = (lockDoc && typeof lockDoc === "object" && lockDoc.inputs) || {};
  return Object.entries(inputs).map(([name, spec]) => {
    const oci = spec && typeof spec === "object" ? spec.oci : null;
    return {
      name,
      ref: ociPullRef(oci),
      pinned: !!(oci && typeof oci === "object" && oci.digest),
    };
  });
}

function detectRuntime() {
  if (process.env.CONTAINER_CMD) return process.env.CONTAINER_CMD;
  for (const cmd of ["docker", "nerdctl", "podman"]) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return cmd;
  }
  return null;
}

function main() {
  const printOnly = process.argv.includes("--print");

  if (!existsSync(LOCKFILE_PATH)) {
    console.error(
      `pull-inputs: lockfile not found at ${LOCKFILE_PATH} — run \`task cluster:resolve\` first`,
    );
    process.exit(2);
  }

  let doc;
  try {
    doc = parseToml(readFileSync(LOCKFILE_PATH, "utf8"));
  } catch (e) {
    console.error(`pull-inputs: failed to parse ${LOCKFILE_PATH}: ${e.message}`);
    process.exit(2);
  }

  const rows = collectOciRefs(doc);
  const withImage = rows.filter((r) => r.ref);
  const noImage = rows.filter((r) => !r.ref);

  for (const r of noImage) {
    console.warn(
      `pull-inputs: input "${r.name}" has no oci image in the lockfile — skipping ` +
      `(add packages[].oci to its server.json, ADR-0038)`,
    );
  }

  if (withImage.length === 0) {
    console.log("pull-inputs: no oci images pinned in the lockfile — nothing to pull");
    return;
  }

  if (printOnly) {
    console.log("pull-inputs: --print — images the lockfile pins:");
    for (const r of withImage) {
      console.log(`  ${r.name} → ${r.ref}${r.pinned ? "" : "   (tag-pinned, not content-addressed)"}`);
    }
    return;
  }

  const cmd = detectRuntime();
  if (!cmd) {
    console.error(
      "pull-inputs: no container runtime found (need docker, nerdctl, or podman; " +
      "set CONTAINER_CMD to override)",
    );
    process.exit(2);
  }

  const failures = [];
  for (const r of withImage) {
    if (!r.pinned) {
      console.warn(
        `pull-inputs: ${r.name} → ${r.ref} is tag-pinned (not content-addressed) — ` +
        `ask the maintainer to add a "digest" to packages[].oci for a reproducible pin`,
      );
    }
    console.log(`pull-inputs: ${cmd} pull ${r.ref}`);
    const res = spawnSync(cmd, ["pull", r.ref], { stdio: "inherit" });
    if (res.status !== 0) failures.push(r);
  }

  if (failures.length > 0) {
    console.error(
      `\npull-inputs: ${failures.length} image(s) failed to pull: ` +
      `${failures.map((f) => f.ref).join(", ")}`,
    );
    console.error("  (is the image published to its registry, and are you authenticated?)");
    process.exit(1);
  }

  console.log(
    `\npull-inputs: pulled ${withImage.length} image(s) — ` +
    `\`task cluster:up\` (pull_policy: never) can now boot offline.`,
  );
}

const invokedAsScript =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedAsScript) main();
