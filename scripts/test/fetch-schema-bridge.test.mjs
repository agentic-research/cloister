// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for fetch-schema-bridge (cloister-9170d0).
//
// The behaviour that matters is the REFUSAL: a published asset that does not
// match the pinned digest must fail the build, because the thing it protects
// against — a generator silently producing plausible-but-wrong output — is
// invisible by construction. The stale-pin bug it replaces exited 0 for five
// minor versions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { ensureBinary, hostTarget, readLock, sha256 } from "../fetch-schema-bridge.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK = readLock(resolve(ROOT, "schema-bridge.lock.json"));

/** A fetch that serves fixed bytes without touching the network. */
function stubFetch(bytes, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

// ── The lockfile is real and complete ─────────────────────────────────────

test("every generator cloister uses is pinned for every published target", () => {
  const targets = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"];
  for (const name of ["capnpc-schema-bridge-zod", "capnpc-schema-bridge-go"]) {
    for (const t of targets) {
      const d = LOCK.binaries?.[name]?.[t];
      assert.ok(/^[0-9a-f]{64}$/.test(d ?? ""), `${name}/${t} needs a sha256, got ${d}`);
    }
  }
});

test("the pinned version is a concrete tag, not a floating ref", () => {
  // "latest" or a branch name would reintroduce the mutable-tag problem the
  // digests exist to close.
  assert.match(LOCK.version, /^v\d+\.\d+\.\d+$/);
});

// ── Host resolution ───────────────────────────────────────────────────────

test("host target maps to published asset names", () => {
  assert.equal(hostTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(hostTarget("linux", "x64"), "linux-amd64");
});

test("an unpublished host fails loudly rather than falling back to a source build", () => {
  // Silently building from source is how the stale-generator bug happened:
  // the fallback succeeded and nobody learned the binary was unavailable.
  assert.throws(() => hostTarget("win32", "x64"), /no published binary/);
});

// ── The refusal ───────────────────────────────────────────────────────────

test("a payload that does not match the pinned digest fails closed", async () => {
  const tampered = Buffer.from("not the real generator");
  await assert.rejects(
    () => ensureBinary("capnpc-schema-bridge-zod", {
      lock: { ...LOCK, version: "v0.0.0-test" },   // cold cache path
      target: "linux-amd64",
      fetchImpl: stubFetch(tampered),
    }),
    /DIGEST MISMATCH/,
  );
});

test("a download failure is an error, not a silent skip", async () => {
  await assert.rejects(
    () => ensureBinary("capnpc-schema-bridge-zod", {
      lock: { ...LOCK, version: "v0.0.0-test" },
      target: "linux-amd64",
      fetchImpl: stubFetch(Buffer.alloc(0), false, 404),
    }),
    /download failed 404/,
  );
});

test("a binary with no pinned digest is refused rather than fetched unverified", async () => {
  await assert.rejects(
    () => ensureBinary("capnpc-schema-bridge-jsonschema", {
      lock: LOCK,
      target: "linux-amd64",
      fetchImpl: stubFetch(Buffer.from("x")),
    }),
    /no pinned digest/,
  );
});

// ── The warm-cache path is real ───────────────────────────────────────────

test("a previously fetched binary resolves without network access", async () => {
  // Skips when cold: the first fetch is a network operation and this suite
  // must not require one. When warm, it proves `task lint` stays offline-
  // capable — the reason for caching at all.
  const target = hostTarget();
  const expected = LOCK.binaries["capnpc-schema-bridge-zod"]?.[target];
  const cached = resolve(ROOT, "rs/target/schema-bridge", LOCK.version, "capnpc-schema-bridge-zod");
  if (!expected || !existsSync(cached)) {
    test.skip?.("generator not fetched yet on this host");
    return;
  }
  const path = await ensureBinary("capnpc-schema-bridge-zod", {
    lock: LOCK,
    target,
    fetchImpl: () => { throw new Error("network must not be touched on a warm cache"); },
  });
  assert.equal(path, cached);
});

test("sha256 helper matches the digest of a known input", () => {
  // Guards the comparison itself — a hash function that returned a constant
  // would make every verification above pass vacuously.
  assert.equal(
    sha256(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
