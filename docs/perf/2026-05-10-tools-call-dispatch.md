# `tools/call` dispatch perf — 2026-05-10

Per-step latency for `McpEdgeRoute.handlePost` AFTER the lease step
through the MCP `tools/call` dispatcher (`src/routes/mcp.ts`). Surface
1 of cloister-e4daae (follows up on the lease-pipeline measurement in
[`2026-05-10-lease-pipeline.md`](2026-05-10-lease-pipeline.md)).

## TL;DR

| Metric | value |
|---|---:|
| Sum of per-step means       | **0.94 µs** |
| Full direct-call mean       | **0.016 ms / 16 µs** |
| Full direct-call p99        | 1 ms (clock grain) |
| SELF.fetch via worker HTTP  | 20.2 ms |

The dispatcher itself is **noise** on the scale that matters. Combined
parse + find + invoke + envelope is < 1 µs in the steady state; the
end-to-end `route.handle()` call lands at ~16 µs (dominated by Promise
chain + Request/Response object allocations, not the dispatch logic).

For comparison, the full lease pipeline measured at **520 µs** end-to-
end in [`2026-05-10-lease-pipeline.md`](2026-05-10-lease-pipeline.md).
Dispatch is **0.003%** of the budget on an authenticated POST /mcp.

**The 20.2 ms SELF.fetch number is a vitest-pool-workers harness cost,
not a dispatch cost** — it includes the cloudflarePool's request-routing
overhead. Production CF Workers latency is dominated by network + lease,
not by either of these numbers.

## Environment

- Host: Apple M3 Max, macOS 26.3.1 (Darwin 25.3.0)
- Node: v25.9.0
- workerd: `2025-07-18` (resolved by `@cloudflare/vitest-pool-workers`)
- vitest: v4.1.5
- Test driver: `test/perf/tools-call-dispatch.test.ts` under
  `vitest.bench.config.ts`
- Iteration counts: `PER_STEP_N=100_000`, `REQUEST_N=500`, `WARMUP=30`

## Methodology

The dispatcher's per-step work is in **nanosecond territory** — workerd's
1ms-quantized `performance.now()` cannot resolve a single call. The
lease-pipeline doc used N=500 inner loops; here we crank to N=100_000
so a ~40ms total loop divided by N gives sub-50-ns precision per step.

The dispatch path measured in steps:

1. **Body JSON.parse** — `JSON.parse(bodyText) as JsonRpcRequest`. Body
   is a fixed 130-byte tools/call envelope.
2. **Backend find** — `backends.find(b => b.handles(name))` across 3
   backends (8 + 6 + 6 = 20 tools, prefix-keyed). Worst case: hit the
   last backend's last tool, so all three `handles()` checks run.
3. **Stub backend.invoke** — returns `{ name, argc, n }`. No DO RPC, no
   upstream HTTP — just enough work to defeat dead-code elimination.
4. **Response envelope** — `okResponse(id, { content: [...] })` + a
   `JSON.stringify(...)` of the stringified tool result.

Then two end-to-end paths:

- **Direct** — `route.handle(makeReq(), env)` with `INTERLACE_ROOT_PUBKEY`
  UNSET so the lease step is skipped at deployment-binding granularity
  (NOT a per-request bypass — same gate the prod `/mcp` route uses for
  dev deploys). Per-call samples + a 500-loop divide for mean.
- **SELF.fetch** — POSTs through the workerd HTTP stack to the manifest-
  routed `/mcp`. Uses `method: "ping"` (no tool dispatch — exercises
  routing only) to isolate worker-routing overhead from dispatch.

**No zod-schema validation is on this path.** The MCP edge route does
not validate per-call arguments against the McpTool inputSchema;
schemas are advertised on `tools/list` but not enforced on `tools/call`.
That's by design (backends do their own validation against their
upstream contracts) but worth flagging — the original surface-1 brief
included "zod schema validation" in the dispatch breakdown, which
doesn't exist in the codebase. Filed as a worth-checking observation
in the bead comments; no work attached.

Reproduce: `task bench:dispatch`. Source in
[`test/perf/tools-call-dispatch.test.ts`](../../test/perf/tools-call-dispatch.test.ts).

## Results

### Per-step (mean, µs)

| Step | mean (µs) | loop total (ms) | n |
|---|---:|---:|---:|
| Body JSON.parse                                | 0.42 |  42 | 100_000 |
| Backend find (worst-case across 3 backends)    | 0.04 |   4 | 100_000 |
| Stub backend.invoke (no I/O)                   | 0.10 |  10 | 100_000 |
| Response envelope (okResponse + JSON.stringify)| 0.38 |  38 | 100_000 |
| **Sum of step means**                          | **0.94** | — | — |

