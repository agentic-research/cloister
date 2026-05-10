// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `tools/call` dispatch microbenchmark (cloister-e4daae, surface 1).
//
// EXCLUDED from `task lint` / `task test` — runs only via
// `task bench:dispatch` (uses `vitest.bench.config.ts`).
//
// ── What we measure ───────────────────────────────────────────────────
//
// The cost of `McpEdgeRoute.handlePost` AFTER the lease step:
//   - JSON-RPC body parse
//   - `tools/call` method match
//   - tool-name lookup via `backends.find(b => b.handles(name))`
//   - backend.invoke (stubbed — returns a fixed result; no upstream
//     HTTP, no DO RPC, no real work)
//   - response envelope (`okResponse` + `JSON.stringify`)
//
// We exercise this in TWO modes:
//   1. **DIRECT** — drive `McpEdgeRoute.handlePost` against an env with
//      `INTERLACE_ROOT_PUBKEY` UNSET so the lease step is skipped
//      entirely. The work measured is purely the dispatcher.
//   2. **NEEDLE** — construct an `McpEdgeRoute` with a stub backend
//      directly (no Worker boot) and call its private dispatcher via
//      a tiny `handle()` round-trip. Faster — no `SELF.fetch` HTTP
//      cost, no manifest setup — and isolates the dispatch cost from
//      the workerd request-routing overhead.
//
// Per-step costs here are deep sub-millisecond — we use the same
// loop-divide pattern as `lease-pipeline.test.ts`. Per-request p99 is
// reported for the full dispatch to show tail behavior under workerd's
// 1ms clock quantization.

/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { describe, it } from "vitest";

import { McpEdgeRoute } from "../../src/routes/mcp.js";
import type { Env, JsonRpcRequest, JsonRpcResponse, McpTool } from "../../src/types.js";
import type { ToolBackend } from "../../src/backends.js";
import { okResponse } from "../../src/types.js";

// ── Iteration counts ─────────────────────────────────────────────────

// PER_STEP_N is generous because each step is well under 1µs — workerd's
// 1ms clock grain means we need ≥200ms total loop time to keep mean
// precision under 5µs. JSON.parse, find, invoke, and envelope all run
// in tens-of-nanoseconds territory, so we crank N up to keep the
// signal honest.
const PER_STEP_N = 100_000;
const REQUEST_N  = 500;
const WARMUP     = 30;

// ── helpers ──────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Stub backend with N tools, each returning a fixed result. No upstream
 * I/O — just enough to exercise the dispatcher's bookkeeping.
 */
function makeStubBackend(prefix: string, names: string[]): ToolBackend {
  const tools: McpTool[] = names.map(n => ({
    name: n,
    description: `stub tool ${n}`,
    inputSchema: { type: "object", properties: {} },
  }));
  const set = new Set(names);
  let counter = 0;
  return {
    tools() { return tools; },
    handles(name) { return prefix === "" ? set.has(name) : name.startsWith(prefix); },
    async invoke(name, args) {
      // Trivial work to defeat dead-code elimination: include the arg
      // map size + a monotonic counter so the optimizer can't constant-
      // fold this away.
      counter++;
      return { name, argc: Object.keys(args).length, n: counter };
    },
  };
}

