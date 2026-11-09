// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-1b92fa: `cloister run` / `cloister dev serve` started wrangler on a
// checkout where nothing had produced the Worker's wasm modules, and wrangler
// died at bundle time. ensureWorkerArtifacts is the one provider; these tests
// pin that it covers every import and fails by name rather than letting
// wrangler fail 40 lines into its own stack trace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_WASM, ensureWorkerArtifacts } from "../../cli/lib/dev/worker-artifacts.mjs";
import { main as devMain } from "../../cli/commands/dev.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every `.wasm` path imported under src/, resolved relative to the repo root. */
function srcWasmImports() {
  const out = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        // lint-allow-rawparse: collecting import specifier strings only; the
        // property is "which file does this module name", not TS semantics.
        for (const m of readFileSync(p, "utf8").matchAll(/from\s+"([^"]+\.wasm)"/g)) {
          out.add(resolve(dirname(p), m[1]).slice(ROOT.length + 1));
        }
      }
    }
  };
  walk(resolve(ROOT, "src"));
  return [...out].sort();
}

test("every wasm module the Worker imports is provided by ensureWorkerArtifacts", () => {
  const imported = srcWasmImports();
  assert.ok(imported.length >= 2, `expected the Worker to import its wasm modules, saw ${imported}`);
  const provided = new Set(WORKER_WASM.map((m) => m.path));
  for (const p of imported) {
    assert.ok(provided.has(p), `src/ imports ${p}, which nothing in the CLI provides — wrangler will die at bundle time`);
  }
});

test("every LLO-sourced module has a pinned digest", () => {
  const lock = JSON.parse(readFileSync(resolve(ROOT, "schema-bridge.lock.json"), "utf8"));
  for (const m of WORKER_WASM.filter((x) => x.source === "llo")) {
    assert.match(lock.wasm?.[m.name] ?? "", /^[0-9a-f]{64}$/, `${m.name} has no digest under "wasm"`);
  }
});

function fakes({ cargoStatus = 0, exists = () => true, fetchError = null } = {}) {
  const calls = { cargo: [], fetched: [] };
  return {
    calls,
    opts: {
      root: "/tmp/cloister",
      env: {},
      log: () => {},
      existsSync: exists,
      ensureWasm: async (name) => {
        if (fetchError) throw fetchError;
        calls.fetched.push(name);
        return `/x/${name}`;
      },
      spawnSync: (cmd, args, o) => {
        calls.cargo.push({ cmd, args, cwd: o.cwd, wrapper: o.env.RUSTC_WRAPPER });
        return { status: cargoStatus };
      },
    },
  };
}

test("LLO modules are fetched and cargo modules are built, even when the file exists", async () => {
  // "Skip if present" would serve a module built from an older pin after a
  // bump; cargo's own freshness check is what makes a warm build cheap.
  const { calls, opts } = fakes();
  await ensureWorkerArtifacts(opts);
  assert.deepEqual(calls.fetched, ["leyline_sign.wasm"]);
  assert.equal(calls.cargo.length, 1);
  assert.equal(calls.cargo[0].cmd, "cargo");
  assert.deepEqual(calls.cargo[0].args, ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "cloister-cas"]);
  assert.equal(calls.cargo[0].cwd, "/tmp/cloister/rs");
  assert.equal(calls.cargo[0].wrapper, "");
});

test("a failed cargo build is a named error that says how to fix it", async () => {
  const { opts } = fakes({ cargoStatus: 101 });
  await assert.rejects(ensureWorkerArtifacts(opts), /cloister_cas\.wasm failed[\s\S]*rustup target add wasm32-unknown-unknown/);
});

test("a digest failure on the LLO asset stops the start", async () => {
  const { opts } = fakes({ fetchError: new Error("schema-bridge: DIGEST MISMATCH for leyline_sign.wasm") });
  await assert.rejects(ensureWorkerArtifacts(opts), /leyline_sign\.wasm: schema-bridge: DIGEST MISMATCH/);
});

test("dev serve does not start the router when the wasm cannot be provided", async () => {
  let started = false;
  let err = "";
  const code = await devMain(["serve", "--dir", "/tmp/cloister"], {
    ensureWorkerArtifacts: async () => { throw new Error("building cloister_cas.wasm failed"); },
    startLocalRouter: () => { started = true; return {}; },
    waitForChild: async () => 0,
    log: () => {},
    errLog: (m) => { err += m; },
    env: {},
  });
  assert.equal(code, 1);
  assert.equal(started, false, "router started without its wasm");
  assert.match(err, /cloister_cas\.wasm failed/);
});
