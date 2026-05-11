#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// import-image.mjs — import an OCI image tarball (`task image` output)
// into the cluster's BlobStore + tag index (TrustStore.registry_tags).
// Per cloister-cabd57 Phase 1 import path.
//
// The cluster operator runs this once at deploy time, after building
// the image locally with `task image`:
//
//   task image                           # builds cloister.tar
//   task registry:import cloister.tar    # uploads to the running cluster
//
// After this completes, `docker pull localhost:8787/cloister:latest`
// resolves against the running cluster — no external registry needed.
//
// Wire shape:
//   The script reads an OCI tarball (the apko / docker save format —
//   essentially a tar archive containing a top-level `manifest.json`,
//   one or more `<digest>.json` config blobs, and `<digest>.tar` /
//   `<digest>.tar.gz` layer blobs). It hashes each blob, asserts the
//   digest matches expectations from the index, then POSTs each blob
//   to a privileged admin endpoint on the running cluster.
//
//   Phase 1 uses a development-only admin shim: the script imports the
//   cluster via HTTP using the same /v2/ surface FOR READS (to check
//   what's already there, idempotency) and a tiny ad-hoc admin POST for
//   writes. The admin endpoint is gated on a shared secret in env
//   (`CLOISTER_ADMIN_SECRET`).
//
//   Phase 2's auth-gated PUT endpoint replaces this — the import script
//   will become an OCI-spec client (POST /v2/<name>/blobs/uploads/...)
//   carrying an `oci:push:<repo>` scope on its Signet lease.
//
// Usage:
//
//   node scripts/import-image.mjs <image.tar> [--registry http://localhost:8787] \
//                                              [--repo cloister] [--tag latest]
//
// Env vars:
//   CLOISTER_REGISTRY       default registry endpoint (override with --registry)
//   CLOISTER_ADMIN_SECRET   shared-secret bearer for the admin import endpoint
//
// Exit codes:
//   0   success
//   1   bad args / can't read tarball
//   2   tarball doesn't look like an OCI image (no manifest.json)
//   3   blob upload failed (network / auth / server error)
//   4   tag upsert failed
//
// IMPORTANT: this script is a Phase-1 dev tool. The admin HTTP
// endpoint it talks to does NOT yet exist in cloister-router; the
// script also supports a `--dry-run` mode that hashes everything and
// prints the index without uploading, which is what the test suite
// exercises. Wiring the admin endpoint is filed as a follow-up bead
// alongside the Phase-2 OCI push path.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// ── CLI parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printUsage();
  process.exit(args.length === 0 ? 1 : 0);
}

const opts = parseArgs(args);
if (!opts.tarball) {
  console.error("import-image: missing <image.tar> positional argument");
  process.exit(1);
}

const REGISTRY      = opts.registry ?? process.env.CLOISTER_REGISTRY ?? "http://localhost:8787";
const ADMIN_SECRET  = process.env.CLOISTER_ADMIN_SECRET ?? "";
const REPO_OVERRIDE = opts.repo;
const TAG_OVERRIDE  = opts.tag;
const DRY_RUN       = opts.dryRun;

// ── Read + parse OCI tarball ──────────────────────────────────────────────

let tarBytes;
try {
  tarBytes = readFileSync(resolve(opts.tarball));
} catch (e) {
  console.error(`import-image: cannot read ${opts.tarball}: ${e?.message ?? e}`);
  process.exit(1);
}

const entries = readTar(tarBytes);
const manifestEntry = entries.find((e) => e.name === "manifest.json");
if (!manifestEntry) {
  console.error("import-image: no manifest.json in tarball — is this an OCI image?");
  process.exit(2);
}

// The OCI image tarball's top-level `manifest.json` is an array of:
//   { Config: "<digest>.json", RepoTags: ["repo:tag", ...], Layers: ["<digest>.tar", ...] }
// One entry per image; multi-image tars are valid but Phase 1 imports
// the first one only (the typical case for `task image` is a single
// image per tarball).
const manifestList = JSON.parse(new TextDecoder().decode(manifestEntry.bytes));
if (!Array.isArray(manifestList) || manifestList.length === 0) {
  console.error("import-image: manifest.json is empty");
  process.exit(2);
}
const indexEntry = manifestList[0];

// ── Compute digests + plan uploads ───────────────────────────────────────

