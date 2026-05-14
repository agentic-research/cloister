# `docs/perf/` — performance writeups

Per-surface latency + throughput measurements for cloister. Each
file is a self-contained writeup with TL;DR, methodology, raw
results, interpretation, and caveats.

| Surface | Doc | Headline |
|---|---|---|
| Lease pipeline (verifyAndUpsertLease) | [`2026-05-10-lease-pipeline.md`](2026-05-10-lease-pipeline.md) | 520 µs mean end-to-end (post-batching) |
| `tools/call` dispatch                 | [`2026-05-10-tools-call-dispatch.md`](2026-05-10-tools-call-dispatch.md) | 16 µs direct, < 1 µs of CPU work |
| TrustStore RPC under contention       | [`2026-05-10-trust-store-contention.md`](2026-05-10-trust-store-contention.md) | ~5,000 req/s ceiling on local workerd |
| Disclosure endpoint                   | [`2026-05-10-disclosure-endpoint.md`](2026-05-10-disclosure-endpoint.md) | ~107k rows/s page throughput; **§9.4 timing-channel finding** |
| Cold-start cluster boot               | [`2026-05-10-cold-start.md`](2026-05-10-cold-start.md) | 610 ms warm boot; 1.9 s cold |

## Reproducing

All bench tasks are opt-in (NOT part of `task lint` / `task test`).
Iteration counts are tuned for ~10s wall time per task.

```sh
task bench:lease         # surface: lease pipeline
task bench:dispatch      # surface: tools/call dispatch
task bench:trust-store   # surface: TrustStore contention
task bench:disclosure    # surface: disclosure endpoint
task bench:cold-start    # surface: cold-start cluster boot (external probe)
task bench:all           # all of the above sequentially
```

Inner-loop benches use `vitest.bench.config.ts`, which mirrors
`vitest.config.ts` (same workerd pool, same wrangler.toml) but scopes
to `test/perf/**`. The cold-start bench lives outside vitest because
it spawns wrangler as a child process.

## Methodology gotchas

**workerd's `performance.now()` is 1ms-quantized** as a Spectre
defense. Per-step sub-millisecond costs CANNOT be measured by naive
`t = now(); step(); elapsed = now() - t;` — both reads quantize to
the same tick. Two workarounds across these docs:

- **Loop-divide**: time a loop of N=500-100,000 iterations around a
  single start/stop pair, then divide. Gives ~5µs precision per step.
  Used for every per-step measurement.
- **Full-pipeline distribution**: collect N=200+ per-call samples,
  sort, report p50/p99. The distribution surfaces tail behavior
  even though individual samples are 1ms-quantized.

**Local workerd ≠ CF Workers prod.** Every doc carries this caveat —
miniflare's DO IPC, SQLite backend, and input-gate implementation
differ from production. Absolute numbers will differ; relative shapes
(e.g. "two RPCs cost twice one RPC") generalize. CF prod measurements
are a separate workstream — flagged as out-of-scope for these docs.

## Key findings (cross-doc summary)

1. **Lease pipeline is DO-RPC-bound, not crypto-bound.** Two cross-DO
   RPCs cost ~85% of the pipeline; batching them halved the cost
   (cloister-ee51b8). Wasm cert verify (90 µs) and Ed25519 request
   sig (32 µs) are minor.
2. **Dispatch is free.** `tools/call` dispatch is < 1 µs of CPU work;
   not worth optimizing.
3. **TrustStore scales fine.** 10k rows in `seen_nonces` has no
   measurable impact on RPC latency. The throughput ceiling is the
   input gate (~5k req/s local), not the SQL.
4. **Disclosure endpoint constant-time §9.4.b — CLOSED 2026-05-10
   (`cloister-1c42ae`).** The pre-fix 17× delta between no-peer 404
   and tampered-cursor 404 was driven by a double DO hit; the
   `peerHasChain` constant-cost probe collapses both paths to a
   single 60µs response inside workerd's quantization floor.
   Re-verified 2026-05-12 by oracle-friend. See
   [`docs/perf/2026-05-10-disclosure-endpoint.md`](2026-05-10-disclosure-endpoint.md)
   for the before/after numbers.
5. **Cold-start is fine.** 610ms warm, 1.9s cold-cache. No
   optimization needed at current scale.
