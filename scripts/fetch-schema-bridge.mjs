#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fetch-schema-bridge — get the generator as a PUBLISHED, DIGEST-PINNED
// binary instead of building it from a git rev (cloister-9170d0).
//
// ── The bug this replaces ─────────────────────────────────────────────────
//
// `task cluster:zod` used to build the plugin from a SHA-pinned git dep. That
// pin sat at v0.7.9 while the fix cloister needed shipped in 0.11.3, so the
// regen ran, exited 0, and wrote a cluster.zod.ts produced by a generator five
// minor versions stale. Nothing reported it. The tell was a diff size: two
// lines where a real regen moves ~244.
//
// The release tag was never the delivery path either — v0.11.3 shipped no
// plugin binaries at all, so consumers HAD to pin a git SHA and build it.
// ley-line-open v0.12.0 fixed that (ley-line-open-f72fca thread); this makes
// cloister consume it.
//
// ── Why the digest, not the tag ───────────────────────────────────────────
//
// A tag is mutable and a release asset can be replaced under a stable name.
// Generated output looks plausible either way, so the failure mode is silent —
// the same shape as the OCI mutable-tag work. schema-bridge.lock.json pins a
// digest per platform and this script fails closed on mismatch.
//
// The release also ships SHA256SUMS, which is deliberately NOT trusted here:
// it arrives from the same place as the binary, so a compromised release
// supplies both. It is a convenience for humans, not a trust root.
//
// ── Caching ──────────────────────────────────────────────────────────────
//
// Downloaded once into rs/target/schema-bridge/<version>/, keyed by version
// AND verified by digest on every run — a cached file that no longer matches
// is re-fetched rather than trusted. No network access when the cache is warm,
// which keeps `task lint` offline-capable after a first fetch.
//
// Usage: node scripts/fetch-schema-bridge.mjs [binary-name]
//        node scripts/fetch-schema-bridge.mjs --wasm <module.wasm>
// Prints the absolute path of the verified binary on stdout.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILE = resolve(ROOT, "schema-bridge.lock.json");

/** Release asset suffix for the host, e.g. "darwin-arm64". */
export function hostTarget(p = platform(), a = arch()) {
  const os = p === "darwin" ? "darwin" : p === "linux" ? "linux" : null;
  const cpu = a === "x64" ? "amd64" : a === "arm64" ? "arm64" : null;
  if (!os || !cpu) {
    throw new Error(
      `schema-bridge: no published binary for ${p}/${a}. Published targets are ` +
      `darwin|linux × amd64|arm64. Build from source against the pinned rev if you ` +
      `need another host, and say so — silently falling back to a source build is how ` +
      `the stale-generator bug happened.`,
    );
  }
  return `${os}-${cpu}`;
}

export function readLock(path = LOCKFILE) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve a verified binary, downloading only when the cache is cold or stale.
 * @returns {Promise<string>} absolute path
 */
export async function ensureBinary(name, { lock = readLock(), target = hostTarget(), fetchImpl = fetch } = {}) {
  const expected = lock.binaries?.[name]?.[target];
  if (!expected) {
    throw new Error(
      `schema-bridge: ${name} has no pinned digest for ${target} in schema-bridge.lock.json. ` +
      `Add one rather than skipping verification.`,
    );
  }

  const cacheDir = resolve(ROOT, "rs/target/schema-bridge", lock.version);
  return ensureAsset({
    label: `${name}-${target}`,
    url: `https://github.com/${lock.repo}/releases/download/${lock.version}/${name}-${target}`,
    expected,
    cached: join(cacheDir, name),
    mode: 0o755,
    fetchImpl,
  });
}

/** Where `task llo:wasm` places a verified module. A FIXED path, because the
 * Worker imports it statically; the digest check, not the path, carries the
 * version — a module left over from another pin fails it and is refetched. */
export const WASM_DIR = resolve(ROOT, "rs/target/llo-wasm");

/**
 * Resolve a verified wasm32 module from the pinned LLO release (cloister-dbe9c3).
 * Platform-independent, so one digest per module rather than one per target.
 * @returns {Promise<string>} absolute path
 */
export async function ensureWasm(name, { lock = readLock(), fetchImpl = fetch, dir = WASM_DIR } = {}) {
  const expected = lock.wasm?.[name];
  if (!expected) {
    throw new Error(
      `llo-wasm: ${name} has no pinned digest under "wasm" in schema-bridge.lock.json. ` +
      `Add one rather than skipping verification.`,
    );
  }
  return ensureAsset({
    label: name,
    url: `https://github.com/${lock.repo}/releases/download/${lock.version}/${name}`,
    expected,
    cached: join(dir, name),
    mode: 0o644,
    fetchImpl,
  });
}

async function ensureAsset({ label, url, expected, cached, mode, fetchImpl }) {
  // Verify on EVERY run, not just after download: a cached file that no longer
  // matches has been tampered with or half-written, and trusting it because it
  // exists is exactly the assumption this rail removes.
  if (existsSync(cached)) {
    if (sha256(readFileSync(cached)) === expected) return cached;
    console.error(`schema-bridge: cached ${label} failed digest check — refetching`);
  }

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`schema-bridge: download failed ${res.status} ${url}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) {
    throw new Error(
      `schema-bridge: DIGEST MISMATCH for ${label}\n` +
      `  expected ${expected}\n  got      ${got}\n` +
      `  from ${url}\n` +
      `  The published asset does not match the pinned digest. Do not "fix" this by ` +
      `updating the lockfile without knowing why it changed — a release asset replaced ` +
      `under a stable tag is precisely what the pin exists to catch.`,
    );
  }

  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, bytes);
  chmodSync(cached, mode);
  return cached;
}

async function main() {
  const args = process.argv.slice(2);
  const wasm = args[0] === "--wasm";
  const name = (wasm ? args[1] : args[0]) ?? "capnpc-schema-bridge-zod";
  try {
    const path = wasm ? await ensureWasm(name) : await ensureBinary(name);
    process.stdout.write(path + "\n");
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
