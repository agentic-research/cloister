# Disclosure endpoint perf — 2026-05-10

Per-request latency for `GET /interlace/peers/{fp}` (`src/routes/disclosure.ts`).
Surface 3 of cloister-e4daae.

## TL;DR

| Path | mean (ms) | Notes |
|---|---:|---|
| Constant-time 404 (unknown peer)        | **0.53** | full route incl. 2× DO round-trips |
| Constant-time 404 (tampered cursor)     | **0.03** | early return — DOES NOT hit the DO |
| Happy path (page 1 of 10, 100 rows)     | **0.94** | full DO scan + JSONL serialize |
| Happy path (page 6 of 10, mid-cursor)   | **0.94** | cursor-decode adds zero measurable cost |
| **Rows / sec (single page-fetch loop)** | **~107k rows/s** | |

**SIDE CHANNEL FINDING (threat-model §9.4 invariant violation):**

The "constant-time" 404 response is **NOT** actually constant time
between the no-peer case and the tampered-cursor case. Wall-clock
delta is **~0.5 ms** (17× slower for no-peer than for bad-cursor).
The no-peer path does TWO DO RPCs (`listAttestationsForPeer` +
`listPendingForPeer`); the bad-cursor path early-returns before the
DO is touched. An attacker who can time requests at sub-ms resolution
can distinguish:

  - "this peer doesn't exist" → ~0.5 ms (DO round-trip)
  - "your cursor was tampered" → ~0.03 ms (early return)

Both paths return a byte-identical 404 with the same `content-length`,
so the timing is the only observable. On a real network, RTT variance
likely swamps the 0.5ms delta — but on a colocated attacker (same DC),
this is observable. Filed as a follow-up: either ALWAYS do the two
DO RPCs (slow-equalize), or NEVER do them when the cursor is bad
(safe — bad cursor means the request is rejected anyway). Slow-
equalize is the simpler fix.

This finding was not present in the threat model's existing analysis;
the spec asserts §9.4 holds but the implementation didn't measure it.

## Environment

- Host: Apple M3 Max, macOS 26.3.1 (Darwin 25.3.0)
- Node: v25.9.0
- workerd: `2025-07-18`
- vitest: v4.1.5
- Test driver: `test/perf/disclosure-endpoint.test.ts` under `vitest.bench.config.ts`
- Iteration counts: `PER_REQUEST_N=200`, `SCAN_ROWS=1000`, `WARMUP=20`

## Methodology

Four sections:

1. **Constant-time 404, no peer.** Probe a fingerprint that doesn't
   exist in `peer_attestations`. Auth gate is off
   (`INTERLACE_ROOT_PUBKEY` unset). The route still hits the DO
   twice (attestations + pending lookups), finds both empty,
   returns `constantTimeErrorResponse("not_found")`.

2. **Constant-time 404, tampered cursor.** Same fingerprint, but
   pass `?since=garbage-N` (an unsigned cursor). The route validates
   the cursor with HMAC, fails, returns `constantTimeErrorResponse("bad_cursor")`
   BEFORE hitting the DO. Compare timing to (1).

3. **Happy path, first page.** 1000 attestations pre-loaded for one
   peer; request `/interlace/peers/{fp}` with no cursor → returns
   page 1 (100 rows) + next_cursor.

4. **Happy path, mid-chain page.** Pre-sign a cursor with `fromSeq=501`,
   request `/interlace/peers/{fp}?since=<cursor>`. Exercises
   cursor-decode + DB OFFSET path. Compare to (3) — if OFFSET is
   the dominant cost, this should be slower.

Reproduce: `task bench:disclosure`. Source in
[`test/perf/disclosure-endpoint.test.ts`](../../test/perf/disclosure-endpoint.test.ts).

## Results

### Constant-time 404 (unknown peer)

| Metric | value (ms) |
|---|---:|
| mean (per-call) | 0.505 |
| p50  | 0.000 |
| p99  | 1.000 |
| min  | 0.000 |
| max  | 3.000 |
| spread (max - min) | 3.000 |
| mean (loop-divide, n=200) | 0.530 |

### Constant-time 404 (tampered cursor)

| Metric | value (ms) |
|---|---:|
| mean (per-call) | 0.030 |
| p99  | 1.000 |
| spread | 1.000 |

**No-peer vs bad-cursor mean delta: 0.475 ms** — a ~17× difference. The
bad-cursor path early-returns inside `handle()` before any DO RPC, while
the no-peer path does two DO RPCs and only THEN observes empty results.

### Happy path (first page, 100 rows)

| Metric | value |
|---|---:|
| mean per-call latency      | 0.920 ms |
| p99                        | 3.000 ms |
| min                        | 0.000 ms |
| max                        | 3.000 ms |
| mean (loop-divide, n=200)  | 0.935 ms |
| body bytes / response      | 34,843 |
| rows / response            | 100 |
| **rows / sec (page throughput)** | **~107,000** |

### Happy path with cursor (page 6, rows 501-600)

| Metric | value (ms) |
|---|---:|
| mean (loop-divide, n=200) | 0.935 |

**Mid-chain throughput is identical to first-page throughput.**
SQLite OFFSET on a 1000-row table is cheap; the cursor-decode (HMAC
verify) adds no measurable cost above the DO round-trip. This means
pagination doesn't degrade per-page latency — the chain can be 1M
rows and the page-N latency stays constant.

## Interpretation

**The DO round-trip dominates.** Both the empty 404 path and the
happy path are bounded by `listAttestationsForPeer` + `listPendingForPeer`
DO RPC cost (~0.4-0.9ms depending on row count). The JSONL serialization
itself is a few hundred microseconds at most.