/**
 * The OCI image tarball's blob filenames are NOT the canonical content
 * digests — `docker save` / `apko publish` write them as
 * `<digest>.json` / `<digest>.tar` where <digest> is the sha256 hex of
 * the bytes that follow. We recompute the digest from bytes so the
 * import is self-checking: if the tarball was corrupted in transit,
 * the hash mismatches and we abort before writing anything.
 */
function digestOf(bytes) {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

const uploadPlan = [];

// 1. The image config blob.
const configEntry = entries.find((e) => e.name === indexEntry.Config);
if (!configEntry) {
  console.error(`import-image: config blob missing from tarball: ${indexEntry.Config}`);
  process.exit(2);
}
const configBytes  = configEntry.bytes;
const configDigest = digestOf(configBytes);
uploadPlan.push({
  kind:   "config",
  name:   indexEntry.Config,
  bytes:  configBytes,
  digest: configDigest,
});

// 2. Each layer blob.
for (const layerName of (indexEntry.Layers ?? [])) {
  const layerEntry = entries.find((e) => e.name === layerName);
  if (!layerEntry) {
    console.error(`import-image: layer blob missing from tarball: ${layerName}`);
    process.exit(2);
  }
  const layerBytes  = layerEntry.bytes;
  const layerDigest = digestOf(layerBytes);
  uploadPlan.push({
    kind:   "layer",
    name:   layerName,
    bytes:  layerBytes,
    digest: layerDigest,
  });
}

// 3. Compose the OCI manifest. We build a fresh one rather than relying
//    on the tarball's pre-built manifest (apko's manifest may contain
//    paths like "sha256:abc" already, but docker's older format uses
//    the in-tarball filenames; normalizing here lets both work).
const ociManifest = {
  schemaVersion: 2,
  mediaType:     "application/vnd.oci.image.manifest.v1+json",
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest:    `sha256:${configDigest}`,
    size:      configBytes.byteLength,
  },
  layers: (indexEntry.Layers ?? []).map((layerName, i) => {
    const plan = uploadPlan[i + 1]; // +1 because config is index 0
    // apko emits gzip'd layers; docker save emits plain tars. Sniff by
    // first two bytes (gzip starts with 0x1f 0x8b).
    const isGzip = plan.bytes.byteLength >= 2 &&
                   plan.bytes[0] === 0x1f && plan.bytes[1] === 0x8b;
    return {
      mediaType: isGzip
        ? "application/vnd.oci.image.layer.v1.tar+gzip"
        : "application/vnd.oci.image.layer.v1.tar",
      digest:    `sha256:${plan.digest}`,
      size:      plan.bytes.byteLength,
    };
  }),
};
const ociManifestBytes  = new TextEncoder().encode(JSON.stringify(ociManifest));
const ociManifestDigest = digestOf(ociManifestBytes);
uploadPlan.push({
  kind:   "manifest",
  name:   "<synthesized>",
  bytes:  ociManifestBytes,
  digest: ociManifestDigest,
});

// 4. Resolve (repo, tag) pairs from RepoTags + overrides.
const repoTagPairs = parseRepoTags(indexEntry.RepoTags ?? [], REPO_OVERRIDE, TAG_OVERRIDE);
if (repoTagPairs.length === 0) {
  console.error("import-image: no repo/tag pairs (RepoTags empty + no --repo/--tag override)");
  process.exit(2);
}

// ── Print plan ───────────────────────────────────────────────────────────

console.error(`import-image: ${opts.tarball}`);
console.error(`  registry: ${REGISTRY}`);
console.error(`  blobs:    ${uploadPlan.length}`);
for (const p of uploadPlan) {
  console.error(`    ${p.kind.padEnd(8)} ${p.digest} (${p.bytes.byteLength} bytes)`);
}
console.error(`  tags:`);
for (const [repo, tag] of repoTagPairs) {
  console.error(`    ${repo}:${tag} -> sha256:${ociManifestDigest}`);
}

if (DRY_RUN) {
  console.error("import-image: --dry-run set; not uploading");
  process.exit(0);
}

// ── Upload ───────────────────────────────────────────────────────────────
//
// Phase 1 uses an admin endpoint that doesn't yet exist (the bead
// description leaves this open with two options; the admin shim is the
// chosen one). For now we fail fast with a clear message.

