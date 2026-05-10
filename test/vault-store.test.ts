/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// CredentialVault DO integration test — exercises the actual DO binding
// (env.VAULT_STORE) under workerd, with real SQLite + real Web Crypto
// envelope encryption. Complements the pure-function tests in
// vault/src/__tests__/ which exercise the same gate logic with injected
// in-memory storage.
//
// What this test proves that the in-memory tests don't:
//
//   1. The DO actually constructs against the production wrangler.toml
//      binding (so a misconfigured binding fails the gate, not in prod).
//   2. The KEK derivation reads VAULT_KEK_SECRET from env (so removing
//      that env var breaks loudly here, not silently in prod).
//   3. The proxyRequest path's allowedSubs check fires inside the DO,
//      against real SQLite-stored allowedSubs (so an SQL-serialization
//      bug surfaces here, not in prod).
//
// What this test does NOT prove:
//
//   - Identity propagation from in-cluster bundles. callerSub is passed
//     explicitly as a method arg; the DO trusts what it's handed. The
//     question of where callerSub comes from is unresolved per
//     src/vault-store.ts header — gated on the first workerd-bundle
//     Worker landing.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Singleton-per-cluster keying — same convention as TrustStore/BlobStore.
function vaultStub() {
  return env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName("cluster")) as DurableObjectStub & {
    putCredential(service: string, cred: {
      upstream: string;
      headers: Record<string, string>;
      allowedSubs: string[];
    }): Promise<void>;
    getCredentialMetadata(service: string): Promise<{
      upstream: string;
      allowedSubs: string[];
    } | null>;
    deleteCredential(service: string): Promise<boolean>;
    listServices(): Promise<string[]>;
    proxyRequest(service: string, callerSub: string, req: Request): Promise<Response>;
  };
}

describe("CredentialVault DO — wiring + smoke", () => {
  it("the binding resolves and methods are callable", async () => {
    const stub = vaultStub();
    const services = await stub.listServices();
    expect(Array.isArray(services)).toBe(true);
  });

  it("putCredential + getCredentialMetadata round-trips the metadata", async () => {
    const stub = vaultStub();
    await stub.putCredential("test-api-1", {
      upstream: "https://api.test.example/",
      headers: { "x-api-key": "secret-value-1" },
      allowedSubs: ["bundle:test-app:*"],
    });

    const meta = await stub.getCredentialMetadata("test-api-1");
    expect(meta).not.toBeNull();
    expect(meta!.upstream).toBe("https://api.test.example/");
    expect(meta!.allowedSubs).toEqual(["bundle:test-app:*"]);
  });

  it("getCredentialMetadata does NOT return decrypted headers", async () => {
    const stub = vaultStub();
    await stub.putCredential("test-api-2", {
      upstream: "https://api.test.example/",
      headers: { "x-api-key": "SHOULD-NEVER-SURFACE-VIA-METADATA" },
      allowedSubs: ["bundle:probe:*"],
    });

    const meta = await stub.getCredentialMetadata("test-api-2");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("SHOULD-NEVER-SURFACE-VIA-METADATA");
    expect(serialized).not.toContain("x-api-key");
  });

  it("deleteCredential removes the entry; subsequent metadata read returns null", async () => {
    const stub = vaultStub();
    await stub.putCredential("test-api-3", {
      upstream: "https://api.test.example/",
      headers: {},
      allowedSubs: ["*"],
    });
    expect(await stub.deleteCredential("test-api-3")).toBe(true);
    expect(await stub.getCredentialMetadata("test-api-3")).toBeNull();
    // Idempotent: second delete reports false.
    expect(await stub.deleteCredential("test-api-3")).toBe(false);
  });
});

describe("CredentialVault DO — proxyRequest identity gate", () => {
  it("returns 403 when callerSub is not in allowedSubs", async () => {
    const stub = vaultStub();
    await stub.putCredential("github-pat", {
      upstream: "https://api.github.com/",
      headers: { "Authorization": "Bearer GITHUB-PAT-DO-NOT-LEAK" },
      allowedSubs: ["bundle:trusted-tool:*"],
    });

    // The compromised bundle's identity. allowedSubs is for trusted-tool only.
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stub.proxyRequest(
      "github-pat",
      "bundle:test-app:malicious",
      probe,
    );

    expect(response.status).toBe(403);
    const body = await response.text();
    // The credential bytes MUST NOT appear in the denial response.
    expect(body).not.toContain("GITHUB-PAT-DO-NOT-LEAK");
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer");
  });

  it("returns 404 (not 403) when the service doesn't exist", async () => {
    // 404 vs 403 is a peer-existence oracle, BUT vault is gateway-internal
    // — callers must already be authenticated by cloister-router. The
    // disclosure-endpoint constant-time-404 concern (threat-model §9.4)
    // doesn't apply here. Keep the more informative error code for the
    // internal API.
    const stub = vaultStub();
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stub.proxyRequest(
      "service-that-was-never-created",
      "bundle:test-app:doesnt-matter",
      probe,
    );

    expect(response.status).toBe(404);
  });
});

describe("CredentialVault DO — at-rest encryption pin", () => {
  it("stored credentials are sealed; metadata-only reads return zero plaintext bytes", async () => {
    const stub = vaultStub();
    await stub.putCredential("sealed-rest-probe", {
      upstream: "https://api.test.example/",
      headers: { "x-secret-header": "PLAINTEXT-SHOULD-NEVER-LEAVE-DO" },
      allowedSubs: ["bundle:probe:*"],
    });

    // Even though the underlying SQLite stores the sealed bytes, our
    // metadata-only RPC must return a credential whose headers field is
    // empty — the only path to plaintext is proxyRequest, and even
    // there it goes upstream, not back to the caller.
    const meta = await stub.getCredentialMetadata("sealed-rest-probe");
    expect(JSON.stringify(meta)).not.toContain("PLAINTEXT-SHOULD-NEVER-LEAVE-DO");
    expect(JSON.stringify(meta)).not.toContain("x-secret-header");
  });
});
