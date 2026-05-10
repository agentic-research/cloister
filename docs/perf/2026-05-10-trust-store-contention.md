# TrustStore RPC contention perf — 2026-05-10

Per-call latency for `TrustStore.verifyLeaseAndAdvanceChain`
(`src/trust-store.ts`) under populated tables and concurrent load.
Surface 2 of cloister-e4daae; complements the fresh-table baseline in
[`2026-05-10-lease-pipeline.md`](2026-05-10-lease-pipeline.md).

## TL;DR

| Scenario | mean (ms) | Notes |
|---|---:|---|
| Fresh-table baseline (loop-divide)            | **0.71** | tables reset before every call; includes reset cost |
| Steady-state (10k `seen_nonces` rows)         | **0.35** | populated index; mean unchanged from fresh-table within noise |
| Legacy two-RPC pair (populated, sequential)   | **0.68** | `recordSeenNonce` + `upsertLeaseCounter` back-to-back |
| Batched/legacy ratio                          | **0.51×** | batched RPC roughly halves the cross-DO cost |

Contention sweep:

| N concurrent | wall time | per-req latency | throughput |
|---:|---:|---:|---:|
| 1   |  0.36 ms |  0.360 ms | 2,778 req/s |
| 10  |  1.95 ms |  0.195 ms | 5,128 req/s |
| 50  | 10.80 ms |  0.216 ms | 4,630 req/s |
| 100 | 20.05 ms |  0.201 ms | 4,988 req/s |

**Two surprises:**

1. **Steady-state is NOT slower than fresh-table.** A 10k-row
   `seen_nonces` table has no measurable impact on
   `INSERT-OR-NOTHING` cost. SQLite's PK index keeps lookup at
   O(log n) and 10k is well inside the cache; effectively constant.
   The lease-pipeline doc's fresh-table numbers generalize cleanly
   to production-shape data.

2. **Per-request latency goes DOWN from N=1 to N=10**, then plateaus.
   This is workerd's batching: 10 concurrent RPC arrivals get dispatched
   together at the input gate, amortizing the cross-isolate scheduling
   overhead. Beyond N=10 the gate is saturated and throughput plateaus
   at ~5000 req/s. Per-request latency is constant ~200µs above N=10 —
   the work itself, not the gate wait.

## Environment

- Host: Apple M3 Max, macOS 26.3.1 (Darwin 25.3.0)
- Node: v25.9.0
- workerd: `2025-07-18`
- vitest: v4.1.5
- Test driver: `test/perf/trust-store-contention.test.ts` under
  `vitest.bench.config.ts`
- Iteration counts: `STEADY_STATE_N=500`, `WARMUP=30`,
  `PREFILL_NONCE_ROWS=10_000`, `CONTENTION_LEVELS=[1,10,50,100]`

## Methodology

Same loop-divide pattern as `lease-pipeline.test.ts` for sub-ms
resolution. Four sections:

1. **Fresh-table baseline.** `seen_nonces` + `peer_lease_counters`
   wiped before every call. Mirrors the lease-pipeline doc; ~0.4ms is
   `verifyLeaseAndAdvanceChain` itself, the rest is `resetTrustStore`
   per-iteration overhead.

2. **Steady-state.** Prefill `seen_nonces` with 10k rows (different
   `(cert_fp, nonce)` tuples), then run the same N=500 loop **without
   resetting between calls**. Tests whether the SQLite PK index keeps
   INSERT-OR-NOTHING constant-time at production-realistic row counts.

3. **Contention sweep.** N concurrent calls fired via `Promise.all`
   against the same singleton TrustStore (`idFromName("cluster")`).
   Different peer fingerprints per call so the per-peer
   lease-counter rows don't share-key. Wait for batch to settle;
   record wall time, derive per-request latency + throughput. 50
   batches at N=1 (small-batch variance), 20 at N≥10.

4. **Legacy two-RPC pair.** `recordSeenNonce` + `upsertLeaseCounter`
   back-to-back on a populated table. Confirms the batched RPC is
   still the right choice after the table grows — the
   `transactionSync` cost is amortized, not regressing.

Reproduce: `task bench:trust-store`. Source in
[`test/perf/trust-store-contention.test.ts`](../../test/perf/trust-store-contention.test.ts).

## Results

### Fresh-table baseline

| Metric | value (ms) |
|---|---:|
| mean (per-call) | 0.412 |
| p50  | 0.000 |
| p99  | 1.000 |
| min  | 0.000 |
| max  | 3.000 |
| mean (loop-divide, n=500) | 0.710 |

The loop-divide mean (0.71ms) includes `resetTrustStore` overhead
(~0.3ms per iteration of two DELETE statements through `runInDurableObject`).
The lease-pipeline doc's pipeline-end-to-end mean of 0.52ms is consistent
once you net out the prefix cost of cert verify + sig verify (~130µs).

### Steady-state (10k pre-filled `seen_nonces` rows)

| Metric | value (ms) |
|---|---:|
| mean (per-call) | 0.378 |
| p50  | 0.000 |
| p99  | 1.000 |
| min  | 0.000 |
| max  | 3.000 |
| mean (loop-divide, n=500) | 0.348 |

