// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OCI Distribution Spec push/pull microbenchmark (cloister-3a3b0d).
//
// EXCLUDED from `task lint` / `task test` — runs only via
// `task bench:registry`.
//
// Measures the five ops that matter for tool-bundle distribution +
// metavisor artifact interchange:
//
//   1. Monolithic blob upload  (POST /v2/<name>/blobs/uploads/?digest=)
//   2. Chunked blob upload     (POST → PATCH → PUT cycle)
//   3. Manifest PUT            (PUT /v2/<name>/manifests/<tag>)
//   4. Blob GET by digest      (GET /v2/<name>/blobs/<digest>)
//   5. Manifest GET by tag     (GET /v2/<name>/manifests/<tag>)
//
// Sizes:
//   - small  =  1 KB  (typical config blob)
//   - medium = 64 KB  (typical layer / signed bundle envelope)
//   - large  =  1 MB  (large layer / image)
//
// Anonymous mode (INTERLACE_ROOT_PUBKEY unset) — measures pure substrate
// cost, not lease-pipeline overhead. A separate bench would gate writes
// to compare; not in this bead.

/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env as testEnv } from "cloudflare:test";
import { describe, it } from "vitest";

import { OciRegistryRoute } from "../../src/routes/oci-registry.js";
import type { Env } from "../../src/types.js";

const REPO         = "bench/oci";
const ITERATIONS   = 200;
const WARMUP       = 20;
const SMALL_BYTES  = 1024;
const MEDIUM_BYTES = 64 * 1024;
const LARGE_BYTES  = 1024 * 1024;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples: number[]): { mean: number; p50: number; p99: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    mean: sum / samples.length,
    p50:  percentile(sorted, 50),
    p99:  percentile(sorted, 99),
    min:  sorted[0],
    max:  sorted[sorted.length - 1],
  };
}

function fmt(n: number): string {
  if (n < 0.1) return n.toFixed(3);
  if (n < 10) return n.toFixed(2);
  return n.toFixed(1);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // crypto.getRandomValues caps at 65536 bytes per call.
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  }
  return out;
}

// Hold one OciRegistryRoute instance for the duration of the bench so
// the in-route upload-session Map persists across chunked-PATCH calls.
function makeRoute(): OciRegistryRoute {
  return new OciRegistryRoute();
}

function makeEnv(): Env {
  // Anonymous mode — INTERLACE_ROOT_PUBKEY unset by default in test env,
  // so gateWrite returns verdict { kind: "anonymous" } and we measure
  // the pure substrate path. BLOB_STORE + TRUST_STORE DOs come from the
  // cloudflare:test env (wired via vitest.config.ts / wrangler.toml).
  return testEnv as unknown as Env;
}

async function pushMonolithic(
  route: OciRegistryRoute,
  env:   Env,
  bytes: Uint8Array,
): Promise<{ digest: string; durationMs: number }> {
  const digest = `sha256:${await sha256Hex(bytes)}`;
  const url = `http://x/v2/${REPO}/blobs/uploads/?digest=${digest}`;
  const t0 = performance.now();
  const res = await route.handle(new Request(url, { method: "POST", body: bytes as BodyInit }), env);
  const t1 = performance.now();
  if (res.status !== 201) {
    throw new Error(`monolithic push failed: ${res.status} ${await res.text()}`);
  }
  return { digest, durationMs: t1 - t0 };
}

async function pushChunked(
  route: OciRegistryRoute,
  env:   Env,
  bytes: Uint8Array,
  chunkSize: number,
): Promise<{ digest: string; durationMs: number }> {
  const digest = `sha256:${await sha256Hex(bytes)}`;
  const t0 = performance.now();
  // 1) start upload session
  const start = await route.handle(
    new Request(`http://x/v2/${REPO}/blobs/uploads/`, { method: "POST" }),
    env,
  );
  if (start.status !== 202) throw new Error(`upload-begin failed: ${start.status}`);
  const location = start.headers.get("Location");
  if (!location) throw new Error("upload-begin missing Location");
  // 2) stream chunks via PATCH
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    const patch = await route.handle(
      new Request(`http://x${location}`, { method: "PATCH", body: chunk as BodyInit }),
      env,
    );
    if (patch.status !== 202) throw new Error(`upload-patch failed: ${patch.status}`);
  }
  // 3) finalize with digest
  const finalize = await route.handle(
    new Request(`http://x${location}?digest=${digest}`, { method: "PUT" }),
    env,
  );
  if (finalize.status !== 201) {
    throw new Error(`upload-finalize failed: ${finalize.status} ${await finalize.text()}`);
  }
  const t1 = performance.now();
  return { digest, durationMs: t1 - t0 };
}

