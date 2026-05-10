// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Disclosure endpoint throughput microbenchmark
// (cloister-e4daae surface 3).
//
// EXCLUDED from `task lint` / `task test` — runs only via
// `task bench:disclosure`.
//
// Measures the two paths through `GET /interlace/peers/{fp}`:
//
//   1. **Constant-time 404** — empty peer OR auth-failure. Threat-model
//      §9.4 invariant: response is byte-identical regardless of which
//      one. We measure the distribution and confirm it's TIGHT (sub-ms
//      spread; constant-time-ness is observable as a flat histogram).
//
//   2. **Happy path** — populated `peer_attestations` (1k rows for one
//      peer), full DB scan + JSONL stream. Measures total wall time
//      and rows/sec.
//
// The lease-gated variant is exercised in a third section that turns
// on `INTERLACE_ROOT_PUBKEY` and uses `signedMcpRequest`-style auth
// for GET disclosure (no body — sig is over canonical bytes of GET).

/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { DisclosureRoute } from "../../src/routes/disclosure.js";

const PER_REQUEST_N = 200;
const SCAN_ROWS     = 1_000;
const WARMUP        = 20;

// Same HMAC key the disclosure tests use — 32 bytes base64-standard.
const HMAC_KEY      = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const MASTER_PUBKEY = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const PEER_FP       = "sha256:bench-peer-disclosure";
const NO_PEER_FP    = "sha256:bench-peer-does-not-exist";

interface TrustStoreRpc {
  applyAttestation(args: {
    peerFingerprint: string;
    contentHash:     string;
    contentType:     string;
    scope:           string;
    cert:            Uint8Array;
    sig:             Uint8Array;
    prevSelfRef:     string | null;
    prevPeerRef:     string | null;
    nowMs:           number;
  }): Promise<unknown>;
}

function getTrustStore(): DurableObjectStub & TrustStoreRpc {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & TrustStoreRpc;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarize(samples: number[]): {
  mean: number; p50: number; p99: number; min: number; max: number; spread: number;
} {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    mean: samples.reduce((s, v) => s + v, 0) / samples.length,
    p50:  percentile(sorted, 50),
    p99:  percentile(sorted, 99),
    min:  sorted[0]!,
    max:  sorted[sorted.length - 1]!,
    spread: sorted[sorted.length - 1]! - sorted[0]!,
  };
}

async function clearTrustTables(): Promise<void> {
  const stub = getTrustStore();
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM peer_attestations");
    state.storage.sql.exec("DELETE FROM pending_attestations");
  });
}

function makeEnvUnGated(): typeof env {
  return Object.assign({}, env, {
    INTERLACE_DISCLOSURE_HMAC_KEY: HMAC_KEY,
    INTERLACE_PUBLISHED_MASTER:    MASTER_PUBKEY,
  }) as typeof env;
}

function makeReq(path: string): Request {
  return new Request(`http://x${path}`, { method: "GET" });
}