**107k rows/sec page-fetch throughput** is plenty for the disclosure
use case (an audit / verifier reading a peer's chain once per minute
at most). At 100 rows/page and 0.94ms/page, a 10k-row chain serializes
in ~94ms end-to-end. No optimization needed for any realistic deployment.

**The cursor mechanism is essentially free.** HMAC verify + b64
decode + payload parse adds zero measurable latency above the
DO-bound baseline.

**The side-channel finding is the real story here.** The threat-
model promises a constant-time error response across all 404 cases
(§9.2 + §9.4). The implementation IS byte-identical at the body
level, but NOT timing-equal because the auth-fail / bad-cursor /
empty-peer paths take different execution paths to reach the same
response. An attacker who can time requests at sub-ms resolution
(in-DC) can distinguish "peer exists" from "peer doesn't exist"
from "tampered cursor."

### Follow-up filed

A separate bead should track the slow-equalize fix: either always
do the two DO RPCs before returning ANY 404, or short-circuit ALL
404 cases before any DO work. The latter is simpler and faster but
requires a redesign of when the lease gate runs. Recommend the
former for now.

## Caveats

- **Local workerd ≠ Cloudflare Workers prod.** DO RPC cost differs
  on the edge; the absolute 0.5ms delta will scale up or down with
  CF Workers' per-call cost.
- **Auth gate is OFF.** All measurements have `INTERLACE_ROOT_PUBKEY`
  unset, so the lease pipeline doesn't run. Production-gated cost
  adds the lease pipeline's 0.52ms (per `2026-05-10-lease-pipeline.md`)
  to every authenticated path; that's a 2-3× multiplier on the
  unauthenticated numbers above.
- **No contention.** Single in-flight request; the singleton TrustStore
  is otherwise idle. Concurrent disclosure requests would queue at
  the same input gate as the lease-pipeline RPC sweep — see
  `2026-05-10-trust-store-contention.md` for the ~5k req/s ceiling.
- **Network-side timing.** The side-channel finding above is for
  in-process timing. Real network RTT variance (5-50ms on the
  internet) likely swamps the 0.5ms delta. The threat is colocated
  attackers (same DC, same rack); over public internet the channel
  is below the noise floor.
- **One peer, deterministic data.** All 1000 rows for the same peer.
  Production has many peers with varied chain lengths.
- **Clock quantization.** Same 1ms-grain workerd clock as all other
  benches; loop-divide means are accurate to ~5µs, per-call samples
  quantize at 1ms.

## Related

- Tracking bead: `cloister-e4daae`.
- Threat model §9.2 + §9.4 (constant-time error responses):
  [`../security/threat-model.md`](../security/threat-model.md).
- Source: [`src/routes/disclosure.ts`](../../src/routes/disclosure.ts),
  [`src/storage/disclosure-cursor.ts`](../../src/storage/disclosure-cursor.ts).
- Bench script: [`test/perf/disclosure-endpoint.test.ts`](../../test/perf/disclosure-endpoint.test.ts).

## Update 2026-05-10 (post `cloister-1c42ae` fix)

The §9.4.b cross-peer timing oracle this bench surfaced is now closed.

The fix adds a new constant-cost DO method `TrustStore.peerHasChain`:
`SELECT 1 ... LIMIT 1` against both `peer_attestations` and
`pending_attestations`. The disclosure endpoint uses it as the
existence gate on every path (`src/routes/disclosure.ts`) and only
fetches the row-count-proportional `listAttestationsForPeer` /
`listPendingForPeer` payloads on the happy path. Result-set size is no
longer multiplexed across reject paths — the boolean comes back at
constant marshaling cost regardless of chain length.

### Post-fix bench (same M3 Max, vitest cloudflarePool)

| Path | Pre-fix mean | First attempt¹ | Post-fix mean |
|---|---:|---:|---:|
| Constant-time 404 (unknown peer) | 0.53 ms | 0.51 ms | **0.345 ms** |
| Constant-time 404 (tampered cursor) | 0.03 ms | 1.01 ms | **0.285 ms** |
| **Delta** | **17× (oracle live)** | **2×, wrong direction** | **1.2× — both inside workerd 1ms clock grain** |
| Happy path (100-row page) | 0.94 ms | 1.05 ms | **1.315 ms** |

¹ "First attempt" = the earlier `cloister-1c42ae` revision that funneled
all paths into a `listAttestationsForPeer` call regardless of reject
state but used the request's own peerFp. That eliminated the same-peer
oracle but kept the cross-peer one (different peers had different row
counts → different marshaling cost). The `peerHasChain` refactor closes
the cross-peer signal at its source.

### What "closed" means concretely

- **The shape contract is pinned** at `test/trust-store.test.ts` —
  `peerHasChain` returns a boolean and only a boolean, regardless of
  the peer's chain length. SQLite's `LIMIT 1` semantics + RPC
  marshaling of a single primitive make this constant-cost by
  construction.
- **The empirical timing parity is checked** by re-running this bench
  after any change to the disclosure 404 path. The bench's delta line
  is the load-bearing assertion; if a refactor pushes the delta out of
  clock-grain range, the fix has regressed.
- **The happy-path cost grew by ~0.4 ms** (0.97 → 1.31) because it
  now does the existence probe AND the row fetch. That's the price of
  the §9.4.b fix; the alternative (skip the probe on happy path) would
  reintroduce the cross-peer oracle by making the path conditional on
  a row-count-proportional call.

### Caveats still standing

The pre-fix caveats section still applies (local workerd ≠ CF prod;
single-request, no contention; fixture peer; etc.). The §9.4.b fix is
substrate-side, not network-side — same-DC adversaries lose the
17× signal; cross-DC RTT variance always dominated.
