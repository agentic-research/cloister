// Tests for the manifest → VaultProxyRoute service-registry conversion
// (cloister-8f57f0 manifest extension).
//
// The conversion lives in src/manifest/vault-proxy-services.ts and turns
// the capnp-side `VaultProxyServiceConfig` (object-with-single-key
// injection union) into the route-side `VaultProxyService` (TS-
// discriminated-union injection).
//
// These tests OBSERVE the converted output directly (the conversion
// function is exported as the pure-module entry point used by both
// the runtime AND the build-time validator). Per Copilot review on
// PR #36, the prior version of these tests only checked
// `routes.length === 1` — that wouldn't catch a queryParam → headerNamed
// mismapping. This version asserts on the converted shape.

import { describe, expect, it } from "vitest";
import { buildServiceRegistry } from "../../src/manifest/vault-proxy-services.js";
import type { Gateway, VaultProxyServiceConfig } from "../../src/manifest/types.js";
import { instantiate } from "../../src/manifest/runtime.js";

const ACTOR_STUB = {
  fingerprint: "", algorithm: "ed25519", pubkeyBinding: "",
  attestationRepo: "", tunnelEndpoint: "",
};
const POLICY_STUB = {
  maxCertLifetimeSeconds: 300, requireInterlock: true, minAlgorithm: "ed25519",
};
const META_STUB = { name: "test", version: "0.0.0" };

function makeManifest(services: readonly VaultProxyServiceConfig[] = []): Gateway {
  return {
    metadata: META_STUB,
    actor:    ACTOR_STUB,
    policy:   POLICY_STUB,
    vaultProxyServices: services,
    routes: [{ path: "/vault/proxy", kind: { vaultProxy: null } }],
  };
}