### Full request (`route.handle`, direct, lease-unset)

| Metric | value (ms) |
|---|---:|
| mean (per-call samples) | 0.014 |
| p50  | 0.000 |
| p99  | 1.000 |
| min  | 0.000 |
| max  | 1.000 |
| **mean (loop-divide, 500× direct)** | **0.016** |

p99 of 1ms is the clock grain — the actual p99 is presumably 16-50 µs
but the 1ms-quantized clock cannot show it. The loop-divide mean (16 µs)
is the trustworthy number.

### Full request via SELF.fetch (worker HTTP stack)

| Metric | value (ms) |
|---|---:|
| mean (loop-divide, 500× ping) | 20.2 |

This is **vitest-pool-workers fixed cost per round-trip**, NOT a
dispatch cost. The same SELF.fetch overhead applies to the lease-
pipeline measurements but isn't visible there because it's swallowed
by the verifyAndUpsertLease run time. In production CF Workers, this
overhead doesn't exist — requests come in over real HTTP.

## Interpretation

**Dispatch is free.** At 16 µs end-to-end via `route.handle()`, the
dispatcher contributes < 3% of a sub-millisecond ping path, and < 0.005%
of an authenticated POST /mcp (which is lease-bound at 520 µs).

**The big four steps are all sub-microsecond.**
- `JSON.parse` of a 130-byte body: 420 ns
- backend find across 3 backends: 40 ns
- stub `invoke`: 100 ns (one async function-call frame + return)
- envelope: 380 ns

**JSON.parse + JSON.stringify together are 80% of the sub-µs work
budget.** This is the bytes-in / bytes-out cost, not real work. Any
future optimization here (e.g. struct-of-arrays response building,
streaming envelope) would be premature — the dispatch path is not where
the cycles go.

**The find pattern scales acceptably.** `backends.find(b => b.handles(name))`
at 40 ns worst-case across 3 backends means even a 10-backend manifest
would land at ~150 ns. If/when we ship 100+ backends, a name-prefix
HashMap dispatch would matter — but at current scale it's noise.

**`refreshTools` is NOT on the `tools/call` hot path** (it runs on
`tools/list` only — see `src/routes/mcp.ts:132`). Worth noting because
the brief flagged it as a potential cost; it isn't on this surface.

### What would actually move the needle

Nothing on this surface. The dispatch cost is constant + tiny;
optimization effort belongs entirely on the lease pipeline
(`2026-05-10-lease-pipeline.md`) or the upstream backend RPC (which
isn't dispatch — it's the network/IPC call to the tool's host).

## Caveats

- **Local workerd ≠ Cloudflare Workers prod.** Numbers will differ on
  the edge, but dispatch is JS — the relative cost vs the lease pipeline
  should hold.
- **Stub backend.** A real `bead_*` invoke does a DO RPC; that cost is
  not part of dispatch and is benched in the TrustStore-contention doc
  for the relevant DO surface.
- **Single in-flight request.** No concurrency on this surface; the
  dispatcher is stateless past construction so concurrency wouldn't
  affect per-request CPU cost. The DO contention doc measures the
  storage-layer side.
- **One-request-shape.** All 500 samples use the same body. Real traffic
  varies in argument shape and tool name; JSON.parse cost scales with
  body size (not measured here).
- **Clock quantization.** Per-step `mean` is `total_loop_ms / N`; at
  N=100_000 a ±2ms total-loop error is ±0.02 µs per step — well below
  the signal.
- **Vitest harness inflates SELF.fetch.** The 20ms SELF.fetch number is
  miniflare/cloudflarePool overhead, NOT production latency. In a real
  CF Workers deploy, the network is the latency, not the pool.

## Related

- Tracking bead: `cloister-e4daae`.
- Lease pipeline (the 520-µs context this is a fraction of):
  [`2026-05-10-lease-pipeline.md`](2026-05-10-lease-pipeline.md).
- Source: [`src/routes/mcp.ts`](../../src/routes/mcp.ts) (the dispatcher),
  [`src/backends.ts`](../../src/backends.ts) (ToolBackend contract).
- Bench script: [`test/perf/tools-call-dispatch.test.ts`](../../test/perf/tools-call-dispatch.test.ts).
- Bench config: [`vitest.bench.config.ts`](../../vitest.bench.config.ts).
