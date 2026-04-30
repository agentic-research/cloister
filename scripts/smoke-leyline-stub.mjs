#!/usr/bin/env node
/**
 * smoke-leyline-stub — wire-end-to-end check against stub-companion.
 *
 * Spawns `scripts/stub-companion.mjs` on an ephemeral port; encodes a
 * capnp ToolCall via the production codec; POSTs it over real HTTP;
 * decodes the response. Validates the cloister↔companion wire works
 * against a real HTTP listener, not just an in-process stub fetcher
 * (which is what `test/manifest/leyline-net-backend.test.ts` does).
 *
 * Different layer than the existing smoke tests:
 *   - `test/wire/cross-check.test.ts`     — capnp CLI → our decoder
 *   - `task wire:verify-roundtrip`        — our encoder → capnp CLI → our decoder
 *   - `task smoke` (e2e-smoke.sh)         — full wrangler+leyline daemon path
 *   - `task smoke:leyline-stub` (this)    — production codec → real HTTP socket → stub-companion → real HTTP → production codec
 *
 * Exits 0 on green, 1 on any failure (with diagnostics on stderr).
 */

import { spawn } from "node:child_process";
import { encodeToolCall } from "../dist-verify/src/wire/tool-call.js";
import { decodeToolResult } from "../dist-verify/src/wire/tool-result.js";

const PORT = Number(process.env.PORT ?? 18385);  // off-by-default to avoid clashes with `task companion:stub`
const TIMEOUT_MS = 10_000;

// ── Spawn stub-companion ──────────────────────────────────────────────────

console.error(`smoke: spawning stub-companion on :${PORT}`);
const stub = spawn("node", ["scripts/stub-companion.mjs"], {
  env: { ...process.env, PORT: String(PORT), STUB_COMPANION_VERBOSE: "" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stubReady = false;
const stubLogs = [];
stub.stderr.on("data", (chunk) => {
  const s = chunk.toString();
  stubLogs.push(s);
  if (s.includes("listening on")) stubReady = true;
});

const cleanup = () => { try { stub.kill("SIGTERM"); } catch { /* ignore */ } };
process.on("exit", cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

await waitFor(() => stubReady, 5000, "stub-companion did not start in 5s");

// ── Run assertions ────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const fail = (name, msg) => { console.error(`  ✗ ${name}: ${msg}`); failed++; };
const pass = (name) => { console.error(`  ✓ ${name}`); passed++; };

await test("rosary:rsry_status — canned stub response matches", async () => {
  const tc = encodeToolCall({
    upstreamId:    "rosary",
    toolName:      "rsry_status",
    argumentsJson: new TextEncoder().encode("{}"),
  });
  const tr = await postCapnp(tc);
  const text = first(tr.content)?.text;
  if (!text) throw new Error(`no text content: ${JSON.stringify(tr)}`);
  const parsed = JSON.parse(text);
  if (parsed.phase !== "ready") throw new Error(`expected phase=ready, got ${parsed.phase}`);
});

await test("rosary:rsry_list_beads — canned stub returns total=0", async () => {
  const tc = encodeToolCall({
    upstreamId:    "rosary",
    toolName:      "rsry_list_beads",
    argumentsJson: new TextEncoder().encode("{}"),
  });
  const tr = await postCapnp(tc);
  const parsed = JSON.parse(first(tr.content)?.text ?? "");
  if (parsed.total !== 0) throw new Error(`expected total=0, got ${parsed.total}`);
});

await test("unknown:unknown_tool — falls back to wildcard echo", async () => {
  const args = new TextEncoder().encode('{"hello":"world"}');
  const tc = encodeToolCall({
    upstreamId:    "unknown",
    toolName:      "unknown_tool",
    argumentsJson: args,
  });
  const tr = await postCapnp(tc);
  const parsed = JSON.parse(first(tr.content)?.text ?? "");
  if (parsed.stub !== true)            throw new Error(`expected stub=true, got ${parsed.stub}`);
  if (parsed.upstreamId !== "unknown") throw new Error(`upstreamId mismatch: ${parsed.upstreamId}`);
  if (parsed.toolName !== "unknown_tool") throw new Error(`toolName mismatch: ${parsed.toolName}`);
});

await test("stub-companion rejects non-capnp body with 400", async () => {
  const garbage = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
  const res = await fetch(`http://localhost:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-capnp; type=ToolCall" },
    body: garbage,
  });
  if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  const body = await res.text();
  if (!body.includes("invalid capnp")) throw new Error(`unexpected error body: ${body}`);
});

await test("stub-companion rejects GET with 405", async () => {
  const res = await fetch(`http://localhost:${PORT}/`);
  if (res.status !== 405) throw new Error(`expected 405, got ${res.status}`);
});

console.error(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nstub-companion logs:");
  for (const l of stubLogs) process.stderr.write(l);
}
process.exit(failed === 0 ? 0 : 1);

// ── Helpers ───────────────────────────────────────────────────────────────

async function postCapnp(bytes) {
  const res = await fetch(`http://localhost:${PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-capnp; type=ToolCall" },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return decodeToolResult(new Uint8Array(await res.arrayBuffer()));
}

function first(arr) {
  return arr.length > 0 ? arr[0] : undefined;
}

async function test(name, fn) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("test timeout")), TIMEOUT_MS)),
    ]);
    pass(name);
  } catch (e) {
    fail(name, e?.message ?? String(e));
  }
}

async function waitFor(predicate, timeoutMs, errMsg) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(errMsg);
}
