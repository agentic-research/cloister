// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { writeGeneratedFile } from "../atomic-write.mjs";
import { clusterToToml } from "./cluster-to-toml.mjs";
import { emitCloisterCapnp } from "./emit-cloister-capnp.mjs";
import { emitCompose, parseOciPins } from "./emit-compose.mjs";
import { parseTomlToCluster, renderClusterTs } from "./toml-to-cluster.mjs";

export class ClusterGenerationError extends Error {}

function readOptional(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export async function generateClusterArtifacts({
  root,
  check = false,
  env = process.env,
  warn = console.warn,
} = {}) {
  const resolvedRoot = resolve(root ?? process.cwd());
  const paths = {
    toml: resolve(resolvedRoot, "cluster.toml"),
    clusterTs: resolve(resolvedRoot, "src/generated/cluster.ts"),
    capnp: resolve(resolvedRoot, "cloister.capnp"),
    compose: resolve(resolvedRoot, "cluster.compose.yaml"),
    lockfile: resolve(resolvedRoot, "cluster.lock.toml"),
  };

  let source;
  try {
    source = readFileSync(paths.toml, "utf8");
  } catch (error) {
    throw new ClusterGenerationError(`cannot read ${paths.toml}: ${error.message}`);
  }

  let cluster;
  try {
    cluster = await parseTomlToCluster(source);
  } catch (error) {
    throw new ClusterGenerationError(`${paths.toml}: ${error.message}`);
  }

  let ociByInput = new Map();
  let ociByBundle = new Map();
  const lockText = readOptional(paths.lockfile);
  if (lockText !== null) {
    try {
      ({ ociByInput, ociByBundle } = parseOciPins(lockText));
    } catch (error) {
      throw new ClusterGenerationError(`${paths.lockfile}: ${error.message}`);
    }
  }

  // Compute every projection before touching any destination. A parse or
  // render failure therefore leaves the previous generated set intact.
  const bodies = {
    toml: clusterToToml(cluster),
    clusterTs: renderClusterTs(cluster),
    capnp: emitCloisterCapnp(cluster, { quiet: true }),
    compose: emitCompose(cluster, ociByInput, {
      doBindPath: env.CLOISTER_DO_BIND || "",
      ociByBundle,
      warn,
    }),
  };

  const changed = Object.entries(bodies)
    .filter(([key, body]) => readOptional(paths[key]) !== body)
    .map(([key]) => paths[key]);

  if (!check) {
    for (const [key, body] of Object.entries(bodies)) {
      if (changed.includes(paths[key])) writeGeneratedFile(paths[key], body);
    }
  }

  return {
    root: resolvedRoot,
    cluster,
    files: {
      toml: paths.toml,
      clusterTs: paths.clusterTs,
      capnp: paths.capnp,
      compose: paths.compose,
    },
    changed,
  };
}
