// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TrustStore RPC contention microbenchmark (cloister-e4daae surface 2).
//
// EXCLUDED from `task lint` / `task test` — runs only via
// `task bench:trust-store` (uses `vitest.bench.config.ts`).
//
// Models two production realities the lease-pipeline doc didn't:
//
//   1. **Steady-state (populated tables)** — the lease-pipeline doc
//      measured `verifyLeaseAndAdvanceChain` against a freshly-wiped
//      table. Production has thousands of rows in `seen_nonces`. Does
//      the SQLite PK index keep INSERT-OR-NOTHING at O(log n) in
//      practice, or does row-count drift the mean latency upward?
//
//   2. **Contention** — workerd's DO input gate serializes inbound RPCs
//      to a singleton DO. Two/many concurrent requests against the same
//      `idFromName("cluster")` queue at the gate; per-request latency
//      should grow ~linearly with N at constant throughput.
//
// Both measurements use the post-batching `verifyLeaseAndAdvanceChain`
// RPC (cloister-ee51b8), since that's the live hot path. Per-call
// samples + loop-divide means per the standard methodology in
// `lease-pipeline.test.ts`.

/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

// ── Iteration counts ─────────────────────────────────────────────────

const PREFILL_NONCE_ROWS = 10_000;
const STEADY_STATE_N     = 500;
const WARMUP             = 30;
const CONTENTION_LEVELS  = [1, 10, 50, 100];

// ── helpers ──────────────────────────────────────────────────────────

interface TrustStoreRpc {
  verifyLeaseAndAdvanceChain(args: {
    peerFp: string;
    certFp: string;
    nonce:  string;
    ts:     number;
  }): Promise<
    | { replayed: true }
    | { replayed: false; seq: number; last_chain_hash: string }
  >;
  recordSeenNonce(certFp: string, nonce: string, tsMs: number): Promise<{ fresh: boolean }>;
  upsertLeaseCounter(peerFp: string, certFp: string, nonce: string, ts: number): Promise<{ seq: number; last_chain_hash: string }>;
}

function getTrustStore(): DurableObjectStub & TrustStoreRpc {
  return env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & TrustStoreRpc;
}

