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
    pool: cloudflarePool(workerConfig),
    // The CC plugin lives at hooks/ and is tested via node --test (not vitest)
    // because workerd has no `node:test`. Keep its tests off vitest's path.
    exclude: ["**/node_modules/**", "**/dist/**", "hooks/**"],
    // Explicit include — pins both test dirs so `vitest list` and
    // `vitest run` agree (without this they used different discovery
    // and `vitest list` silently omitted vault, masking what was
    // actually being gated). 76 vault cases (the lifted adversarial
    // corpus from cloister-9ad9eb) belong in the gate; this makes
    // that obvious to anyone reading the config rather than relying
    // on default-glob behavior.
    include: [
      "test/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "vault/src/__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
  },
});