describe("tools/call dispatch bench (cloister-e4daae surface 1)", () => {
  it(`measures per-step (n=${PER_STEP_N}) + full request (n=${REQUEST_N})`, async () => {
    // ── Setup: route with realistic backend topology (3 backends, 20 tools)
    const beadNames = Array.from({ length: 8 }, (_, i) => `bead_t${i}`);
    const lspNames  = Array.from({ length: 6 }, (_, i) => `lsp_t${i}`);
    const macheNames = Array.from({ length: 6 }, (_, i) => `mache_t${i}`);
    const route = new McpEdgeRoute([
      makeStubBackend("bead_",  beadNames),
      makeStubBackend("lsp_",   lspNames),
      makeStubBackend("mache_", macheNames),
    ]);

    // Reusable env stub. `INTERLACE_ROOT_PUBKEY` UNSET → lease step is
    // skipped (deployment-binding granularity, not per-request bypass).
    const env = {} as Env;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mache_t3", arguments: { foo: "bar", baz: 42 } },
    });

    const makeReq = () => new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    // ── Per-step microbench ──────────────────────────────────────────

    // Step A: JSON.parse of the body string.
    let t0 = performance.now();
    for (let i = 0; i < PER_STEP_N; i++) {
      const r = JSON.parse(body) as JsonRpcRequest;
      if (r.method !== "tools/call") throw new Error("bad parse");
    }
    const parseElapsed = performance.now() - t0;

    // Step B: backend find (`backends.find(b => b.handles(name))`).
    // Test against the WORST-CASE name — the last backend's last tool —
    // so the search traverses the full backend list.
    const backends = [
      makeStubBackend("bead_",  beadNames),
      makeStubBackend("lsp_",   lspNames),
      makeStubBackend("mache_", macheNames),
    ];
    const worstName = macheNames[macheNames.length - 1]!;
    t0 = performance.now();
    for (let i = 0; i < PER_STEP_N; i++) {
      const b = backends.find(x => x.handles(worstName));
      if (!b) throw new Error("not found");
    }
    const findElapsed = performance.now() - t0;

    // Step C: stub backend.invoke (the work the dispatcher does on
    // every tools/call once the backend is resolved).
    const stubB = backends[2]!;
    t0 = performance.now();
    for (let i = 0; i < PER_STEP_N; i++) {
      const r = await stubB.invoke(worstName, { foo: "bar", baz: 42 }, env);
      if (!r) throw new Error("stub invoke empty");
    }
    const invokeElapsed = performance.now() - t0;

    // Step D: response envelope — okResponse + JSON.stringify of the
    // `content: [{type, text}]` shape that callTool emits.
    t0 = performance.now();
    for (let i = 0; i < PER_STEP_N; i++) {
      const r = okResponse(1, {
        content: [{ type: "text", text: JSON.stringify({ name: worstName, argc: 2, n: i }, null, 2) }],
      });
      const s = JSON.stringify(r);
      if (s.length === 0) throw new Error("empty");
    }
    const wrapElapsed = performance.now() - t0;

    // ── Full-request bench (direct McpEdgeRoute.handle) ──────────────
    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      const res = await route.handle(makeReq(), env);
      if (res.status !== 200) throw new Error(`warmup status ${res.status}`);
      await res.json();
    }

    const directSamples: number[] = [];
    for (let i = 0; i < REQUEST_N; i++) {
      const t = performance.now();
      const res = await route.handle(makeReq(), env);
      const out = await res.json<JsonRpcResponse>();
      directSamples.push(performance.now() - t);
      if (out.error) throw new Error(`dispatch error: ${out.error.message}`);
    }
    directSamples.sort((a, b) => a - b);
    const dMean = directSamples.reduce((s, v) => s + v, 0) / directSamples.length;
    const dP50  = percentile(directSamples, 50);
    const dP99  = percentile(directSamples, 99);

    // Also time the loop-over-many-direct-calls so we can recover sub-ms
    // mean even when individual samples quantize.
    t0 = performance.now();
    for (let i = 0; i < REQUEST_N; i++) {
      const res = await route.handle(makeReq(), env);
      await res.json();
    }
    const directLoopElapsed = performance.now() - t0;
    const directLoopMeanMs = directLoopElapsed / REQUEST_N;

    // ── Full-request bench (via SELF.fetch — includes worker HTTP) ──
    // Drives the same dispatcher but through the workerd HTTP stack +
    // manifest-instantiated routes. Difference vs direct gives an
    // estimate of worker-routing overhead. (Note: this path includes
    // the lease step's "binding-not-set" early return.)
    for (let i = 0; i < WARMUP; i++) {
      const res = await SELF.fetch("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      if (res.status !== 200) throw new Error(`SELF warmup status ${res.status}`);
      await res.text();
    }
    t0 = performance.now();
    for (let i = 0; i < REQUEST_N; i++) {
      const res = await SELF.fetch("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      await res.text();
    }
    const selfPingLoopMs = performance.now() - t0;
    const selfPingMeanMs = selfPingLoopMs / REQUEST_N;

    // ── Emit markdown ────────────────────────────────────────────────

    const lines: string[] = [];
    lines.push("");
    lines.push("BENCH RESULTS - tools/call dispatch (cloister-e4daae surface 1)");
    lines.push(`PER_STEP_N=${PER_STEP_N}, REQUEST_N=${REQUEST_N}, WARMUP=${WARMUP}`);
    lines.push("workerd via vitest cloudflarePool. performance.now() is 1ms-quantized;");
    lines.push("per-step mean = (elapsed_ms / N) so sub-ms steps still resolve.");
    lines.push("");
    lines.push("| Step | mean (us) | loop total (ms) | n |");
    lines.push("|---|---:|---:|---:|");
    lines.push(`| Body JSON.parse              | ${(parseElapsed/PER_STEP_N*1000).toFixed(2)} | ${parseElapsed.toFixed(0)} | ${PER_STEP_N} |`);
    lines.push(`| Backend find (worst-case)    | ${(findElapsed/PER_STEP_N*1000).toFixed(2)} | ${findElapsed.toFixed(0)} | ${PER_STEP_N} |`);
    lines.push(`| Stub backend.invoke          | ${(invokeElapsed/PER_STEP_N*1000).toFixed(2)} | ${invokeElapsed.toFixed(0)} | ${PER_STEP_N} |`);
    lines.push(`| Response envelope (okResponse + JSON.stringify) | ${(wrapElapsed/PER_STEP_N*1000).toFixed(2)} | ${wrapElapsed.toFixed(0)} | ${PER_STEP_N} |`);
    const stepSumUs = (parseElapsed + findElapsed + invokeElapsed + wrapElapsed) / PER_STEP_N * 1000;
    lines.push(`| **Sum of step means**        | **${stepSumUs.toFixed(2)}** | — | — |`);
    lines.push("");
    lines.push("Full-request timing (direct route.handle, lease-unset):");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (per-call samples)        | ${dMean.toFixed(3)} |`);
    lines.push(`| p50                            | ${dP50.toFixed(3)} |`);
    lines.push(`| p99                            | ${dP99.toFixed(3)} |`);
    lines.push(`| min                            | ${directSamples[0]!.toFixed(3)} |`);
    lines.push(`| max                            | ${directSamples[directSamples.length-1]!.toFixed(3)} |`);
    lines.push(`| **mean (loop-divide, ${REQUEST_N}× direct)** | **${directLoopMeanMs.toFixed(3)}** |`);
    lines.push("");
    lines.push("Full-request via SELF.fetch (HTTP stack + manifest routing, `ping` method):");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean (loop-divide, ${REQUEST_N}×) | ${selfPingMeanMs.toFixed(3)} |`);
    lines.push("");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, 120_000);
});