async function resetTrustStore(): Promise<void> {
  const stub = getTrustStore();
  await runInDurableObject(stub, async (_, state) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
}

async function prefillSeenNonces(rows: number): Promise<void> {
  const stub = getTrustStore();
  await runInDurableObject(stub, async (_, state) => {
    const sql = state.storage.sql;
    for (let i = 0; i < rows; i++) {
      sql.exec(
        `INSERT INTO seen_nonces (cert_fp, nonce, ts_ms) VALUES (?, ?, ?)`,
        `prefill-cert-${(i % 8).toString(16)}`,
        `prefill-nonce-${i.toString(16).padStart(8, "0")}`,
        1_700_000_000_000 + i,
      );
    }
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarize(samples: number[]): { mean: number; p50: number; p99: number; min: number; max: number } {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    mean: samples.reduce((s, v) => s + v, 0) / samples.length,
    p50:  percentile(sorted, 50),
    p99:  percentile(sorted, 99),
    min:  sorted[0]!,
    max:  sorted[sorted.length - 1]!,
  };
}

const CERT_FP   = "sha256:bench-cert-fingerprint";
const PEER_FP_A = "sha256:bench-peer-a";
const TS_BASE   = 1_700_001_000_000;

describe("TrustStore contention bench (cloister-e4daae surface 2)", () => {
  it(`steady-state (n=${STEADY_STATE_N}) + contention sweep`, async () => {
    const lines: string[] = [];
    lines.push("");
    lines.push("BENCH RESULTS - TrustStore contention (cloister-e4daae surface 2)");
    lines.push(`PREFILL_NONCE_ROWS=${PREFILL_NONCE_ROWS}, STEADY_STATE_N=${STEADY_STATE_N}, WARMUP=${WARMUP}`);
    lines.push("workerd via vitest cloudflarePool. Single singleton TrustStore DO; concurrent");
    lines.push("calls queue at workerd's input gate (per-DO serialization).");
    lines.push("");

    // ── Section A: Fresh-table baseline (matches lease-pipeline doc) ──
    await resetTrustStore();
    const trust = getTrustStore();
    for (let i = 0; i < WARMUP; i++) {
      await resetTrustStore();
      await trust.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP_A, certFp: CERT_FP,
        nonce: `freshwarm-${i}`, ts: TS_BASE + i,
      });
    }
    const freshSamples: number[] = [];
    for (let i = 0; i < STEADY_STATE_N; i++) {
      await resetTrustStore();
      const t0 = performance.now();
      const r = await trust.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP_A, certFp: CERT_FP,
        nonce: `fresh-${i.toString(16)}`, ts: TS_BASE + i,
      });
      freshSamples.push(performance.now() - t0);
      if (r.replayed) throw new Error("unexpected replay");
    }
    await resetTrustStore();
    let t0 = performance.now();
    for (let i = 0; i < STEADY_STATE_N; i++) {
      await resetTrustStore();
      await trust.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP_A, certFp: CERT_FP,
        nonce: `freshloop-${i.toString(16)}`, ts: TS_BASE + i,
      });
    }
    const freshLoopMs = performance.now() - t0;

    const fresh = summarize(freshSamples);
    lines.push("### Fresh-table baseline (tables reset before each call)");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (per-call) | ${fresh.mean.toFixed(3)} |`);
    lines.push(`| p50             | ${fresh.p50.toFixed(3)} |`);
    lines.push(`| p99             | ${fresh.p99.toFixed(3)} |`);
    lines.push(`| min             | ${fresh.min.toFixed(3)} |`);
    lines.push(`| max             | ${fresh.max.toFixed(3)} |`);
    lines.push(`| mean (loop-divide, n=${STEADY_STATE_N}) | ${(freshLoopMs / STEADY_STATE_N).toFixed(3)} |`);
    lines.push("");

    // ── Section B: Steady-state (10k pre-fill, no per-iteration reset) ──
    await resetTrustStore();
    await prefillSeenNonces(PREFILL_NONCE_ROWS);
    for (let i = 0; i < WARMUP; i++) {
      await trust.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP_A, certFp: CERT_FP,
        nonce: `warm-${i.toString(16)}`, ts: TS_BASE + 1_000_000 + i,
      });
    }
    const steadySamples: number[] = [];
    for (let i = 0; i < STEADY_STATE_N; i++) {
      const t = performance.now();
      const r = await trust.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP_A, certFp: CERT_FP,
        nonce: `steady-${i.toString(16)}`, ts: TS_BASE + 2_000_000 + i,
      });
      steadySamples.push(performance.now() - t);
      if (r.replayed) throw new Error("unexpected replay");
    }
    t0 = performance.now();
    for (let i = 0; i < STEADY_STATE_N; i++) {
      await trust.verifyLeaseAndAdvanceChain({
        peerFp: PEER_FP_A, certFp: CERT_FP,
        nonce: `steadyloop-${i.toString(16)}`, ts: TS_BASE + 3_000_000 + i,
      });
    }
    const steadyLoopMs = performance.now() - t0;
    const steady = summarize(steadySamples);

    lines.push(`### Steady-state (seen_nonces pre-filled with ${PREFILL_NONCE_ROWS} rows)`);
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (per-call) | ${steady.mean.toFixed(3)} |`);
    lines.push(`| p50             | ${steady.p50.toFixed(3)} |`);
    lines.push(`| p99             | ${steady.p99.toFixed(3)} |`);
    lines.push(`| min             | ${steady.min.toFixed(3)} |`);
    lines.push(`| max             | ${steady.max.toFixed(3)} |`);
    lines.push(`| mean (loop-divide, n=${STEADY_STATE_N}) | ${(steadyLoopMs / STEADY_STATE_N).toFixed(3)} |`);
    lines.push("");
    lines.push("**Steady-state vs fresh-table delta:**");
    lines.push(`mean: ${(steady.mean - fresh.mean).toFixed(3)} ms; ` +
               `p99: ${(steady.p99 - fresh.p99).toFixed(3)} ms`);
    lines.push("");

    // ── Section C: Contention sweep ──────────────────────────────────
    await resetTrustStore();
    await prefillSeenNonces(PREFILL_NONCE_ROWS);

    lines.push("### Contention sweep (concurrent verifyLeaseAndAdvanceChain on singleton DO)");
    lines.push("");
    lines.push("Each batch is N concurrent Promise.all calls. Same DO instance");
    lines.push("(idFromName(\"cluster\")), different peer fingerprints per call");
    lines.push("so the per-peer lease counter rows don't share-key.");
    lines.push("");
    lines.push("| N concurrent | wall time (ms) | per-req latency (ms) | throughput (req/s) |");
    lines.push("|---:|---:|---:|---:|");

    {
      const promises: Promise<unknown>[] = [];
      for (let j = 0; j < 5; j++) {
        promises.push(trust.verifyLeaseAndAdvanceChain({
          peerFp: `peer-warm-${j}`, certFp: CERT_FP,
          nonce: `cont-warm-${j}`, ts: TS_BASE + 5_000_000 + j,
        }));
      }
      await Promise.all(promises);
    }

    let nonceCounter = 10_000_000;
    for (const N of CONTENTION_LEVELS) {
      const batches = N === 1 ? 50 : 20;
      let totalWall = 0;
      for (let batch = 0; batch < batches; batch++) {
        const promises: Promise<unknown>[] = [];
        const base = nonceCounter;
        nonceCounter += N + 1;
        const tStart = performance.now();
        for (let j = 0; j < N; j++) {
          promises.push(trust.verifyLeaseAndAdvanceChain({
            peerFp: `peer-cont-${j}-${batch}`,
            certFp: CERT_FP,
            nonce: `cont-${(base + j).toString(16)}`,
            ts: TS_BASE + 6_000_000 + base + j,
          }));
        }
        await Promise.all(promises);
        totalWall += performance.now() - tStart;
      }
      const avgWall = totalWall / batches;
      const perReq = avgWall / N;
      const throughput = (N * 1000) / avgWall;
      lines.push(`| ${N} | ${avgWall.toFixed(2)} | ${perReq.toFixed(3)} | ${throughput.toFixed(0)} |`);
    }
    lines.push("");

    // ── Section D: Legacy two-RPC pair for comparison ────────────────
    await resetTrustStore();
    await prefillSeenNonces(PREFILL_NONCE_ROWS);
    for (let i = 0; i < WARMUP; i++) {
      await trust.recordSeenNonce(CERT_FP, `legacy-warm-${i}`, TS_BASE + 7_000_000 + i);
      await trust.upsertLeaseCounter(PEER_FP_A, CERT_FP, `legacy-warm-${i}`, TS_BASE + 7_000_000 + i);
    }
    t0 = performance.now();
    for (let i = 0; i < STEADY_STATE_N; i++) {
      const nonce = `legacy-${i.toString(16)}`;
      const ts = TS_BASE + 8_000_000 + i;
      await trust.recordSeenNonce(CERT_FP, nonce, ts);
      await trust.upsertLeaseCounter(PEER_FP_A, CERT_FP, nonce, ts);
    }
    const legacyLoopMs = performance.now() - t0;

    lines.push("### Legacy two-RPC pair (recordSeenNonce + upsertLeaseCounter), populated table");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (loop-divide, n=${STEADY_STATE_N}) | ${(legacyLoopMs / STEADY_STATE_N).toFixed(3)} |`);
    lines.push("");
    lines.push(`Batched / legacy ratio: ${((steadyLoopMs / STEADY_STATE_N) / (legacyLoopMs / STEADY_STATE_N)).toFixed(2)}× ` +
               `(lower = batched wins).`);
    lines.push("");

    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, 600_000);
});
