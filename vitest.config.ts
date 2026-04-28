import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

// cloudflareTest() → Vite plugin that resolves the cloudflare:test virtual module (SELF, env)
// cloudflarePool() → pool runner that executes tests inside real workerd
// Both must be used together.
const workerConfig = {
  wrangler: { configPath: "./wrangler.toml" },
  main: "./src/index.ts",
  miniflare: {
    // Stub notme service binding — notme isn't running in unit tests.
    serviceBindings: {
      NOTME: async () => new Response("notme not available in test", { status: 503 }),
    },
  },
} as const;

export default defineConfig({
  plugins: [cloudflareTest(workerConfig)],
  test: {
    // @ts-expect-error cloudflarePool not in vitest's pool type union
    pool: cloudflarePool(workerConfig),
  },
});
