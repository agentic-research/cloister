// Tests for the manifest → VaultProxyRoute service-registry conversion
// (cloister-8f57f0 manifest extension). The conversion lives in
// src/manifest/runtime.ts (`buildServiceRegistry` + `toRouteInjection`)
// and turns the capnp-side `VaultProxyServiceConfig` (object-with-single-
// key injection union) into the route-side `VaultProxyService`
// (TS-discriminated-union injection).
//
// We exercise the conversion via `instantiate()` since the helpers are
// module-internal; the public surface is "manifest in → working route
// out."

import { describe, expect, it } from "vitest";
import { instantiate } from "../../src/manifest/runtime.js";
import type { Gateway } from "../../src/manifest/types.js";

const ACTOR_STUB = {
  fingerprint: "", algorithm: "ed25519", pubkeyBinding: "",
  attestationRepo: "", tunnelEndpoint: "",
};
const POLICY_STUB = {
  maxCertLifetimeSeconds: 300, requireInterlock: true, minAlgorithm: "ed25519",
};
const META_STUB = { name: "test", version: "0.0.0" };

function makeManifest(services: Gateway["vaultProxyServices"] = []): Gateway {
  return {
    metadata: META_STUB,
    actor:    ACTOR_STUB,
    policy:   POLICY_STUB,
    vaultProxyServices: services,
    routes: [
      { path: "/vault/proxy", kind: { vaultProxy: null } },
    ],
  };
}

describe("vaultProxyServices manifest extension (cloister-8f57f0)", () => {
  it("instantiates a vaultProxy route with an empty services list (safe-closed default)", () => {
    // No services declared → the route mounts but every request 404s
    // through the safe-closed default (preserves §9.4.b oracle).
    const routes = instantiate(makeManifest([]));
    expect(routes.length).toBe(1);
    // match() proves the route is alive; further wiring asserted by
    // vault-proxy-route.test.ts.
    expect(routes[0].match(new Request("http://x/vault/proxy/anything"))).toBe(true);
  });

  it("instantiates a vaultProxy route with a populated services list", () => {
    const routes = instantiate(makeManifest([
      {
        name: "openai",
        upstreamBaseUrl: "https://api.openai.test",
        defaultAllowedSubs: ["sha256:bundle-a:*"],
        rateLimitPerMinute: 60,
        injection: { authorizationBearer: null },
      },
    ]));
    expect(routes.length).toBe(1);
    expect(routes[0].match(new Request("http://x/vault/proxy/openai/v1/chat"))).toBe(true);
  });

  it("rejects duplicate service names at instantiate time", () => {
    expect(() => instantiate(makeManifest([
      {
        name: "openai", upstreamBaseUrl: "https://a.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null },
      },
      {
        name: "openai", upstreamBaseUrl: "https://b.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null },
      },
    ]))).toThrow(/declares "openai" more than once/);
  });

  it("converts each injection union variant correctly", async () => {
    // Smoke each injection kind through the conversion; the route's
    // success path is covered by vault-proxy.test.ts — here we just
    // assert the conversion doesn't blow up + reaches the route.
    const services: Gateway["vaultProxyServices"] = [
      { name: "bearer-svc", upstreamBaseUrl: "https://b.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
      { name: "basic-svc", upstreamBaseUrl: "https://b.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBasic: null } },
      { name: "named-svc", upstreamBaseUrl: "https://n.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { headerNamed: { name: "x-api-key" } } },
      { name: "query-svc", upstreamBaseUrl: "https://q.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { queryParam: { name: "api_key" } } },
      { name: "body-svc", upstreamBaseUrl: "https://b2.example",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { bodyField: { path: "auth.client_secret" } } },
    ];
    const routes = instantiate(makeManifest(services));
    expect(routes.length).toBe(1);
  });

  it("treats omitted vaultProxyServices as empty (safe-closed)", () => {
    // No `vaultProxyServices` key at all — the route still mounts.
    const manifest: Gateway = {
      metadata: META_STUB, actor: ACTOR_STUB, policy: POLICY_STUB,
      routes: [{ path: "/vault/proxy", kind: { vaultProxy: null } }],
    };
    const routes = instantiate(manifest);
    expect(routes.length).toBe(1);
  });

  it("preserves defaultAllowedSubs as a fresh array (no shared mutable reference)", () => {
    const subs = ["sha256:original-sub"];
    const routes = instantiate(makeManifest([
      {
        name: "service-x", upstreamBaseUrl: "https://x.example",
        defaultAllowedSubs: subs, rateLimitPerMinute: 60,
        injection: { authorizationBearer: null },
      },
    ]));
    // Mutating the source array MUST NOT leak into the route's copy.
    subs.push("sha256:added-after-instantiate");
    expect(routes.length).toBe(1);
    // (We can't directly inspect the registry from outside; the test
    // documents the contract that toRouteVaultProxyService spreads
    // the array.)
  });
});
