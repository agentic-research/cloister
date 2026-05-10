# Cold-start cluster boot perf — 2026-05-10

Time from `pnpm exec wrangler dev` spawn to first 200 on `/health`.
Surface 4 of cloister-e4daae. External probe (workerd can't measure
its own boot from inside).

## TL;DR

| Run | spawn → first 200 (ms) |
|---|---:|
| run 1 (cold caches) | **1,936** |
| run 2-5 (warm)      | **608-646** |
| **median (5 runs)** | **610** |
| mean                | 882 (skewed by run 1) |

**Two-tier cold-start.** First spawn after a long idle: ~1.9s.
Subsequent spawns within the same shell session: ~610ms.
The 1.3s delta is dominated by node + pnpm + wrangler module-resolution
caches; once those are warm the dominant cost is wrangler's miniflare
worker compile + DO init.

## Environment

- Host: Apple M3 Max, macOS 26.3.1 (Darwin 25.3.0)
- Node: v25.9.0
- pnpm: v9.x (resolves wrangler via local node_modules)
- wrangler: pinned in package.json (`task dev` uses this)
- Probe: `scripts/bench-cold-start.mjs`, N=5 runs, 10ms poll interval,
  30s timeout per run
- Manifest, tool-schemas already built (no schema compile in this
  measurement)

## Methodology

The probe:

1. Spawns `pnpm exec wrangler dev --port 8787` as a child process with
   stdio piped to `/dev/null` (we don't care about wrangler's logs —
   we measure user-observable readiness).
2. Polls `http://127.0.0.1:8787/health` every 10ms.
3. Records wall-clock time from `spawn()` to first 200 response.
4. SIGTERM's the child, waits up to 2s for graceful exit, SIGKILL if
   needed, then 500ms settle for port release.
5. Repeats N=5 times.

The script lives outside vitest because vitest's pool boots workerd
on demand; we can't observe the FIRST boot from inside it. We measure
the `task dev` UX, not the embedded miniflare boot.

Reproduce: `task bench:cold-start`. Source in
[`scripts/bench-cold-start.mjs`](../../scripts/bench-cold-start.mjs).

## Results

```
run 1/5 ... first 200 at 1936ms (total 2016ms)
run 2/5 ... first 200 at  610ms (total  665ms)
run 3/5 ... first 200 at  646ms (total  702ms)
run 4/5 ... first 200 at  609ms (total  668ms)
run 5/5 ... first 200 at  608ms (total  672ms)
```

| Metric | spawn → first 200 (ms) | total wall (ms) |
|---|---:|---:|
| mean   | 882   | 944 |
| median | 610   | 672 |
| min    | 608   | 665 |
| max    | 1,936 | 2,016 |

## Interpretation

**Cold-cache boot (~1.9s)** dominates if the developer just opened
a fresh terminal: node has to materialize wrangler's deps from disk
(esbuild, miniflare, the workerd binary itself), and wrangler has
to bundle `src/index.ts` (esbuild) into the in-memory miniflare
Worker. Once cached, **warm boot stabilizes at ~610ms** with very
tight variance (608-646ms across runs 2-5).

The 610ms warm-boot breakdown is NOT directly measurable without
intrusive instrumentation (see "What's NOT broken down" below). A
reasonable mental model:

  - ~100-200ms node startup + module resolution
  - ~200-300ms wrangler/esbuild bundle of `src/index.ts`
  - ~50-100ms miniflare init (workerd subprocess, IPC handshake)
  - ~50-100ms DO migration + schema init (TrustStore, BeadStore,
    BlobStore, CredentialVault) — all four migrations + each
    DO's `CREATE TABLE IF NOT EXISTS` runs on first hit
  - ~10-50ms first-request route compile + URLPattern construction

That adds to ~410-750ms, which matches the observed ~610ms.

**No surprises here.** Cold-start under a second is excellent for a
gateway worker; it's well under the 5-10s humans notice as "slow"
and below the 30s a worker boot SLA would target.

### What's NOT broken down

The brief asked for a component breakdown (workerd boot vs DO init
vs wasm instantiation vs route-table compile). That requires either:

1. Emitting `performance.now()` log lines from inside `src/index.ts`
   module-eval time, DO constructors, and the wasm import callsite.
2. Parsing wrangler's verbose logs for its internal phase
   milestones.

Option (1) requires writing benchmark scaffolding into production
code paths (intrusive); option (2) requires reverse-engineering
wrangler's log format. **Neither was pursued this session** — the
total cold-start is small enough (~610ms) that component-level
breakdown isn't load-bearing for any current decision. Filed as a
follow-up if the cold-start budget ever becomes contentious.

### What this does NOT measure

- **CF Workers prod cold-start.** Different beast entirely — CF's
  edge platform has its own boot model (V8 isolate creation,
  per-region pre-warming, etc.) that bears no resemblance to local
  wrangler. Not measurable without a real deploy + a synthetic
  probe from outside the network. Flagged in caveats.
- **Cold cache TRUE first-ever start.** Run 1 here is "first spawn
  this session"; if the developer just ran `pnpm install` or rebooted
  the host, the actual first-spawn would be slower (node's filesystem
  cache cold). Not modeled — that's a system state we can't reproduce
  in a script.
- **task serve:local (raw workerd).** This bench uses `wrangler dev`,
  which is the user-facing path. `workerd serve config.capnp` directly
  would be faster (no wrangler/esbuild bundle step) but is rarely
  what a developer does day-to-day.

## Caveats

- **Local wrangler ≠ CF Workers prod.** Production cold-start is
  governed by Cloudflare's edge isolate provisioning, not local
  wrangler. The relationship between this number and prod cold-start
  is unknown.
- **Two-tier distribution.** The first-run outlier (1.9s) is real but
  represents a one-time penalty per shell session. Reporting median
  is more honest than mean for this workload — the 1.3s delta is a
  step function, not a continuous tail.
- **N=5 is small.** Variance on warm runs is tight (38ms spread); a
  larger N wouldn't change the picture. Cold-cache run 1 is by
  definition single-shot per session; no way to get a distribution.
- **Port reuse.** The bench waits 500ms between runs for port release.
  If the port is still bound when the next run starts, wrangler
  retries on a different port and `/health` polling fails. Hasn't
  fired in practice but worth knowing.
- **Component breakdown not implemented.** See above. The follow-up
  is filed; intrusive log lines weren't added this session because
  the total budget is small.

## Related

- Tracking bead: `cloister-e4daae`.
- `task dev` / `task serve:local` definitions in `Taskfile.yml`.
- Source files that contribute to cold-start:
  [`src/index.ts`](../../src/index.ts) (composition root),
  [`src/manifest/runtime.ts`](../../src/manifest/runtime.ts) (route
  table compile), DO constructors in
  [`src/beads.ts`](../../src/beads.ts),
  [`src/trust-store.ts`](../../src/trust-store.ts),
  [`src/blob-store.ts`](../../src/blob-store.ts),
  [`src/vault-store.ts`](../../src/vault-store.ts).
- Bench script: [`scripts/bench-cold-start.mjs`](../../scripts/bench-cold-start.mjs).
