import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

// cloudflareTest() → Vite plugin that resolves the cloudflare:test virtual module (SELF, env)
// cloudflarePool() → pool runner that executes tests inside real workerd
// Both must be used together.
// Deterministic test KEK — committed because it's obviously not a real
// secret. Tests exercise the same code path as production
// (HelperKekSource → KEK_HELPER fetch → returns bytes) — only the
// backend differs (real Keychain in prod, this stub in tests). Same
// discipline either way: no plaintext env-binding shortcut.
//
// ADR-0014 v2 (cloister-125199): tests must use a real URL spec, not
// VAULT_KEK_SECRET. The keychain:// scheme is the chosen test path
// because it exercises the helper-mediated resolution that prod uses.
const VITEST_KEK_BYTES = "vitest-deterministic-kek-32b-not-a-secret";

const workerConfig = {
  wrangler: { configPath: "./wrangler.toml" },
  main: "./src/index.ts",
  miniflare: {
    serviceBindings: {
      // notme isn't running in unit tests.
      NOTME: async () => new Response("notme not available in test", { status: 503 }),
      // KEK_HELPER stub — same wire shape as leyline-sign-helper
      // (rs/crates/sign/, ADR-0019).
      // Responds to GET /resolve?url=keychain://vitest-kek with the
      // deterministic test KEK bytes. Any other URL → 404 so tests
      // that accidentally point at a real keychain entry fail loudly.
      KEK_HELPER: async (req: Request) => {
        const u = new URL(req.url);
        if (u.pathname !== "/resolve") return new Response("not found", { status: 404 });
        const spec = u.searchParams.get("url") ?? "";
        if (spec === "keychain://vitest-kek") {
          return new Response(VITEST_KEK_BYTES, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return new Response(JSON.stringify({ error: "unknown spec", spec }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    },
    bindings: {
      // Tests point at the stub via keychain:// — same URL spec shape
      // production uses for macOS / Linux deployments. The miniflare
      // KEK_HELPER above intercepts the resolve call.
      VAULT_KEK_SOURCE: "keychain://vitest-kek",
      // Explicit test defaults — override wrangler.toml's [vars] +
      // any .env.local pollution. Without these, running `task lint`
      // after `task dev:bootstrap` (which writes INTERLACE_ROOT_PUBKEY
      // to .env.local) makes wrangler pick up the bootstrap'd value,
      // the lease/auth gate engages in workerd routes (e.g. OCI
      // registry, cred-iso/v1), and tests that don't explicitly
      // scope auth-on get 401 instead of the expected 201/202/400.
      // Per-test auth tests still work via per-test envWithGate(...)
      // helpers that override these bindings. Per cloister-de6870.
      INTERLACE_ROOT_PUBKEY: "",
      INTERLACE_MASTER_PUBKEY: "",
      INTERLACE_DISCLOSURE_HMAC_KEY: "",
    },
  },
} as const;

export default defineConfig({
  plugins: [cloudflareTest(workerConfig)],
  test: {
    pool: cloudflarePool(workerConfig),
    // The CC plugin lives at hooks/ and is tested via node --test (not vitest)
    // because workerd has no `node:test`. Keep its tests off vitest's path.
    // `test/perf/**` is opt-in (cloister-747d98) — not part of the lint gate;
    // run it via `task bench:lease` to regenerate `docs/perf/*.md` numbers.
    exclude: ["**/node_modules/**", "**/dist/**", "hooks/**", "test/perf/**"],
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
