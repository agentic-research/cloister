// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lease-pipeline microbenchmark (cloister-747d98).
//
// EXCLUDED from `task lint` / `task test` — runs only via `task bench:lease`
// (which uses `vitest.bench.config.ts`).
//
// ── Why this isn't `performance.now()` per-step ───────────────────────
//
// workerd implements `performance.now()` with **1ms quantization** as
// a Spectre defense. Per-step costs in this pipeline are sub-millisecond
// (the wasm cert verify is the slowest single step and clocks ~100µs on
// M3), so per-step `performance.now()` deltas collapse to 0 or 1 ms with
// no signal in between.
//
// Workaround: time entire LOOPS of a step, then divide. With 1ms clock
// granularity and a 200ms-ish loop, mean-per-iteration is good to ~5µs
// — fine for this pipeline. We report mean only (no p99) for the
// per-step rows because a 1ms-quantized clock can't honestly produce a
// p99 tail at this scale. The full-pipeline row is p50/p99 because
// the whole pipeline is ~1ms and the quantization grain is matched.
//
// Methodology:
//   - Each step is benched in isolation by replaying just that primitive
//     N times around a single `performance.now()` start/stop, then
//     dividing the elapsed wall time by N.
//   - DO-RPC steps (seen_nonces / lease_counter) are benched together
//     in their natural orchestrator order with a TrustStore reset per
//     iteration so the SQL tables stay at one row.
//   - Full-pipeline timing is end-to-end (`verifyAndUpsertLease`) per
//     iteration. p50/p99 reported because we run N samples through a
//     1ms-grain clock — the distribution surfaces tail behavior even
//     if individual samples are quantized.

/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import {
  canonicalRequestBytes,
  certFingerprint,
  deriveRequestScope,
  parseAuthHeaders,
  scopeAllows,
  verifyAndUpsertLease,
} from "../../src/routes/lease-middleware.js";
import {
  isCertEpochCurrent,
  type CABundle,
} from "../../src/storage/ca-bundle-cache.js";
import { verifyCertChain } from "../../src/wire/signet-verify.js";
import { signedMcpRequest } from "../helpers/signed-request.js";
import {
  CERT_FULL_B64,
  EPHEMERAL_PUBKEY_B64,
  MASTER_PUBKEY_B64_STD,
  NOT_BEFORE,
  SAMPLE_BODY_JSON,
  SAMPLE_METHOD,
  SAMPLE_NONCE_B64,
  SAMPLE_SIG_B64,
  SAMPLE_TS_MS,
  SAMPLE_URL,
} from "../wire/fixtures/cert-chain.js";

// Iteration counts. PER_STEP_N is per-step inner loop; PIPELINE_N is
// end-to-end iterations of the full orchestrator.
const PER_STEP_N = 500;
const PIPELINE_N = 200;
const WARMUP     = 20;

const HAPPY_NOW_MS = (NOT_BEFORE + 100) * 1000;
const SAMPLE_PARAMS = {
  name: "bead_create",
  arguments: { repo: "/repos/foo" },
} as const;

// ── helpers ──────────────────────────────────────────────────────────

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64StdDecode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function makeBundle(): CABundle {
  return {
    epoch:    7,
    seqno:    1,
    keys:     { active: MASTER_PUBKEY_B64_STD },
    keyId:    "active",
    issuedAt: 1_700_000_050,
    signature: "",
  };
}

function happyHeaders(): Record<string, string> {
  return {
    "authorization":  `Signet ${CERT_FULL_B64}`,
    "x-signet-sig":   SAMPLE_SIG_B64,
    "x-signet-ts":    String(SAMPLE_TS_MS),
    "x-signet-nonce": SAMPLE_NONCE_B64,
  };
}
function makeReq(): Request {
  return new Request(SAMPLE_URL, { method: SAMPLE_METHOD, headers: happyHeaders() });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

async function resetTrustStore(): Promise<void> {
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_, state) => {
    const sql = state.storage.sql;
    sql.exec("DELETE FROM seen_nonces");
    sql.exec("DELETE FROM peer_lease_counters");
  });
}

// ── bench harness ────────────────────────────────────────────────────

interface StepResult {
  label: string;
  meanUs: number;
  totalMs: number;
  n: number;
}

