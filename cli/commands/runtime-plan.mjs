#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lower one external bundle plus its lockfile-pinned OCI input into the
// fail-closed cloister/host-runtime/v1 contract.
//
// cluster.toml goes through `parseTomlToCluster` — the same pipeline as
// `cluster:toml`, with the strict ClusterSchema and every step-4 check — before
// anything is lowered (cloister-991e65). There is no second, looser parse:
// a typo'd key, a duplicate bundle, a string port or a misspelled table fails
// here exactly as it fails the build.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, dirname, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";
import { isCanonicalAbsolutePath } from "../lib/canonical-path.mjs";
import { isSha256Digest } from "../lib/oci-artifact.mjs";
import {
  ROOTFS_KEY,
  importCommand,
  isBlake3Digest,
  lockedRootfs,
  rootfsHex,
} from "../lib/runtime/rootfs-lock.mjs";
import { casRootInCas } from "../lib/runtime/cas-root.mjs";
import { parseTomlToCluster } from "../lib/cluster/toml-to-cluster.mjs";
import {
  DEFAULT_CHANNEL_DIR,
  checkableBundle,
  lowerChannelGrants,
} from "../lib/cluster/connections.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "../..");

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parsePlanArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-") && !opts.bundle) {
      opts.bundle = arg;
    } else if (arg === "--workspace") {
      opts.workspace = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--control-socket") {
      opts.controlSocket = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--env") {
      opts.env = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--channel-dir") {
      opts.channelDir = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--dir") {
      opts.dir = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--output") {
      opts.output = requiredValue(argv, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (opts.help) return opts;
  if (!opts.bundle) throw new Error("missing required bundle name");
  if (!opts.workspace) throw new Error("--workspace is required");
  if (!isAbsolute(opts.workspace)) throw new Error("--workspace must be absolute");
  if (!isCanonicalAbsolutePath(opts.workspace)) {
    throw new Error("--workspace must be a canonical absolute path");
  }
  opts.controlSocket ??= `/tmp/cloister-host-runtime/${opts.bundle}.sock`;
  if (!isAbsolute(opts.controlSocket)) throw new Error("--control-socket must be absolute");
  if (!isCanonicalAbsolutePath(opts.controlSocket)) {
    throw new Error("--control-socket must be a canonical absolute path");
  }
  opts.env ??= "local";
  opts.channelDir ??= DEFAULT_CHANNEL_DIR;
  if (!isAbsolute(opts.channelDir)) throw new Error("--channel-dir must be absolute");
  // The confinement digest commits to each grant's path string, so the
  // directory is spelled one way only: no trailing slash.
  if (!isCanonicalAbsolutePath(opts.channelDir) || (opts.channelDir.endsWith("/") && opts.channelDir !== "/")) {
    throw new Error("--channel-dir must be a canonical absolute path (no trailing slash)");
  }
  if (opts.output && !isAbsolute(opts.output)) throw new Error("--output must be absolute");
  if (opts.output && !isCanonicalAbsolutePath(opts.output)) {
    throw new Error("--output must be a canonical absolute path");
  }
  return opts;
}

/**
 * Validate `tomlString` with the full cluster pipeline, then lower one bundle.
 * The only entry point that starts from cluster.toml text.
 */
export async function planFromToml(tomlString, lock, options) {
  return buildLaunchPlan(await parseTomlToCluster(tomlString), lock, options);
}

/**
 * Lower one bundle of an ALREADY VALIDATED cluster (the `parseTomlToCluster`
 * shape: `kind` is `{ external: {...} }`, confinement normalized). Callers
 * holding cluster.toml text use `planFromToml`.
 */
export function buildLaunchPlan(cluster, lock, options) {
  const bundle = (cluster?.bundles ?? []).find((candidate) => candidate.name === options.bundle);
  if (!bundle) throw new Error(`bundle ${JSON.stringify(options.bundle)} is not declared`);
  const external = bundle.kind?.external;
  if (!external) {
    throw new Error(`bundle ${JSON.stringify(options.bundle)} is not an external bundle`);
  }

  if (!["microvm", "process"].includes(external.executionMode)) {
    throw new Error(
      `bundle ${JSON.stringify(options.bundle)} requires executionMode = "microvm" or "process"`,
    );
  }
  if (typeof external.entryPoint !== "string" || !isAbsolute(external.entryPoint)) {
    throw new Error(
      `bundle ${JSON.stringify(options.bundle)} requires an absolute external.entryPoint`,
    );
  }
  if (!isCanonicalAbsolutePath(external.entryPoint)) {
    throw new Error(
      `bundle ${JSON.stringify(options.bundle)} requires a canonical external.entryPoint`,
    );
  }

  const oci = lock?.inputs?.[options.bundle]?.oci;
  if (!oci || typeof oci.identifier !== "string" || !oci.identifier.trim()) {
    throw new Error(`bundle ${JSON.stringify(options.bundle)} has no locked OCI artifact`);
  }
  if (!isSha256Digest(oci.digest)) {
    throw new Error(
      `bundle ${JSON.stringify(options.bundle)} requires an immutable sha256 digest in cluster.lock.toml`,
    );
  }
  // The microVM tier runs a CAS rootfs (`blake3-256:`), never an OCI image
  // reference: the host runtime refuses a sha256 artifact for LLO execution.
  // The rootfs is the one `runtime import --bundle` derived from THIS pinned
  // image and recorded beside it; a plan is never emitted without it
  // (cloister-991e65). Process mode is unchanged and keeps the image digest.
  const digest = external.executionMode === "microvm"
    ? microvmRootfs(lock, options)
    : oci.digest;

  // Defense in depth: parseTomlToCluster already refuses this. §6 grants come
  // only from declared ports and connections, never from the plan's input.
  if (bundle.confinement?.unixSocket !== undefined) {
    throw new Error(
      `bundle ${JSON.stringify(options.bundle)} carries confinement.unixSocket; §6 grants ` +
        `are derived from ports and connections, never written by hand`,
    );
  }

  // ADR-0069 / ADR-0070 §4 (cloister-991e65): declared ports + connections
  // lower to confinement/v1 §6 grants. The declarations were checked by
  // parseTomlToCluster; lowerChannelGrants keeps its own refusals as defense
  // in depth.
  const grants = lowerChannelGrants(
    cluster.bundles.map(checkableBundle),
    cluster.connections ?? [],
    {
      bundle: bundle.name,
      env: options.env ?? "local",
      channelDir: options.channelDir ?? DEFAULT_CHANNEL_DIR,
    },
  );
  const baseConfinement = bundle.confinement;
  // The key is added only when there is a grant, so a plan for a bundle with
  // no declarations is byte-identical to one emitted before this lowering.
  const confinement = grants.length > 0
    ? { ...baseConfinement, unixSocket: { allow: grants } }
    : baseConfinement;

  return {
    schema: "cloister/host-runtime/v1",
    bundle: bundle.name,
    mode: external.executionMode,
    artifact: {
      image: oci.identifier,
      digest,
      entrypoint: external.entryPoint,
      args: Array.isArray(external.args) ? external.args : [],
    },
    confinement,
    workspace: options.workspace,
    controlSocket: options.controlSocket,
  };
}

/**
 * The recorded, present rootfs for a microvm bundle, or a refusal naming the
 * exact command that fixes it. `options.rootfsInCas(hex)` answers whether the
 * CAS holds that rootfs; it is required, so a caller cannot skip the check.
 */
function microvmRootfs(lock, options) {
  const bundle = options.bundle;
  const fix = importCommand(bundle, options.dir);
  const recorded = lockedRootfs(lock, bundle);
  if (!recorded) {
    throw new Error(
      `bundle "${bundle}" is a microvm bundle with no imported rootfs in cluster.lock.toml ` +
        `([inputs.${bundle}.oci] ${ROOTFS_KEY}). Import its pinned image first:\n  ${fix}`,
    );
  }
  if (!isBlake3Digest(recorded.rootfs)) {
    throw new Error(
      `bundle "${bundle}" records rootfs ${JSON.stringify(recorded.rootfs)}, which is not a ` +
        `blake3-256 digest. Re-import:\n  ${importCommand(bundle, options.dir, recorded.symlinks)}`,
    );
  }
  if (typeof options.rootfsInCas !== "function") {
    throw new Error("internal: buildLaunchPlan needs rootfsInCas to verify a microvm rootfs");
  }
  const where = options.rootfsInCas(rootfsHex(recorded.rootfs));
  if (!where.present) {
    throw new Error(
      `bundle "${bundle}"'s rootfs ${recorded.rootfs} is recorded in cluster.lock.toml but is ` +
        `not in the CAS (${where.casRoot}). Re-import it:\n  ` +
        importCommand(bundle, options.dir, recorded.symlinks),
    );
  }
  return recorded.rootfs;
}

function printHelp(log = console.log) {
  log("Usage: cloister runtime plan <bundle> --workspace <absolute-path> [options]");
  log("");
  log("Options:");
  log("  --control-socket <path>  Host-runtime control socket");
  log('  --env <name>             Environment whose connection targets to lower (default "local")');
  log(`  --channel-dir <path>     Directory of channel sockets (default ${DEFAULT_CHANNEL_DIR})`);
  log("  --dir <path>             Cluster directory holding cluster.toml + cluster.lock.toml");
  log("  --output <path>          Write JSON atomically-addressable plan input");
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  let opts;
  try {
    opts = parsePlanArgs(argv);
  } catch (cause) {
    error(`emit-host-launch-plan: ${cause.message}`);
    return 2;
  }
  if (opts.help) {
    printHelp(log);
    return 0;
  }

  try {
    const root = opts.dir ? resolvePath(opts.dir) : REPO_ROOT;
    const clusterPath = process.env.CLOISTER_CLUSTER_TOML
      ? resolvePath(process.env.CLOISTER_CLUSTER_TOML)
      : resolvePath(root, "cluster.toml");
    const lockPath = process.env.CLOISTER_LOCKFILE
      ? resolvePath(process.env.CLOISTER_LOCKFILE)
      : resolvePath(root, "cluster.lock.toml");
    const lock = parseToml(readFileSync(lockPath, "utf8"));
    const plan = await planFromToml(readFileSync(clusterPath, "utf8"), lock, {
      ...opts,
      // Only used to spell the fix in a refusal: the directory `runtime
      // import --dir` must be given to reach the same lock.
      dir: opts.dir ?? (relativePath(process.cwd(), root) || "."),
      rootfsInCas: io.rootfsInCas ?? casRootInCas(io.env ?? process.env),
    });
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    if (opts.output) {
      writeFileSync(opts.output, json, { mode: 0o600 });
      log(`emit-host-launch-plan: wrote ${opts.output}`);
    } else {
      log(json.trimEnd());
    }
    return 0;
  } catch (cause) {
    error(`emit-host-launch-plan: ${cause.message}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