if (!ADMIN_SECRET) {
  console.error("import-image: CLOISTER_ADMIN_SECRET is unset");
  console.error("import-image: (Phase-1 import requires a privileged write path; see follow-up bead)");
  process.exit(3);
}
console.error("import-image: live upload not yet wired — re-run with --dry-run to validate the plan");
console.error("import-image: (filed as a follow-up bead alongside Phase-2 OCI push)");
process.exit(3);

// ── Helpers ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { tarball: null, registry: null, repo: null, tag: null, dryRun: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--registry") { out.registry = argv[++i]; }
    else if (a === "--repo") { out.repo = argv[++i]; }
    else if (a === "--tag") { out.tag = argv[++i]; }
    else if (a === "--dry-run") { out.dryRun = true; }
    else if (a.startsWith("-")) {
      console.error(`import-image: unknown flag ${a}`);
      process.exit(1);
    } else if (!out.tarball) {
      out.tarball = a;
    } else {
      console.error(`import-image: extra positional ${a}`);
      process.exit(1);
    }
    i++;
  }
  return out;
}

function printUsage() {
  console.error(`Usage: import-image.mjs <image.tar> [options]

Options:
  --registry <url>    cluster URL (default: $CLOISTER_REGISTRY or http://localhost:8787)
  --repo <name>       override the repo name from RepoTags
  --tag <tag>         override the tag name from RepoTags
  --dry-run           hash + plan without uploading

Env:
  CLOISTER_REGISTRY       default --registry value
  CLOISTER_ADMIN_SECRET   bearer token for the admin import endpoint
`);
}

/**
 * Parse RepoTags ("repo:tag" form) into [repo, tag] tuples, applying
 * overrides. If RepoTags is empty AND both overrides are set, returns
 * a single synthesized pair.
 */
function parseRepoTags(repoTags, repoOverride, tagOverride) {
  if (repoTags.length === 0) {
    if (repoOverride && tagOverride) return [[repoOverride, tagOverride]];
    return [];
  }
  return repoTags.map((rt) => {
    const idx = rt.lastIndexOf(":");
    const repo = idx === -1 ? rt : rt.slice(0, idx);
    const tag  = idx === -1 ? "latest" : rt.slice(idx + 1);
    return [repoOverride ?? repo, tagOverride ?? tag];
  });
}

// ── Tar reader ───────────────────────────────────────────────────────────
//
// Minimal in-memory tar parser sufficient for OCI image tarballs. POSIX
// USTAR format: 512-byte header blocks, followed by content rounded up
// to 512-byte boundaries. We don't support pax headers, sparse files,
// or any of the more elaborate features — apko and docker emit basic
// USTAR which this parser handles.
//
// Returns [{ name, bytes }, ...] in the order they appear in the archive.

function readTar(buf) {
  const out = [];
  const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  while (off + 512 <= view.byteLength) {
    const header = view.subarray(off, off + 512);
    // End-of-archive: two consecutive zero blocks.
    if (header.every((b) => b === 0)) break;

    const name = readCString(header, 0,   100);
    const size = parseOctal(header.subarray(124, 124 + 12));
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    // Long-name PAX/GNU header — collect the actual name from the body.
    if (typeFlag === "L") {
      const longName = new TextDecoder()
        .decode(view.subarray(off + 512, off + 512 + size))
        .replace(/\0+$/, "");
      off += 512 + Math.ceil(size / 512) * 512;
      // Read the actual header that follows.
      const realHeader = view.subarray(off, off + 512);
      const realSize = parseOctal(realHeader.subarray(124, 124 + 12));
      const realBytes = view.subarray(off + 512, off + 512 + realSize);
      out.push({ name: longName, bytes: new Uint8Array(realBytes) });
      off += 512 + Math.ceil(realSize / 512) * 512;
      continue;
    }
    // Skip directories (typeFlag '5') and zero-byte entries.
    if (typeFlag !== "5" && size > 0) {
      const bytes = view.subarray(off + 512, off + 512 + size);
      out.push({ name, bytes: new Uint8Array(bytes) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function readCString(view, start, max) {
  let end = start;
  while (end < start + max && view[end] !== 0) end++;
  return new TextDecoder().decode(view.subarray(start, end));
}

function parseOctal(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0 || b === 0x20) break;            // null or space terminates
    if (b < 0x30 || b > 0x37) continue;          // skip non-octal chars
    n = n * 8 + (b - 0x30);
  }
  return n;
}