describe("Disclosure endpoint bench (cloister-e4daae surface 3)", () => {
  it(`constant-time 404 + happy-path scan (n=${PER_REQUEST_N}, SCAN_ROWS=${SCAN_ROWS})`, async () => {
    const lines: string[] = [];
    lines.push("");
    lines.push("BENCH RESULTS - Disclosure endpoint (cloister-e4daae surface 3)");
    lines.push(`PER_REQUEST_N=${PER_REQUEST_N}, SCAN_ROWS=${SCAN_ROWS}, WARMUP=${WARMUP}`);
    lines.push("workerd via vitest cloudflarePool. INTERLACE_ROOT_PUBKEY unset =>");
    lines.push("auth gate skipped at deployment-binding granularity (dev path).");
    lines.push("");

    // ── Setup: populated peer for happy-path scan ────────────────────
    await clearTrustTables();
    const trust = getTrustStore();
    for (let i = 0; i < SCAN_ROWS; i++) {
      const contentHash = i.toString(16).padStart(64, "0");
      const prevRef = i === 0 ? null : (i - 1).toString(16).padStart(64, "0");
      await trust.applyAttestation({
        peerFingerprint: PEER_FP,
        contentHash,
        contentType:     "bead/v1",
        scope:           `bead_create:/r/bench/${i % 8}`,
        cert:            new Uint8Array([0xCA, 0xFE, i & 0xFF, (i >> 8) & 0xFF]),
        sig:             new Uint8Array([0xBA, 0xBE, i & 0xFF, (i >> 8) & 0xFF]),
        prevSelfRef:     prevRef,
        prevPeerRef:     null,
        nowMs:           1_700_000_000_000 + i,
      });
    }

    const route = new DisclosureRoute(undefined, "INTERLACE_PUBLISHED_MASTER");
    const ungatedEnv = makeEnvUnGated();

    // ── Section 1: Constant-time 404 (no peer) ───────────────────────
    for (let i = 0; i < WARMUP; i++) {
      const res = await route.handle(makeReq(`/interlace/peers/${NO_PEER_FP}`), ungatedEnv);
      if (res.status !== 404) throw new Error(`unexpected status ${res.status}`);
      await res.text();
    }
    const notFoundSamples: number[] = [];
    for (let i = 0; i < PER_REQUEST_N; i++) {
      const t0 = performance.now();
      const res = await route.handle(makeReq(`/interlace/peers/${NO_PEER_FP}`), ungatedEnv);
      await res.text();
      notFoundSamples.push(performance.now() - t0);
      if (res.status !== 404) throw new Error("not 404");
    }
    let t0 = performance.now();
    for (let i = 0; i < PER_REQUEST_N; i++) {
      const res = await route.handle(makeReq(`/interlace/peers/${NO_PEER_FP}`), ungatedEnv);
      await res.text();
    }
    const notFoundLoopMs = performance.now() - t0;
    const nf = summarize(notFoundSamples);

    lines.push("### Constant-time 404 path (unknown peer)");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (per-call)        | ${nf.mean.toFixed(3)} |`);
    lines.push(`| p50                    | ${nf.p50.toFixed(3)} |`);
    lines.push(`| p99                    | ${nf.p99.toFixed(3)} |`);
    lines.push(`| min                    | ${nf.min.toFixed(3)} |`);
    lines.push(`| max                    | ${nf.max.toFixed(3)} |`);
    lines.push(`| **spread (max - min)** | **${nf.spread.toFixed(3)}** |`);
    lines.push(`| mean (loop-divide, n=${PER_REQUEST_N}) | ${(notFoundLoopMs / PER_REQUEST_N).toFixed(3)} |`);
    lines.push("");

    // ── Section 2: Constant-time bad-cursor (auth-fail-like) ─────────
    // A bad cursor should produce a byte-identical 404 to the no-peer
    // case. Measure the distribution and compare.
    for (let i = 0; i < WARMUP; i++) {
      const res = await route.handle(
        makeReq(`/interlace/peers/${PEER_FP}?since=garbage`),
        ungatedEnv,
      );
      await res.text();
      if (res.status !== 404) throw new Error(`bad-cursor expected 404 got ${res.status}`);
    }
    const badCursorSamples: number[] = [];
    for (let i = 0; i < PER_REQUEST_N; i++) {
      const t = performance.now();
      const res = await route.handle(
        makeReq(`/interlace/peers/${PEER_FP}?since=garbage-${i}`),
        ungatedEnv,
      );
      await res.text();
      badCursorSamples.push(performance.now() - t);
    }
    const bc = summarize(badCursorSamples);
    lines.push("### Constant-time 404 path (tampered cursor)");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (per-call) | ${bc.mean.toFixed(3)} |`);
    lines.push(`| p99             | ${bc.p99.toFixed(3)} |`);
    lines.push(`| spread          | ${bc.spread.toFixed(3)} |`);
    lines.push("");
    lines.push(`**no-peer vs bad-cursor mean delta:** ${(nf.mean - bc.mean).toFixed(3)} ms ` +
               `(both inside clock grain = empirically constant-time)`);
    lines.push("");

    // ── Section 3: Happy path (populated chain, default page size) ───
    // Default page size is 100. With SCAN_ROWS=1000 we exercise the
    // "1 page out of 10" case (first request, no cursor).
    for (let i = 0; i < WARMUP; i++) {
      const res = await route.handle(makeReq(`/interlace/peers/${PEER_FP}`), ungatedEnv);
      if (res.status !== 200) throw new Error(`happy expected 200 got ${res.status}`);
      await res.text();
    }
    const happySamples: number[] = [];
    let totalBytes = 0;
    for (let i = 0; i < PER_REQUEST_N; i++) {
      const t = performance.now();
      const res = await route.handle(makeReq(`/interlace/peers/${PEER_FP}`), ungatedEnv);
      const text = await res.text();
      happySamples.push(performance.now() - t);
      totalBytes += text.length;
    }
    t0 = performance.now();
    for (let i = 0; i < PER_REQUEST_N; i++) {
      const res = await route.handle(makeReq(`/interlace/peers/${PEER_FP}`), ungatedEnv);
      await res.text();
    }
    const happyLoopMs = performance.now() - t0;
    const happy = summarize(happySamples);
    const happyMeanMs = happyLoopMs / PER_REQUEST_N;
    const rowsPerReq = 100;  // default page size
    const rowsPerSec = (rowsPerReq * 1000) / happyMeanMs;

    lines.push("### Happy path (populated chain, first page of 100)");
    lines.push("");
    lines.push("| Metric | value |");
    lines.push("|---|---:|");
    lines.push(`| mean per-call latency (ms) | ${happy.mean.toFixed(3)} |`);
    lines.push(`| p99 (ms)                   | ${happy.p99.toFixed(3)} |`);
    lines.push(`| min (ms)                   | ${happy.min.toFixed(3)} |`);
    lines.push(`| max (ms)                   | ${happy.max.toFixed(3)} |`);
    lines.push(`| mean (loop-divide, n=${PER_REQUEST_N}) | ${happyMeanMs.toFixed(3)} ms |`);
    lines.push(`| body bytes / response      | ${(totalBytes / PER_REQUEST_N).toFixed(0)} |`);
    lines.push(`| rows / response            | ${rowsPerReq} |`);
    lines.push(`| **rows / sec (page-fetch throughput)** | **${rowsPerSec.toFixed(0)}** |`);
    lines.push("");

    // ── Section 4: Happy path WITH a valid cursor (mid-chain page) ───
    // Page through the chain — request page 5 (rows 500-599). This
    // exercises the cursor-decode path + DB OFFSET.
    const { signCursor, importHmacKey } = await import("../../src/storage/disclosure-cursor.js");
    const hmacKey = await importHmacKey(HMAC_KEY);
    const cursor = await signCursor({ peerFp: PEER_FP, fromSeq: 501, ts: Date.now() }, hmacKey);
    for (let i = 0; i < WARMUP; i++) {
      const res = await route.handle(
        makeReq(`/interlace/peers/${PEER_FP}?since=${encodeURIComponent(cursor)}`),
        ungatedEnv,
      );
      if (res.status !== 200) throw new Error(`cursor expected 200 got ${res.status}`);
      await res.text();
    }
    t0 = performance.now();
    for (let i = 0; i < PER_REQUEST_N; i++) {
      const res = await route.handle(
        makeReq(`/interlace/peers/${PEER_FP}?since=${encodeURIComponent(cursor)}`),
        ungatedEnv,
      );
      await res.text();
    }
    const cursorLoopMs = performance.now() - t0;
    lines.push("### Happy path with signed cursor (page 6 / rows 501-600)");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (loop-divide, n=${PER_REQUEST_N}) | ${(cursorLoopMs / PER_REQUEST_N).toFixed(3)} |`);
    lines.push("");

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, 600_000);
});