async function putManifest(
  route:   OciRegistryRoute,
  env:     Env,
  tag:     string,
  payload: Uint8Array,
): Promise<{ digest: string; durationMs: number }> {
  const url = `http://x/v2/${REPO}/manifests/${tag}`;
  const t0 = performance.now();
  const res = await route.handle(
    new Request(url, {
      method:  "PUT",
      body:    payload as BodyInit,
      headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
    }),
    env,
  );
  const t1 = performance.now();
  if (res.status !== 201) {
    throw new Error(`manifest PUT failed: ${res.status} ${await res.text()}`);
  }
  const digest = res.headers.get("Docker-Content-Digest") ?? "";
  return { digest, durationMs: t1 - t0 };
}

async function getBlob(
  route:  OciRegistryRoute,
  env:    Env,
  digest: string,
): Promise<{ durationMs: number; bytes: number }> {
  const url = `http://x/v2/${REPO}/blobs/${digest}`;
  const t0 = performance.now();
  const res = await route.handle(new Request(url, { method: "GET" }), env);
  if (res.status !== 200) throw new Error(`blob GET failed: ${res.status}`);
  const body = await res.arrayBuffer();
  const t1 = performance.now();
  return { durationMs: t1 - t0, bytes: body.byteLength };
}

async function getManifest(
  route: OciRegistryRoute,
  env:   Env,
  tag:   string,
): Promise<{ durationMs: number; bytes: number }> {
  const url = `http://x/v2/${REPO}/manifests/${tag}`;
  const t0 = performance.now();
  const res = await route.handle(new Request(url, { method: "GET" }), env);
  if (res.status !== 200) throw new Error(`manifest GET failed: ${res.status}`);
  const body = await res.arrayBuffer();
  const t1 = performance.now();
  return { durationMs: t1 - t0, bytes: body.byteLength };
}

