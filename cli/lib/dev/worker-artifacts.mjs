// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Worker statically imports wasm modules. wrangler bundles them at start, so
// a missing file is not a degraded run — wrangler dies at bundle time and the
// run never binds :8787 (cloister-1b92fa).
//
// Only `task test` / `task lint` used to produce them. Every CLI path a user is
// told to follow — install, runtime install, dev serve, run — skipped that, so
// the documented path worked only on a machine where a developer had already
// run the test gate. This module is the one place that provides them, and
// `scripts/test/worker-artifacts.test.mjs` asserts that every `.wasm` import
// under src/ is one of WORKER_WASM, so a new import cannot repeat the gap.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { resolve } from "node:path";

import { LocalDevError } from "./router.mjs";

/**
 * Every wasm module the Worker imports, by the path src/ imports it from.
 *
 * `llo`: LLO's published release asset, digest-pinned in
 *   schema-bridge.lock.json and fetched (verify-every-run, fail closed) —
 *   cloister-dbe9c3.
 * `cargo`: still built here, until LLO's cas-ffi asset carries the exports
 *   cloister-cas adds (ley-line-open-dbacd2).
 */
export const WORKER_WASM = [
  { path: "rs/target/llo-wasm/leyline_sign.wasm", source: "llo", name: "leyline_sign.wasm" },
  {
    path: "rs/target/wasm32-unknown-unknown/release/cloister_cas.wasm",
    source: "cargo",
    pkg: "cloister-cas",
  },
];

/**
 * Make every module in WORKER_WASM present and current before wrangler starts.
 *
 * The LLO asset goes through ensureWasm, which re-verifies its digest on every
 * call, so a file from another pin is replaced, never trusted. The cargo module
 * is ALWAYS handed to cargo rather than skipped when present: cargo's own
 * freshness check makes a warm build a no-op, while "skip if it exists" would
 * serve a module built from an older pin after a bump.
 *
 * @param {{root: string, env?: Record<string, string|undefined>,
 *          spawnSync?: Function, existsSync?: (p: string) => boolean,
 *          ensureWasm?: (name: string) => Promise<string>,
 *          log?: (m: string) => void}} options
 */
export async function ensureWorkerArtifacts({
  root,
  env = process.env,
  spawnSync = nodeSpawnSync,
  existsSync = nodeExistsSync,
  ensureWasm,
  log = (m) => process.stderr.write(`${m}\n`),
}) {
  if (!root) throw new LocalDevError("a Cloister checkout directory is required");
  const checkout = resolve(root);
  const fetchWasm = ensureWasm
    ?? (await import(resolve(checkout, "scripts/fetch-schema-bridge.mjs"))).ensureWasm;

  for (const m of WORKER_WASM) {
    if (m.source === "llo") {
      try {
        await fetchWasm(m.name);
      } catch (e) {
        throw new LocalDevError(
          `could not provide ${m.path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    }

    if (!existsSync(resolve(checkout, m.path))) {
      log(`cloister — building ${m.path} (first run in this checkout)`);
    }
    const r = spawnSync(
      "cargo",
      ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", m.pkg],
      {
        cwd: resolve(checkout, "rs"),
        // Same as rs/Taskfile.yml: a machine-global wrapper (sccache) is not a
        // dependency of this build.
        env: { ...env, RUSTC_WRAPPER: "" },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (r.error || r.status !== 0) {
      throw new LocalDevError(
        `building ${m.path} failed (cargo exit ${r.status ?? r.error?.message}).\n` +
        `  The Worker imports it, so wrangler cannot start without it.\n` +
        `  Needs Rust with the wasm32 target: rustup target add wasm32-unknown-unknown`,
      );
    }
    if (!existsSync(resolve(checkout, m.path))) {
      throw new LocalDevError(`cargo succeeded but ${m.path} does not exist`);
    }
  }
}
