#!/usr/bin/env node
// scripts/lint-paths.mjs
//
// Drift lint for paths shared across config files (cloister-7c12cc / P2).
//
// Less dangerous than the timing-invariant lint (silently insecure was the
// timing class); path drift is silently broken — the container fails to
// start or DOs land somewhere unexpected. Operationally annoying, not
// security-affecting per se, but masks misconfigurations that CAN have
// security implications (e.g. DO storage on a non-persistent ramfs).
//
// What this checks (today — the do-storage path):
//
//   - apko.yaml creates `/data/do` (uid 65532) at image build
//   - config.capnp `do-storage` service points at `/data/do`
//   - cluster.capnp StoragePolicy.doStoragePath = "/data/do"
//
// All three MUST agree.
//
// Exit codes:
//   0 — paths agree
//   1 — drift detected; details on stderr
//   2 — toolchain error reading source files

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = process.cwd();

function read(rel) {
  return readFileSync(resolve(REPO, rel), "utf-8");
}

// ── apko.yaml: extract the deepest /data/* path declared ────────────────
//
// We want the directory that's mounted as the do-storage volume. apko's
// `paths:` block declares them; pick the one matching `/data/do` shape.

function extractApkoDoPath() {
  const text = read("apko.yaml");
  // Match `- path: <p>` where <p> starts with /data/ and isn't just /data.
  // The lint cares about the deepest path, since that's the actual mount
  // target.
  const matches = [...text.matchAll(/^\s*-\s*path:\s*(\/data\/\S+)\s*$/gm)];
  if (matches.length === 0) {
    throw new Error("lint-paths: apko.yaml has no /data/* path declaration");
  }
  // If there are multiple, the do-storage one is the one used as
  // workerd's localDisk. Pick by exact match against the expected shape.
  for (const m of matches) {
    if (m[1].startsWith("/data/do")) return m[1];
  }
  throw new Error(`lint-paths: apko.yaml has no /data/do* path; got: ${matches.map(m => m[1]).join(", ")}`);
}

// ── config.capnp: extract the do-storage service's disk path ────────────
//
// Looking for:
//   ( name = "do-storage", disk = ( path = "/data/do", ... ) )

function extractConfigDoPath() {
  const text = read("config.capnp");
  const m = text.match(/name\s*=\s*"do-storage",\s*disk\s*=\s*\(\s*path\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error("lint-paths: config.capnp has no `do-storage` service with a `disk path` field");
  }
  return m[1];
}

// ── cluster.capnp: extract StoragePolicy.doStoragePath ──────────────────

function extractClusterDoPath() {
  const text = read("cluster.capnp");
  const m = text.match(/doStoragePath\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error("lint-paths: cluster.capnp has no `doStoragePath` field");
  }
  return m[1];
}

// ── Run ──────────────────────────────────────────────────────────────────

let apkoPath, configPath, clusterPath;
try {
  apkoPath    = extractApkoDoPath();
  configPath  = extractConfigDoPath();
  clusterPath = extractClusterDoPath();
} catch (e) {
  console.error(`lint-paths: ${e.message}`);
  process.exit(2);
}

const allPaths = { apkoPath, configPath, clusterPath };
const distinct = new Set(Object.values(allPaths));

if (distinct.size === 1) {
  console.log(`lint-paths: clean ✓`);
  console.log(`  do-storage path = ${apkoPath} (apko.yaml + config.capnp + cluster.capnp agree)`);
  process.exit(0);
}

console.error(`\n✗ lint-paths: do-storage path drift across files\n`);
console.error(`  apko.yaml         : ${apkoPath}`);
console.error(`  config.capnp      : ${configPath}`);
console.error(`  cluster.capnp     : ${clusterPath}`);
console.error("");
console.error("All three MUST match. cluster.capnp is the operator-facing");
console.error("intent; apko + config.capnp are the build/runtime consumers.");
console.error("Update them in the same commit. See cloister-7c12cc.");
process.exit(1);
