/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// ADR-0042 dev-mode proof. Drives the REAL `defaultLeaseVerifier` (no injected
// verifier) through `VaultProxyRoute` with `CLOISTER_MODE=dev`: the static dev
// CA bundle (built from DEV_CA_MASTER) replaces the notme fetch, and the
// DEV_ALLOWED_SUBS overlay opens the manifest-side gate — but the full
// cert-chain + Ed25519 + scope + replay pipeline still runs. A dev-signed
// request is accepted and the credential injected; the same request with
// dev mode OFF is rejected 401 (safe-closed, no notme). This proves the dev
// seams relax only the trust-anchor SOURCE, never per-request verification.
//
// Uses the committed fixture cert as the stand-in "dev identity" (the rust
// `mint-dev-cert` produces the same shape at runtime); DEV_CA_MASTER is the
// fixture master, so the static bundle verifies the fixture cert's chain.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  VaultProxyRoute,
  applyDevAllowedSubs,
  applyDevPassthrough,
  devCaBundle,
} from "../../src/routes/vault-proxy-route.js";
import { InMemoryCredentialStore } from "../../src/routes/vault-proxy-credential-store.js";
import type { UpstreamFetcher, VaultProxyService } from "../../src/routes/vault-proxy.js";
import type { Env } from "../../src/types.js";
import { signLeaseHeaders, type EphemeralIdentity } from "../../tools/harness-shim/lease-signer.js";
import {
  CERT_ADMIN_B64,
  EPHEMERAL_PRIV_SEED_B64,
  EPHEMERAL_PUBKEY_B64,
  MASTER_PUBKEY_B64_STD,
} from "../wire/fixtures/cert-chain.js";

const DEV_IDENTITY: EphemeralIdentity = {
  certB64:     CERT_ADMIN_B64,
  privSeedB64: EPHEMERAL_PRIV_SEED_B64,
  pubKeyB64:   EPHEMERAL_PUBKEY_B64,
};
const DEV_PEER_FP = "sha256:abc123def456"; // the fixture admin cert's peer_fp
const CLOISTER_URL = "https://cloister.test/vault/proxy/anthropic/v1/messages";
const VAULTED_KEY = "sk-ant-dev-secret";

// The fixture cert's validity is 2023→2049 (epoch 7); real Date.now() sits
// inside it, so the dev verifier's live clock passes the window + skew checks.
function devEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    CLOISTER_MODE:    "dev",
    DEV_CA_MASTER:    MASTER_PUBKEY_B64_STD,
    DEV_CA_EPOCH:     "7",
    DEV_ALLOWED_SUBS: JSON.stringify([DEV_PEER_FP]),
    INTERLACE_ROOT_PUBKEY: "",
    ...overrides,
  };
}

// anthropic service with defaultAllowedSubs = [] (deny-all) — the dev overlay
// must open it for the request to pass.
function anthropicService(): VaultProxyService {
  return {
    name:               "anthropic",
    upstreamBaseUrl:    "https://api.anthropic.com",
    injection:          { kind: "headerNamed", name: "x-api-key" },
    defaultAllowedSubs: [],
    rateLimitPerMinute: 0,
  };
}

function buildRoute(upstream: UpstreamFetcher): VaultProxyRoute {
  const credentials = new InMemoryCredentialStore();
  credentials.set(DEV_PEER_FP, "anthropic", { credential: VAULTED_KEY });
  // No leaseVerifier → the REAL defaultLeaseVerifier runs.
  return new VaultProxyRoute({
    credentials,
    services: (name) => (name === "anthropic" ? anthropicService() : null),
    upstream,
  });
}

beforeEach(async () => {
  const { runInDurableObject } = await import("cloudflare:test");
  const stub = env.TRUST_STORE.get(env.TRUST_STORE.idFromName("cluster"));
  await runInDurableObject(stub, async (_: unknown, state: { storage: { sql: { exec: (q: string) => void } } }) => {
    state.storage.sql.exec("DELETE FROM seen_nonces");
    state.storage.sql.exec("DELETE FROM peer_lease_counters");
  });
});

