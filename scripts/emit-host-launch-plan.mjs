#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lower one external bundle plus its lockfile-pinned OCI input into the
// fail-closed cloister/host-runtime/v1 contract.

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";
import { isCanonicalAbsolutePath } from "./lib/canonical-path.mjs";
import { isSha256Digest } from "./lib/oci-artifact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

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
  if (opts.output && !isAbsolute(opts.output)) throw new Error("--output must be absolute");
  if (opts.output && !isCanonicalAbsolutePath(opts.output)) {
    throw new Error("--output must be a canonical absolute path");
  }
  return opts;
}

function defaultConfinement() {
  return {
    fs: { allow: [] },
    network: { allowHosts: [] },
    port: { bind: 0, address: "" },
    credentialSource: "",
  };
}

export function buildLaunchPlan(cluster, lock, options) {
  const bundle = (cluster?.bundles ?? []).find((candidate) => candidate.name === options.bundle);
  if (!bundle) throw new Error(`bundle ${JSON.stringify(options.bundle)} is not declared`);
  if (bundle.kind !== "external" || !bundle.external) {
    throw new Error(`bundle ${JSON.stringify(options.bundle)} is not an external bundle`);
  }

  const external = bundle.external;
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

  return {
    schema: "cloister/host-runtime/v1",
    bundle: bundle.name,
    mode: external.executionMode,
    artifact: {
      image: oci.identifier,
      digest: oci.digest,
      entrypoint: external.entryPoint,
      args: Array.isArray(external.args) ? external.args : [],
    },
    confinement: bundle.confinement ?? defaultConfinement(),
    workspace: options.workspace,
    controlSocket: options.controlSocket,
  };
}

function printHelp(log = console.log) {
  log("Usage: cloister runtime plan <bundle> --workspace <absolute-path> [options]");
  log("");
  log("Options:");
  log("  --control-socket <path>  Host-runtime control socket");
  log("  --output <path>          Write JSON atomically-addressable plan input");
}

export function main(argv = process.argv.slice(2), io = {}) {
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
    const clusterPath = process.env.CLOISTER_CLUSTER_TOML
      ? resolvePath(process.env.CLOISTER_CLUSTER_TOML)
      : resolvePath(REPO_ROOT, "cluster.toml");
    const lockPath = process.env.CLOISTER_LOCKFILE
      ? resolvePath(process.env.CLOISTER_LOCKFILE)
      : resolvePath(REPO_ROOT, "cluster.lock.toml");
    const cluster = parseToml(readFileSync(clusterPath, "utf8"));
    const lock = parseToml(readFileSync(lockPath, "utf8"));
    const plan = buildLaunchPlan(cluster, lock, opts);
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
  process.exit(main());
}