**Steady-state per-call latency is unchanged from fresh-table within
noise** (0.412 → 0.378 ms — well inside the 1ms clock grain).
The loop-divide mean is LOWER (0.348 vs 0.710) because we no longer
pay the per-iteration reset cost — that's the "real" production-shape
number.

### Contention sweep

| N concurrent | wall time (ms) | per-req latency (ms) | throughput (req/s) |
|---:|---:|---:|---:|
| 1   |  0.36 |  0.360 | 2,778 |
| 10  |  1.95 |  0.195 | 5,128 |
| 50  | 10.80 |  0.216 | 4,630 |
| 100 | 20.05 |  0.201 | 4,988 |

**Throughput curve:** rises from N=1 (2,778 req/s) to N=10 (5,128 req/s),
then plateaus around 4,800-5,100 req/s through N=100. This is the
expected shape for a serializing input gate:

- **Below the gate's batching threshold** (N<10), the gate processes
  each call individually; the per-request overhead is the gate-wakeup
  cost.
- **Around the threshold** (N≈10), workerd batches arrivals into a single
  dispatch window; per-request latency drops because the wakeup cost
  is amortized across the batch.
- **Above the threshold** (N≥10), throughput is bound by the gate's
  steady-state dispatch rate. Per-request latency from inside the
  batch is constant (~200µs), but wall time grows linearly with N.

The throughput plateau (~5000 req/s on local workerd) is the gate's
saturation point for this DO + this workload. CF Workers' input gate
implementation differs from miniflare's; expect a different absolute
number on prod, same SHAPE.

### Legacy two-RPC pair (populated table)

| Metric | value (ms) |
|---|---:|
| mean (loop-divide, n=500) | 0.676 |

Batched/legacy ratio: **0.51×** — the batched RPC is roughly 2× faster
than the back-to-back legacy pair, consistent with the lease-pipeline
doc's measurement on the fresh table. The ratio holds across
table-state, which means the optimization isn't a fresh-table artifact
— the cross-DO RPC overhead is the dominant constant, not the SQL
cost.

## Interpretation

**The lease-pipeline doc's numbers generalize.** A 10k-row prefill
doesn't move the needle on `verifyLeaseAndAdvanceChain` cost. We can
trust the 520µs pipeline mean as a production-shape number, not a
fresh-table artifact.

**The DO input gate is the throughput ceiling.** ~5000 req/s per
TrustStore on local workerd. Past that, requests queue and per-request
latency grows linearly with concurrency. For a production deploy
expecting > 5000 RPS of authenticated traffic, either CF Workers'
gate is faster than miniflare's (likely) or we need to shard the
singleton — which would require a peer-fingerprint-keyed DO instead
of `idFromName("cluster")` and a corresponding ADR update.

**The batched RPC is still the right call.** 0.51× ratio over the
legacy pair holds at 10k rows. The transactionSync overhead doesn't
grow with table size — it's a fixed cost amortized over two writes,
and amortizing once is cheaper than two separate auto-commit transactions.

### Possible follow-ups

- **Profile the gate batching curve more finely.** Sweep N from 1-100
  in finer steps (every 5) to find the exact N where the throughput
  plateau begins. Useful for capacity planning.
- **Shard TrustStore by peer fingerprint.** If we ever need > 5000 RPS
  authenticated traffic, the singleton is the bottleneck. Sharding
  splits the per-peer state across multiple DOs; the `seen_nonces`
  table is per-cert so it would also shard cleanly. This is an
  ADR-level change (touches ADR-0011's three-criterion test).
- **GC the `seen_nonces` table.** The current prune helper is
  unwired; if the table grows unbounded for years, eventually the
  PK index becomes a real cost. Not urgent — 10k rows is noise; 10M
  rows might not be.

## Caveats

- **Local workerd ≠ Cloudflare Workers prod.** CF's input gate
  implementation is not the same as miniflare's; the absolute
  throughput plateau number will differ. The SHAPE (linear-with-N
  past the batching threshold) is general.
- **One DO instance.** All measurements are against `idFromName("cluster")`.
  No cross-instance contention (there's only one).
- **Same peer.** Sections A, B, D all use a single peer fingerprint.
  Different peers would exercise different
  `peer_lease_counters` rows; the bench's contention section uses
  N distinct peers to model that case.
- **No background traffic.** The bench has the DO entirely to itself.
  Production has periodic GC sweeps, alarm-driven retry pumps, etc.,
  competing for the input gate.
- **Clock quantization.** All sub-ms numbers are loop-divide; per-call
  p99 is reported but lives at the 1ms grain.
- **Prefill cost.** The 10k row prefill takes ~1.5s; the bench
  budgets 10min total to absorb it.

## Related

- Tracking bead: `cloister-e4daae`.
- Lease pipeline (fresh-table baseline, same harness):
  [`2026-05-10-lease-pipeline.md`](2026-05-10-lease-pipeline.md).
- Source: [`src/trust-store.ts`](../../src/trust-store.ts),
  [`src/storage/seen-nonces.ts`](../../src/storage/seen-nonces.ts),
  [`src/storage/peer-lease-counters.ts`](../../src/storage/peer-lease-counters.ts).
- Bench script: [`test/perf/trust-store-contention.test.ts`](../../test/perf/trust-store-contention.test.ts).
- Bench config: [`vitest.bench.config.ts`](../../vitest.bench.config.ts).