describe("vault proxy — CLOISTER_MODE=dev (ADR-0042)", () => {
  it("dev-signed request passes the REAL gate via the static dev bundle (no notme); key injected", async () => {
    const body = JSON.stringify({ model: "claude-sonnet-5", messages: [] });
    const headers = await signLeaseHeaders({ method: "POST", url: CLOISTER_URL, body, identity: DEV_IDENTITY });

    let injected: string | null = null;
    const upstream: UpstreamFetcher = {
      fetch: async (r) => { injected = r.headers.get("x-api-key"); return new Response("ok", { status: 200 }); },
    };

    const req = new Request(CLOISTER_URL, { method: "POST", headers: new Headers(Object.entries(headers)), body });
    const res = await buildRoute(upstream).handle(req, devEnv());

    expect(res.status).toBe(200);
    expect(injected).toBe(VAULTED_KEY); // vaulted key injected; harness sent none
  });

  it("dev mode OFF → same request rejected 401 (safe-closed, no notme, no root pubkey)", async () => {
    const body = JSON.stringify({ model: "claude-sonnet-5", messages: [] });
    const headers = await signLeaseHeaders({ method: "POST", url: CLOISTER_URL, body, identity: DEV_IDENTITY });

    let called = false;
    const upstream: UpstreamFetcher = {
      fetch: async () => { called = true; return new Response("no", { status: 200 }); },
    };

    const req = new Request(CLOISTER_URL, { method: "POST", headers: new Headers(Object.entries(headers)), body });
    // CLOISTER_MODE unset + INTERLACE_ROOT_PUBKEY empty → defaultLeaseVerifier 401.
    const res = await buildRoute(upstream).handle(req, devEnv({ CLOISTER_MODE: "" }));

    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });
});

describe("dev-mode seams are pure + gated (ADR-0042)", () => {
  it("devCaBundle: null outside dev mode, static bundle in dev", () => {
    expect(devCaBundle(devEnv({ CLOISTER_MODE: "prod" }))).toBeNull();
    expect(devCaBundle({ ...devEnv(), DEV_CA_MASTER: "" } as Env)).toBeNull();
    const b = devCaBundle(devEnv());
    expect(b?.keys.active).toBe(MASTER_PUBKEY_B64_STD);
    expect(b?.epoch).toBe(7);
  });

  it("applyDevAllowedSubs: overlays in dev, untouched otherwise", () => {
    const cfg = anthropicService();
    expect(applyDevAllowedSubs(cfg, devEnv({ CLOISTER_MODE: "prod" }))?.defaultAllowedSubs).toEqual([]);
    expect(applyDevAllowedSubs(cfg, devEnv())?.defaultAllowedSubs).toEqual([DEV_PEER_FP]);
    // comma-separated form also accepted
    expect(applyDevAllowedSubs(cfg, devEnv({ DEV_ALLOWED_SUBS: "a,b" }))?.defaultAllowedSubs).toEqual(["a", "b"]);
  });

  it("applyDevPassthrough: forces passthrough in dev for named services only", () => {
    const cfg = anthropicService(); // headerNamed x-api-key (custody)
    expect(applyDevPassthrough(cfg, devEnv({ CLOISTER_MODE: "prod", DEV_PASSTHROUGH_SERVICES: "anthropic" }))?.injection.kind).toBe("headerNamed");
    expect(applyDevPassthrough(cfg, devEnv({ DEV_PASSTHROUGH_SERVICES: "anthropic" }))?.injection.kind).toBe("passthrough");
    expect(applyDevPassthrough(cfg, devEnv({ DEV_PASSTHROUGH_SERVICES: "openai" }))?.injection.kind).toBe("headerNamed");
  });
});

describe("vault proxy — audit passthrough (ADR-0040 amendment)", () => {
  it("forwards the harness's own auth + anthropic-beta, injects nothing, needs no credential, hides the lease", async () => {
    const body = JSON.stringify({ model: "claude-sonnet-5", messages: [] });
    const headers = await signLeaseHeaders({ method: "POST", url: CLOISTER_URL, body, identity: DEV_IDENTITY });
    const HARNESS_OAUTH = "Bearer max-oauth-token-xyz";

    let seen: Record<string, string | null> = {};
    const upstream: UpstreamFetcher = {
      fetch: async (r) => {
        seen = {
          auth:        r.headers.get("authorization"),
          beta:        r.headers.get("anthropic-beta"),
          xApiKey:     r.headers.get("x-api-key"),
          signetSig:   r.headers.get("x-signet-sig"),
          harnessAuth: r.headers.get("x-harness-authorization"),
        };
        return new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    };

    // Empty credential store — passthrough must NOT need one.
    const route = new VaultProxyRoute({
      credentials: new InMemoryCredentialStore(),
      services: (n) => (n === "anthropic" ? anthropicService() : null),
      upstream,
    });

    const h = new Headers(Object.entries(headers));
    h.set("x-harness-authorization", HARNESS_OAUTH); // shim side-channels the harness's OAuth
    h.set("anthropic-beta", "oauth-2024-01");
    const req = new Request(CLOISTER_URL, { method: "POST", headers: h, body });

    const res = await route.handle(req, devEnv({ DEV_PASSTHROUGH_SERVICES: "anthropic" }) as unknown as Env);

    expect(res.status).toBe(200);
    expect(seen.auth).toBe(HARNESS_OAUTH);     // harness's own auth restored upstream
    expect(seen.beta).toBe("oauth-2024-01");   // preserved
    expect(seen.xApiKey).toBeNull();           // nothing injected — audit, not custody
    expect(seen.signetSig).toBeNull();         // lease headers NOT leaked upstream
    expect(seen.harnessAuth).toBeNull();       // side-channel consumed
  });
});