async function benchStep(label: string, n: number, body: (i: number) => Promise<void> | void): Promise<StepResult> {
  // Warmup — uses negative indices so steps that use `i` as a uniqueness
  // suffix (DO RPC bench) don't collide with the measurement loop's keys.
  for (let i = 0; i < WARMUP; i++) await body(-1 - i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await body(i);
  const elapsed = performance.now() - t0;
  return {
    label,
    meanUs: (elapsed / n) * 1000,
    totalMs: elapsed,
    n,
  };
}

describe("lease-pipeline bench (cloister-747d98)", () => {
  it(`measures each step in isolation (n=${PER_STEP_N}) and full pipeline (n=${PIPELINE_N})`, async () => {
    const bundle = makeBundle();
    const certDer = b64uDecode(CERT_FULL_B64);
    const masterPubkey = b64StdDecode(MASTER_PUBKEY_B64_STD);
    const ephemeralPubkey = b64uDecode(EPHEMERAL_PUBKEY_B64);
    const sig = b64uDecode(SAMPLE_SIG_B64);
    const nonce = b64uDecode(SAMPLE_NONCE_B64);

    // Pre-build a canonical-bytes buffer so step-5 measures just the
    // crypto.subtle.verify cost, not bytes assembly (which is step 6 in
    // the pipeline but accounted for separately if it ever matters).
    const canonical = canonicalRequestBytes(
      SAMPLE_METHOD, SAMPLE_URL, SAMPLE_TS_MS, nonce, SAMPLE_BODY_JSON,
    );

    // Pre-import the Ed25519 verify key once. The lease middleware does
    // this per-request because the ephemeral pubkey is per-cert; we time
    // the importKey+verify together below to mirror that cost.

    const results: StepResult[] = [];

    // Step 1: header parse.
    results.push(await benchStep("Header parse", PER_STEP_N, () => {
      const req = makeReq();
      const r = parseAuthHeaders(req);
      if ("kind" in r) throw new Error("parse failed");
    }));

    // Step 2: clock-skew bound (trivial arithmetic; included for completeness).
    results.push(await benchStep("Clock-skew bound", PER_STEP_N, () => {
      const skew = Math.abs(HAPPY_NOW_MS - SAMPLE_TS_MS);
      if (skew > 60_000) throw new Error("skew");
    }));

    // Step 3: cert chain verify (wasm32). The hot, load-bearing one.
    results.push(await benchStep("Cert chain verify (wasm32)", PER_STEP_N, () => {
      const r = verifyCertChain(certDer, masterPubkey);
      if (!r.ok) throw new Error("chain failed: " + r.reason);
    }));

    // Step 4: claims + epoch + validity (3 cheap checks).
    results.push(await benchStep("Claims + epoch + validity", PER_STEP_N, () => {
      const e = 7, nb = NOT_BEFORE, na = 2524607999;
      isCertEpochCurrent(e, bundle);
      const nowSec = Math.floor(HAPPY_NOW_MS / 1000);
      if (nowSec < nb || nowSec > na) throw new Error("window");
    }));

    // Step 5: request signature verify (Ed25519 importKey + verify).
    results.push(await benchStep("Request sig (Ed25519)", PER_STEP_N, async () => {
      const key = await crypto.subtle.importKey(
        "raw", ephemeralPubkey as BufferSource,
        { name: "Ed25519" }, false, ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "Ed25519", key, sig as BufferSource, canonical as BufferSource,
      );
      if (!ok) throw new Error("sig invalid");
    }));

    // Step 6: scope match.
    results.push(await benchStep("Scope match", PER_STEP_N, () => {
      const reqScope = deriveRequestScope("tools/call", SAMPLE_PARAMS);
      const ok = scopeAllows("bead_create:/repos/foo", reqScope);
      if (!ok) throw new Error("scope");
    }));

    // Step 7: cert fingerprint (sha256-hex of cert DER).
    results.push(await benchStep("Cert fingerprint (sha256)", PER_STEP_N, async () => {
      await certFingerprint(certDer);
    }));

    // Steps 8 + 9: TrustStore RPC pair (seen_nonces upsert + lease_counter upsert).
    // Benched together because that's how they're called in production
    // back-to-back, and bundling them avoids amortizing fixed per-call
    // overhead twice. Fresh-nonce rotation per iteration avoids replay
    // rejection without needing to wipe the table — the seen_nonces row
    // count grows monotonically across the loop, which mirrors steady-
    // state production (the cleanup sweep is amortized off the hot path).
    //
    // We also bench them individually so callers can see which of the two
    // RPCs dominates.
    const trustStore = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster")) as DurableObjectStub & {
      upsertLeaseCounter(peerFp: string, certFp: string, nonce: string, ts: number): Promise<{ seq: number; last_chain_hash: string }>;
      recordSeenNonce(certFp: string, nonce: string, tsMs: number): Promise<{ fresh: boolean }>;
    };
    const certFp = await certFingerprint(certDer);

    await resetTrustStore();
    results.push(await benchStep("seen_nonces upsert (DO RPC)", PER_STEP_N, async (i) => {
      const n = `${SAMPLE_NONCE_B64}-A-${i}`;
      const fresh = await trustStore.recordSeenNonce(certFp, n, HAPPY_NOW_MS);
      if (!fresh.fresh) throw new Error("not fresh");
    }));

    await resetTrustStore();
    results.push(await benchStep("lease_counter upsert (DO RPC)", PER_STEP_N, async (i) => {
      const n = `${SAMPLE_NONCE_B64}-B-${i}`;
      await trustStore.upsertLeaseCounter("sha256:abc123def456", certFp, n, HAPPY_NOW_MS);
    }));

    // Full pipeline — end-to-end per iteration; collect distribution.
    const pipelineSamples: number[] = [];
    for (let i = 0; i < WARMUP; i++) {
      await resetTrustStore();
      const signed = await signedMcpRequest({
        method: "tools/call", params: SAMPLE_PARAMS, tsMs: HAPPY_NOW_MS,
      });
      const r = await verifyAndUpsertLease({
        req: signed.request, body: signed.body, id: 1,
        method: "tools/call", params: SAMPLE_PARAMS,
        env, bundle, nowMs: HAPPY_NOW_MS,
      });
      if ("code" in r) throw new Error(`warmup pipeline failed: ${r.code} ${r.message}`);
    }
    for (let i = 0; i < PIPELINE_N; i++) {
      await resetTrustStore();
      const signed = await signedMcpRequest({
        method: "tools/call", params: SAMPLE_PARAMS, tsMs: HAPPY_NOW_MS,
      });
      const t0 = performance.now();
      const r = await verifyAndUpsertLease({
        req: signed.request, body: signed.body, id: 1,
        method: "tools/call", params: SAMPLE_PARAMS,
        env, bundle, nowMs: HAPPY_NOW_MS,
      });
      pipelineSamples.push(performance.now() - t0);
      if ("code" in r) throw new Error(`measure pipeline failed: ${r.code} ${r.message}`);
    }
    pipelineSamples.sort((a, b) => a - b);
    const pipP50 = percentile(pipelineSamples, 50);
    const pipP99 = percentile(pipelineSamples, 99);
    const pipMean = pipelineSamples.reduce((s, v) => s + v, 0) / pipelineSamples.length;

    // ── Emit markdown ────────────────────────────────────────────────
    const lines: string[] = [];
    lines.push("");
    lines.push("BENCH RESULTS - lease pipeline (cloister-747d98)");
    lines.push(`PER_STEP_N=${PER_STEP_N}, PIPELINE_N=${PIPELINE_N}, WARMUP=${WARMUP}`);
    lines.push("workerd via vitest cloudflarePool. performance.now() is 1ms-quantized in workerd;");
    lines.push("per-step mean computed as (elapsed_ms / N) so sub-ms steps still resolve.");
    lines.push("");
    lines.push("| Step | mean (us) | loop total (ms) | n |");
    lines.push("|---|---:|---:|---:|");
    for (const r of results) {
      lines.push(`| ${r.label} | ${r.meanUs.toFixed(1)} | ${r.totalMs.toFixed(0)} | ${r.n} |`);
    }
    const stepSum = results.reduce((s, r) => s + r.meanUs, 0);
    lines.push(`| **Sum of step means** | **${stepSum.toFixed(1)}** | — | — |`);
    lines.push("");
    lines.push("Full-pipeline timing (per-request, 1ms-quantized samples):");
    lines.push("");
    lines.push("| Metric | value (ms) |");
    lines.push("|---|---:|");
    lines.push(`| mean | ${pipMean.toFixed(3)} |`);
    lines.push(`| p50  | ${pipP50.toFixed(3)} |`);
    lines.push(`| p99  | ${pipP99.toFixed(3)} |`);
    lines.push(`| min  | ${pipelineSamples[0]!.toFixed(3)} |`);
    lines.push(`| max  | ${pipelineSamples[pipelineSamples.length - 1]!.toFixed(3)} |`);
    lines.push("");
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
  }, 120_000);
});
