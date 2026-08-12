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
  // The symlink points at the real Wrangler config from a test-only directory.
  // Wrangler resolves .dev.vars beside the configured path, so this keeps an
  // operator's live harness credentials out of the test Worker without a
  // second copy of deployment configuration.
  wrangler: { configPath: "./test/wrangler.vitest.toml" },
  main: "./src/index.ts",
  miniflare: {
    serviceBindings: {
      // notme isn't running in unit tests.
      NOTME: async () => new Response("notme not available in test", { status: 503 }),
      // NOTME_JWT is an RPC entrypoint (notme's JwtSigner, ADR-015), not a
      // fetch service — but wrangler.toml declares it, so workerd refuses to
      // start unless the name resolves to something. A fetch stub satisfies
      // that without pretending to be a signer: it has no `signJwt` method, so
      // `fetchJwtSignature`'s capability check treats it as absent and returns
      // null, which is the same 503 an unreachable signer produces.
      //
      // Tests that need real signing inject their own `NOTME_JWT` into the env
      // object they build, which shadows this. Deliberately NOT stubbing a
      // working signer here: a default that silently signs would let a test
      // pass without ever declaring it wanted a signer.
      NOTME_JWT: async () => new Response("notme JwtSigner is RPC-only", { status: 503 }),
      // Same reasoning as NOTME_JWT: resolves the wrangler-declared name so
      // workerd starts, without presenting `signReceipt`/`receiptFacts`. The
      // shape check in delegatedReceiptSignerFrom() therefore treats it as
      // absent and the emitter falls back to the env path — which is what an
      // unbound deployment does, so tests exercise the real fallback.
      NOTME_RECEIPTS: async () => new Response("notme ReceiptSigner is RPC-only", { status: 503 }),
      // KEK_HELPER stub — same wire shape as leyline-sign-helper
      // (LLO `rs/ll-open/sign/`, ADR-0019).
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
      //
      // ADR-0053 (cloister-220c9d): an empty INTERLACE_ROOT_PUBKEY is "gate
      // off" ONLY under an explicit CLOISTER_MODE=dev opt-out — otherwise the
      // resolver enforces + fails closed (rule 5, the empty-value fix). The
      // test suite's default is exactly that dev opt-out, so make it explicit
      // here. The DEV_* seams (static bundle, vault seed, authz overlay) stay
      // inactive because their own vars (DEV_CA_MASTER, DEV_VAULT_SEED, …) are
      // unset — CLOISTER_MODE=dev alone only enables the gate-off opt-out.
      CLOISTER_MODE: "dev",
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
    // Integration timeout. These run in REAL workerd against REAL DOs, so
    // some cases are inherently slower than a unit test — e.g. the disclosure
    // pagination tests mint 105/150 attestation rows via sequential cross-DO
    // RPCs before asserting. Vitest's default is 5000ms (a unit-test default);
    // under the pre-push gate's full parallel load (cargo wasm/host builds +
    // ~18 lint-script node processes + vitest all contending for CPU, observed
    // import wall-clock >700s) those tests get starved and trip the 5s deadline
    // despite passing in ~2s in isolation. 30s keeps the integration suite
    // reliable as a DEFAULT gate — it is NOT disabled or skipped — without
    // masking a genuine hang (a real deadlock still fails in 30s). Per
    // cloister-f3e3ae (flaky disclosure pagination under pre-push contention).
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
