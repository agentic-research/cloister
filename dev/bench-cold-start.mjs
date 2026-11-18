#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cold-start cluster boot bench (cloister-e4daae surface 4).
//
// Spawns `pnpm exec wrangler dev` as a child process and polls
// http://localhost:8787/health every 10ms until the first 200. Records
// wall-clock time from spawn to first 200. Repeats N=5+ times for a
// distribution.
//
// External probe — workerd cannot measure its own boot from inside.
// This script lives outside vitest because:
//   - vitest pool starts a worker on demand; we can't observe the FIRST
//     boot from inside it
//   - we want to time the user-facing thing (the `task dev` UX), not
//     the embedded miniflare boot
//
// Caveats reported in docs/perf/2026-05-10-cold-start.md.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { performance } from "node:perf_hooks";

const N_RUNS         = 5;
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS  = 30_000;
const PORT             = 8787;

function poll() {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = () => {
      const elapsed = performance.now() - start;
      if (elapsed > POLL_TIMEOUT_MS) {
        return reject(new Error(`/health never returned 200 within ${POLL_TIMEOUT_MS}ms`));
      }
      const req = request({
        host: "127.0.0.1", port: PORT, path: "/health",
        method: "GET", timeout: 200,
      }, (res) => {
        if (res.statusCode === 200) {
          // Drain body so server can finalize
          res.on("data", () => {});
          res.on("end", () => resolve(elapsed));
        } else {
          res.resume();
          setTimeout(tick, POLL_INTERVAL_MS);
        }
      });
      req.on("error", () => setTimeout(tick, POLL_INTERVAL_MS));
      req.on("timeout", () => { req.destroy(); setTimeout(tick, POLL_INTERVAL_MS); });
      req.end();
    };
    // Small initial delay; wrangler usually takes a few hundred ms before listening
    setTimeout(tick, 50);
  });
}

async function killChild(child) {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) return resolve(undefined);
    const onExit = () => resolve(undefined);
    child.once("exit", onExit);
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve(undefined);
    }, 2000);
  });
}

async function oneRun() {
  // pnpm exec wrangler dev — same path `task dev` uses. Suppress its
  // stdout/stderr so the bench output is clean.
  const start = performance.now();
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(PORT)], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
    env: { ...process.env, NO_COLOR: "1" },
  });
  try {
    const firstHealthyMs = await poll();
    const totalMs = performance.now() - start;
    return { totalMs, firstHealthyMs };
  } finally {
    await killChild(child);
    // brief settle so the port is freed before the next run
    await new Promise(r => setTimeout(r, 500));
  }
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const sum = samples.reduce((s, v) => s + v, 0);
  return {
    mean: sum / samples.length,
    min:  sorted[0],
    max:  sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

async function main() {
  console.log("");
  console.log("BENCH RESULTS - cold-start cluster boot (cloister-e4daae surface 4)");
  console.log(`N_RUNS=${N_RUNS}, POLL_INTERVAL_MS=${POLL_INTERVAL_MS}, PORT=${PORT}`);
  console.log("External probe — `pnpm exec wrangler dev`, poll http://localhost:8787/health");
  console.log("");

  const results = [];
  for (let i = 0; i < N_RUNS; i++) {
    process.stdout.write(`run ${i + 1}/${N_RUNS} ... `);
    try {
      const r = await oneRun();
      results.push(r);
      process.stdout.write(`first 200 at ${r.firstHealthyMs.toFixed(0)}ms (total ${r.totalMs.toFixed(0)}ms)\n`);
    } catch (e) {
      process.stdout.write(`FAILED: ${e.message}\n`);
    }
  }

  if (results.length === 0) {
    console.error("\nno successful runs — bench failed");
    process.exit(1);
  }

  const firstHealthy = summarize(results.map(r => r.firstHealthyMs));
  const totals       = summarize(results.map(r => r.totalMs));

  console.log("");
  console.log("| Metric | spawn → first 200 (ms) | total wall (ms) |");
  console.log("|---|---:|---:|");
  console.log(`| mean   | ${firstHealthy.mean.toFixed(0)} | ${totals.mean.toFixed(0)} |`);
  console.log(`| median | ${firstHealthy.median.toFixed(0)} | ${totals.median.toFixed(0)} |`);
  console.log(`| min    | ${firstHealthy.min.toFixed(0)}  | ${totals.min.toFixed(0)}  |`);
  console.log(`| max    | ${firstHealthy.max.toFixed(0)}  | ${totals.max.toFixed(0)}  |`);
  console.log("");
  console.log("Per-run breakdown:");
  for (const [i, r] of results.entries()) {
    console.log(`  run ${i + 1}: first 200 at ${r.firstHealthyMs.toFixed(0)}ms`);
  }
}

main().catch((e) => {
  console.error("cold-start bench failed:", e);
  process.exit(1);
});
