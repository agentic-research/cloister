# Lease-pipeline perf — 2026-05-10

Per-step latency for `verifyAndUpsertLease` (`src/routes/lease-middleware.ts`),
the always-on auth gate that wraps `POST /mcp`. First page of the
broader perf write-up promised in `cloister-747d98`; the remaining
surfaces (`tools/call` dispatch, isolated `TrustStore` RPC, disclosure
endpoint, cold-start cluster boot) are tracked in a follow-up sub-bead.

## TL;DR

| | Before (µs) | After (µs) | Δ |
|---|---:|---:|---:|
| Sum of step means     | 900  | 1026 (legacy steps still benched) | n/a |
| Full pipeline mean    | **925** | **520** | **−405µs / −44%** |
| Full pipeline p99     | **3000** | **1000** | **−2000µs / −67%** |

The two TrustStore DO RPCs together accounted for ~85% of pipeline time
(~760µs of 900µs) before batching. The wasm32 cert-chain verify (90µs)
and the Web-Crypto Ed25519 request-sig verify (32µs) are the next biggest
contributors. Pure-JS steps (header parse, scope match, epoch +
validity, sha256 fingerprint) are sub-10µs each.

**Update 2026-05-10 (cloister-ee51b8): the two DO RPCs were coalesced
into one (`TrustStore.verifyLeaseAndAdvanceChain`). The legacy methods
are still benched in isolation (per-step rows below) and still exist on
the DO, but the live `verifyAndUpsertLease` pipeline now does ONE cross-
DO call instead of two.** The per-step `seen_nonces` + `lease_counter`
rows below describe the legacy RPCs (preserved for non-batched callers
and benchmark continuity); the [After-batching](#after-batching-cloister-ee51b8)
section captures the new measurement.

**These numbers are local workerd, not Cloudflare Workers edge**; see
[Caveats](#caveats).

## Environment

- Host: Apple M3 Max, macOS 26.3.1 (Darwin 25.3.0)
- Node: v25.9.0
- workerd: `2025-07-18` (the version `wrangler` / `@cloudflare/vitest-pool-workers`
  resolves to in this tree)
- vitest: v4.1.5 with `@cloudflare/vitest-pool-workers`
- Test driver: `test/perf/lease-pipeline.test.ts` under `vitest.bench.config.ts`
- Iteration counts: `PER_STEP_N=500`, `PIPELINE_N=200`, `WARMUP=20`
- Bench config: `vitest.bench.config.ts` — same workerd pool + wrangler.toml
  as production; isolated from the lint gate.

## Methodology

`performance.now()` inside workerd is **1ms-quantized** as a Spectre
defense. Per-step latencies in this pipeline are sub-millisecond, so
naïve `t = now(); step(); elapsed = now() - t;` collapses to 0ms or 1ms
with no signal between. To recover sub-ms resolution:

1. **Per-step rows** time entire loops of a step. Each step's primitive
   is invoked N=500 times around a single start/stop timer, then
   divided by N to recover mean per-iteration. At ~1ms clock grain and
   a ~200ms loop, that's ~5µs precision — fine for the steps we care
   about. **No p99 per step** because the quantized clock can't honestly
   produce a tail at this scale.
2. **Full pipeline** rows time individual `verifyAndUpsertLease` calls
   end-to-end and report p50/p99 over PIPELINE_N=200 samples. p99 lives
   at the 3ms grain so it surfaces tail behavior even though each sample
   is 1ms-quantized.
3. **Warmup** of 20 iterations is discarded before measurement (gives
   V8 a chance to JIT the hot path and the wasm module to settle).
4. The DO-RPC steps rotate the nonce per iteration to avoid replay
   rejection without wiping the table — the `seen_nonces` row count
   grows monotonically, which mirrors steady-state production.

Reproduce: `task bench:lease`. Source in
[`test/perf/lease-pipeline.test.ts`](../../test/perf/lease-pipeline.test.ts).

## Results

Numbers below are from a single representative run; ±10-15% drift run-
to-run on the DO RPCs is normal (the SQLite write amortization is the
dominant variance source).

### Per-step (mean, µs)

| Step | mean (µs) | Notes |
|---|---:|---|
| Header parse                       |   6  | 4 base64url decodes + a `Number.parseInt`. JS-only. |
| Clock-skew bound                   |   0  | One `Math.abs` + compare. Below clock grain. |
| Cert chain verify (wasm32)         |  90  | DER parse + Ed25519 signature verify inside `leyline_sign.wasm`. |
| Claims + epoch + validity          |   0  | Three branch checks; below clock grain. |
| Request sig (Ed25519)              |  32  | `crypto.subtle.importKey` (raw, 32-byte SPKI) + `crypto.subtle.verify`. |
| Scope match                        |   0  | Glob check with a single `endsWith`/`startsWith`. Below clock grain. |
| Cert fingerprint (sha256)          |   4  | `crypto.subtle.digest("SHA-256", certDer)` + hex stringify. |
| seen_nonces upsert (DO RPC)        | 374  | Cross-DO call into singleton `TrustStore`; `INSERT OR FAIL` into `seen_nonces`. |
| lease_counter upsert (DO RPC)      | 386  | Cross-DO call; chain-hash update + upsert into `peer_lease_counters`. |
| **Sum of step means**              | **898** | |

### Full pipeline (`verifyAndUpsertLease`, end-to-end)

#### Before batching (original 2026-05-10 measurement; audit trail)

| Metric | value (ms) |
|---|---:|
| mean | 0.925 |
| p50  | 1.000 |
| p99  | 3.000 |
| min  | 0.000 |
| max  | 7.000 |

Min=0 is the clock-grain artifact: a "real" sample of 0.5ms reads as
either 0 or 1ms depending on which side of the boundary it lands.

#### After batching (cloister-ee51b8)

Same harness, same machine, same PER_STEP_N/PIPELINE_N/WARMUP, but the
pipeline now does ONE `TrustStore.verifyLeaseAndAdvanceChain` RPC
instead of `recordSeenNonce` + `upsertLeaseCounter` back-to-back.

| Metric | value (ms) |
|---|---:|
| mean | 0.520 |
| p50  | 1.000 |
| p99  | 1.000 |
| min  | 0.000 |
| max  | 3.000 |

**Delta: mean −405µs (−44%), p99 −2000µs (−67%), max −4000µs (−57%).**

The p99 collapse is the bigger story. Before batching, p99 sat at 3ms
because the two RPCs each had an independent chance of landing on a
slow tick. After batching, p99 drops to 1ms (the clock grain itself) —
the second RPC's tail variance no longer compounds with the first's.

The 405µs mean improvement is close to one full DO RPC roundtrip
(legacy `seen_nonces upsert` benchmarked at 374–514µs), which is what
the bead predicted (~380µs).

The "Sum of step means" row above (1026µs) is artificially inflated
because the per-step bench still drives the LEGACY methods in
isolation for benchmark continuity — they remain on the DO for non-
batched callers. The live pipeline does not use them.

## Interpretation

**The hot path is the TrustStore RPC pair, not crypto.** Together,
`recordSeenNonce` + `upsertLeaseCounter` cost ~760µs — about 85% of the
pipeline. This is the expected shape: workerd's cross-DO IPC carries
roundtrip + SQL-write overhead that no in-process verification step
can match. Two RPCs back-to-back per request is the dominant constant.

**Wasm cert verify is the slow crypto step, as expected (90µs).** This
is one cert (the leaf) verified against the cluster master pubkey;
includes DER decode + Ed25519 verify + Interlace claims extraction.
On the same machine, the Web Crypto Ed25519 request-sig verify (32µs)
is ~3× faster because it skips DER and works on a raw 32-byte key. No
surprise.

**Pure-JS steps are noise.** Header parse, scope match, claims+epoch+
validity, and sha256 fingerprint together cost ~10µs. Optimizing any
of them is wasted effort until the DO RPCs come down.

### Possible follow-ups (not implemented this session)

- ~~**Coalesce the two RPCs into one.**~~ **DONE — cloister-ee51b8**
  (2026-05-10). The new `TrustStore.verifyLeaseAndAdvanceChain` method
  composes the seen_nonces INSERT + lease_counter UPSERT inside one
  `transactionSync` on the DO; the lease middleware now calls it instead
  of the back-to-back pair. Also closes the cross-table atomicity gap
  (a crash between the two writes would have left the nonce consumed
  but the chain un-advanced — a §13.2 off-by-one).
- **CA bundle fetch.** This bench feeds a pre-built bundle directly to
  `verifyAndUpsertLease`, mirroring the cached path in `getCABundle`
  (TTL = 4min, in-process). The uncached path adds one service-binding
  hop to notme; should be benched in the follow-up surfaces.

## Caveats

- **Local workerd ≠ Cloudflare Workers prod.** The cross-DO RPC numbers
  in particular will differ on the edge — CF Workers runs DOs in a
  different process model and the SQL backend is different from local
  miniflare's. Re-running these against `wrangler dev --remote` or a
  staging deployment is the next step.
- **One cert reused.** All iterations use the same fixture cert
  (`CERT_FULL_B64`, valid through 2049). A real workload would mint a
  fresh cert every ~5min; the wasm verify cost would dominate during
  rotation but be amortized otherwise.
- **No contention.** Single in-flight request; no concurrent writers
  hitting the `TrustStore` singleton. Production contention could shift
  the RPC numbers up.
- **No DO-storage growth modeled.** The `seen_nonces` table grows
  monotonically across the bench (500 rows by the end), which roughly
  matches steady-state but doesn't model the periodic cleanup sweep.
- **Clock quantization.** Per-step `mean` is `total_loop_ms / N`; if
  the loop happens to straddle a clock tick boundary, ±2ms (~4µs at
  N=500) of error per measurement. Doesn't change the ordering.

## Related

- Tracking bead: `cloister-747d98`.
- Sub-bead for remaining four surfaces: `cloister-747d98b` (filed
  separately; see `rsry_bead_search`).
- **Batched-RPC bead: `cloister-ee51b8`** — closed the two-RPC fan-out
  + atomicity gap; produced the After numbers above.
- Source: [`src/routes/lease-middleware.ts`](../../src/routes/lease-middleware.ts),
  [`src/trust-store.ts`](../../src/trust-store.ts) (`verifyLeaseAndAdvanceChain`).
- Parity test: [`test/trust-store.test.ts`](../../test/trust-store.test.ts)
  (`PARITY: spec vector chain hashes`).
- Bench script: [`test/perf/lease-pipeline.test.ts`](../../test/perf/lease-pipeline.test.ts).
- Bench config: [`vitest.bench.config.ts`](../../vitest.bench.config.ts).
- Threat model context for each step: [`docs/security/threat-model.md`](../security/threat-model.md).