describe("buildServiceRegistry — pure-module conversion (cloister-8f57f0)", () => {
  it("returns an empty Map for an empty list (safe-closed default)", () => {
    const registry = buildServiceRegistry([]);
    expect(registry.size).toBe(0);
  });

  it("converts a single service end-to-end and preserves every field", () => {
    const registry = buildServiceRegistry([{
      name: "openai",
      upstreamBaseUrl: "https://api.openai.test",
      defaultAllowedSubs: ["sha256:bundle-a:*", "sha256:bundle-b:*"],
      rateLimitPerMinute: 60,
      injection: { authorizationBearer: null },
    }]);
    const svc = registry.get("openai")!;
    expect(svc.name).toBe("openai");
    expect(svc.upstreamBaseUrl).toBe("https://api.openai.test");
    expect(svc.defaultAllowedSubs).toEqual(["sha256:bundle-a:*", "sha256:bundle-b:*"]);
    expect(svc.rateLimitPerMinute).toBe(60);
    expect(svc.injection).toEqual({ kind: "authorizationBearer" });
  });

  it("converts each injection variant to the right discriminated kind (Copilot #3)", () => {
    const registry = buildServiceRegistry([
      { name: "bearer-svc", upstreamBaseUrl: "https://b.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
      { name: "basic-svc", upstreamBaseUrl: "https://b.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBasic: null } },
      { name: "named-svc", upstreamBaseUrl: "https://n.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { headerNamed: { name: "x-api-key" } } },
      { name: "query-svc", upstreamBaseUrl: "https://q.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { queryParam: { name: "api_key" } } },
      { name: "body-svc", upstreamBaseUrl: "https://b2.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { bodyField: { path: "auth.client_secret" } } },
    ]);
    expect(registry.get("bearer-svc")!.injection).toEqual({ kind: "authorizationBearer" });
    expect(registry.get("basic-svc")!.injection).toEqual({ kind: "authorizationBasic" });
    expect(registry.get("named-svc")!.injection).toEqual({ kind: "headerNamed", name: "x-api-key" });
    expect(registry.get("query-svc")!.injection).toEqual({ kind: "queryParam", name: "api_key" });
    expect(registry.get("body-svc")!.injection).toEqual({ kind: "bodyField", path: "auth.client_secret" });
  });

  it("rejects duplicate service names", () => {
    expect(() => buildServiceRegistry([
      { name: "openai", upstreamBaseUrl: "https://a.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
      { name: "openai", upstreamBaseUrl: "https://b.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
    ])).toThrow(/declares "openai" more than once/);
  });

  it("Copilot #4 — defaultAllowedSubs is COPIED, not shared (observed via registry)", () => {
    const subs: string[] = ["sha256:original"];
    const registry = buildServiceRegistry([{
      name: "iso", upstreamBaseUrl: "https://i.test",
      defaultAllowedSubs: subs, rateLimitPerMinute: 60,
      injection: { authorizationBearer: null },
    }]);
    // Mutate the source array AFTER conversion; observed registry copy MUST NOT see the addition.
    subs.push("sha256:added-after");
    expect(registry.get("iso")!.defaultAllowedSubs).toEqual(["sha256:original"]);
  });

  it("Copilot #5 — defaultAllowedSubs undefined (capnp omits empty pointer fields) → treated as []", () => {
    // Cast through unknown to simulate capnp's JSON encoding omitting the
    // field entirely. Pre-Copilot fix, this would crash on `[...undefined]`.
    const malformed = {
      name: "no-subs", upstreamBaseUrl: "https://x.test",
      // defaultAllowedSubs intentionally omitted
      rateLimitPerMinute: 60,
      injection: { authorizationBearer: null },
    } as unknown as VaultProxyServiceConfig;
    const registry = buildServiceRegistry([malformed]);
    expect(registry.get("no-subs")!.defaultAllowedSubs).toEqual([]);
  });

  // ── Copilot #6 + #7 — required-string validation ─────────────────────

  it("rejects empty name", () => {
    expect(() => buildServiceRegistry([
      { name: "", upstreamBaseUrl: "https://x.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
    ])).toThrow(/vaultProxyService\.name must be a non-empty string/);
  });

  it("rejects missing upstreamBaseUrl", () => {
    const bad = { name: "svc", defaultAllowedSubs: [], rateLimitPerMinute: 60,
      injection: { authorizationBearer: null } } as unknown as VaultProxyServiceConfig;
    expect(() => buildServiceRegistry([bad]))
      .toThrow(/upstreamBaseUrl must be a non-empty string/);
  });

  it("rejects upstreamBaseUrl that isn't a valid URL", () => {
    expect(() => buildServiceRegistry([
      { name: "svc", upstreamBaseUrl: "not-a-url",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
    ])).toThrow(/is not a valid URL/);
  });

  it("rejects non-integer / negative rateLimitPerMinute", () => {
    const cases = [-1, 1.5, NaN, Infinity];
    for (const rate of cases) {
      expect(() => buildServiceRegistry([
        { name: `r-${rate}`, upstreamBaseUrl: "https://x.test",
          defaultAllowedSubs: [], rateLimitPerMinute: rate,
          injection: { authorizationBearer: null } },
      ])).toThrow(/rateLimitPerMinute must be a non-negative integer/);
    }
  });

  it("rejects empty payload string in headerNamed / queryParam / bodyField (Copilot low-confidence)", () => {
    const variants = [
      { kind: "headerNamed", payload: { headerNamed: { name: "" } }, msg: /headerNamed\.name/ },
      { kind: "queryParam",  payload: { queryParam:  { name: "" } }, msg: /queryParam\.name/ },
      { kind: "bodyField",   payload: { bodyField:   { path: "" } }, msg: /bodyField\.path/ },
    ];
    for (const v of variants) {
      expect(() => buildServiceRegistry([
        { name: `svc-${v.kind}`, upstreamBaseUrl: "https://x.test",
          defaultAllowedSubs: [], rateLimitPerMinute: 60,
          injection: v.payload as VaultProxyServiceConfig["injection"] },
      ])).toThrow(v.msg);
    }
  });
});

// ── Smoke: end-to-end through instantiate() ──────────────────────────────

describe("instantiate(manifest) wires vaultProxyServices into VaultProxyRoute", () => {
  it("mounts the route even when vaultProxyServices is omitted entirely", () => {
    const manifest: Gateway = {
      metadata: META_STUB, actor: ACTOR_STUB, policy: POLICY_STUB,
      routes: [{ path: "/vault/proxy", kind: { vaultProxy: null } }],
    };
    expect(instantiate(manifest)).toHaveLength(1);
  });

  it("mounts the route when vaultProxyServices is populated", () => {
    expect(instantiate(makeManifest([
      { name: "openai", upstreamBaseUrl: "https://api.openai.test",
        defaultAllowedSubs: ["sha256:bundle-a:*"], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
    ]))).toHaveLength(1);
  });

  it("surfaces buildServiceRegistry validation errors through instantiate()", () => {
    expect(() => instantiate(makeManifest([
      { name: "", upstreamBaseUrl: "https://x.test",
        defaultAllowedSubs: [], rateLimitPerMinute: 60,
        injection: { authorizationBearer: null } },
    ]))).toThrow(/vaultProxyService\.name must be a non-empty string/);
  });
});
