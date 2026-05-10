// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in vitest config for the lease-pipeline microbenchmark
// (cloister-747d98). Invoked via `task bench:lease`; NOT part of
// `task lint` / `task test`.
//
// Mirrors `vitest.config.ts` (same workerd pool, same wrangler.toml)
// but with `include` scoped to `test/perf/**` so the bench doesn't
// drag the full 619-case suite along.

import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const workerConfig = {
  wrangler: { configPath: "./wrangler.toml" },
  main: "./src/index.ts",
  miniflare: {
    serviceBindings: {
      NOTME: async () => new Response("notme not available in bench", { status: 503 }),
    },
  },
} as const;

export default defineConfig({
  plugins: [cloudflareTest(workerConfig)],
  test: {
    pool: cloudflarePool(workerConfig),
    include: ["test/perf/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Long-running bench iterations — give the suite a generous deadline.
    testTimeout: 120_000,
  },
});