describe("OCI registry bench (cloister-3a3b0d push/pull)", () => {
  it(`measures monolithic push (small=${SMALL_BYTES}B, medium=${MEDIUM_BYTES}B, large=${LARGE_BYTES}B; n=${ITERATIONS})`,
     async () => {
    const route = makeRoute();
    const env   = makeEnv();
    const rows: Array<{ label: string; size: number; stats: ReturnType<typeof summarize>; mbps: number }> = [];

    for (const [label, size] of [
      ["small",  SMALL_BYTES],
      ["medium", MEDIUM_BYTES],
      ["large",  LARGE_BYTES],
    ] as const) {
      const samples: number[] = [];
      for (let i = 0; i < WARMUP; i++) {
        await pushMonolithic(route, env, randomBytes(size));
      }
      for (let i = 0; i < ITERATIONS; i++) {
        const { durationMs } = await pushMonolithic(route, env, randomBytes(size));
        samples.push(durationMs);
      }
      const stats = summarize(samples);
      const mbps  = (size / 1e6) / (stats.mean / 1000);
      rows.push({ label, size, stats, mbps });
    }

    console.log("\nBENCH RESULTS - OCI monolithic push (anonymous mode)");
    console.log("");
    console.log("| Size | bytes | n | mean (ms) | p50 (ms) | p99 (ms) | MB/s (mean) |");
    console.log("|---|---:|---:|---:|---:|---:|---:|");
    for (const { label, size, stats, mbps } of rows) {
      console.log(`| ${label} | ${size} | ${ITERATIONS} | ${fmt(stats.mean)} | ${fmt(stats.p50)} | ${fmt(stats.p99)} | ${fmt(mbps)} |`);
    }
  }, 60_000);

  it(`measures chunked push (medium=${MEDIUM_BYTES}B in 16KB chunks; n=${ITERATIONS})`, async () => {
    const route = makeRoute();
    const env   = makeEnv();
    const chunkSize = 16 * 1024;
    const samples: number[] = [];
    for (let i = 0; i < WARMUP; i++) {
      await pushChunked(route, env, randomBytes(MEDIUM_BYTES), chunkSize);
    }
    for (let i = 0; i < ITERATIONS; i++) {
      const { durationMs } = await pushChunked(route, env, randomBytes(MEDIUM_BYTES), chunkSize);
      samples.push(durationMs);
    }
    const stats = summarize(samples);
    const mbps  = (MEDIUM_BYTES / 1e6) / (stats.mean / 1000);
    const nChunks = Math.ceil(MEDIUM_BYTES / chunkSize);

    console.log("\nBENCH RESULTS - OCI chunked push (anonymous mode)");
    console.log(`  payload=${MEDIUM_BYTES}B, chunk=${chunkSize}B, n_chunks=${nChunks}, samples=${ITERATIONS}`);
    console.log("");
    console.log("| Metric | Value |");
    console.log("|---|---:|");
    console.log(`| mean (ms)        | ${fmt(stats.mean)} |`);
    console.log(`| p50 (ms)         | ${fmt(stats.p50)}  |`);
    console.log(`| p99 (ms)         | ${fmt(stats.p99)}  |`);
    console.log(`| min (ms)         | ${fmt(stats.min)}  |`);
    console.log(`| max (ms)         | ${fmt(stats.max)}  |`);
    console.log(`| MB/s (mean)      | ${fmt(mbps)}       |`);
    console.log(`| ms/chunk (mean)  | ${fmt(stats.mean / nChunks)} |`);
  }, 60_000);

  it(`measures manifest PUT + GET round-trip (n=${ITERATIONS})`, async () => {
    const route = makeRoute();
    const env   = makeEnv();
    // Push a config blob first so the manifest can reference a real digest.
    const configBytes = randomBytes(SMALL_BYTES);
    const { digest: configDigest } = await pushMonolithic(route, env, configBytes);

    const manifestPayload = (size: number) => new TextEncoder().encode(JSON.stringify({
      schemaVersion: 2,
      mediaType:     "application/vnd.oci.image.manifest.v1+json",
      config:        { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: SMALL_BYTES },
      layers:        [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: configDigest, size: SMALL_BYTES }],
      annotations:   { "org.opencontainers.image.created": new Date().toISOString(), "bench.iteration": String(size) },
    }));

    const putSamples: number[] = [];
    const getSamples: number[] = [];

    for (let i = 0; i < WARMUP; i++) {
      const tag = `bench-${i}-warmup`;
      const payload = manifestPayload(i);
      await putManifest(route, env, tag, payload);
      await getManifest(route, env, tag);
    }
    for (let i = 0; i < ITERATIONS; i++) {
      const tag = `bench-${i}`;
      const payload = manifestPayload(i);
      const { durationMs: putMs } = await putManifest(route, env, tag, payload);
      putSamples.push(putMs);
      const { durationMs: getMs } = await getManifest(route, env, tag);
      getSamples.push(getMs);
    }

    const putStats = summarize(putSamples);
    const getStats = summarize(getSamples);

    console.log("\nBENCH RESULTS - OCI manifest PUT + GET (anonymous mode)");
    console.log(`  payload≈400B JSON, samples=${ITERATIONS}`);
    console.log("");
    console.log("| Op | mean (ms) | p50 (ms) | p99 (ms) | min (ms) | max (ms) |");
    console.log("|---|---:|---:|---:|---:|---:|");
    console.log(`| PUT manifest | ${fmt(putStats.mean)} | ${fmt(putStats.p50)} | ${fmt(putStats.p99)} | ${fmt(putStats.min)} | ${fmt(putStats.max)} |`);
    console.log(`| GET manifest | ${fmt(getStats.mean)} | ${fmt(getStats.p50)} | ${fmt(getStats.p99)} | ${fmt(getStats.min)} | ${fmt(getStats.max)} |`);
  }, 60_000);

  it(`measures blob GET pull (small / medium / large; n=${ITERATIONS})`, async () => {
    const route = makeRoute();
    const env   = makeEnv();
    const fixtures: Array<{ label: string; size: number; digest: string }> = [];
    for (const [label, size] of [
      ["small",  SMALL_BYTES],
      ["medium", MEDIUM_BYTES],
      ["large",  LARGE_BYTES],
    ] as const) {
      const { digest } = await pushMonolithic(route, env, randomBytes(size));
      fixtures.push({ label, size, digest });
    }

    console.log("\nBENCH RESULTS - OCI blob GET (anonymous mode, post-push cache state)");
    console.log("");
    console.log("| Size | bytes | n | mean (ms) | p50 (ms) | p99 (ms) | MB/s (mean) |");
    console.log("|---|---:|---:|---:|---:|---:|---:|");
    for (const { label, size, digest } of fixtures) {
      const samples: number[] = [];
      for (let i = 0; i < WARMUP; i++) await getBlob(route, env, digest);
      for (let i = 0; i < ITERATIONS; i++) {
        const { durationMs } = await getBlob(route, env, digest);
        samples.push(durationMs);
      }
      const stats = summarize(samples);
      const mbps  = (size / 1e6) / (stats.mean / 1000);
      console.log(`| ${label} | ${size} | ${ITERATIONS} | ${fmt(stats.mean)} | ${fmt(stats.p50)} | ${fmt(stats.p99)} | ${fmt(mbps)} |`);
    }
  }, 60_000);
});
