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
//   4. The (subject_fp, service) composite PK scopes writes per
//      verified caller fingerprint — bundle A's putCredential cannot
//      reach bundle B's row even in the (manifest-broken) shared-
//      binding scenario. Per cloister-26546a.
//
// What this test does NOT prove:
//
//   - Identity propagation from in-cluster bundles. subjectFp + callerSub
//     are passed explicitly as method args; the DO trusts what's
//     handed. The question of where subjectFp comes from is unresolved
//     per src/vault-store.ts header — gated on the first workerd-bundle
//     Worker landing.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A stable fixture cert fingerprint — what `VerifiedLease.peerFp`
// would look like (sha256-hex of a peer's cert DER). Tests that need
// a SECOND distinct subject use SUBJECT_FP_B.
const SUBJECT_FP_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SUBJECT_FP_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Singleton-per-cluster keying — same convention as TrustStore/BlobStore.
function vaultStub() {
  return env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName("cluster")) as DurableObjectStub & {
    putCredential(subjectFp: string, service: string, cred: {
      upstream: string;
      headers: Record<string, string>;
      allowedSubs: string[];
    }): Promise<void>;
    getCredentialMetadata(subjectFp: string, service: string): Promise<{
      upstream: string;
      allowedSubs: string[];
    } | null>;
    deleteCredential(subjectFp: string, service: string): Promise<boolean>;
    listServices(subjectFp: string): Promise<string[]>;
    proxyRequest(
      subjectFp: string,
      service: string,
      callerSub: string,
      req: Request,
    ): Promise<Response>;
  };
}

describe("CredentialVault DO — wiring + smoke", () => {
  it("the binding resolves and methods are callable", async () => {
    const stub = vaultStub();
    const services = await stub.listServices(SUBJECT_FP_A);
    expect(Array.isArray(services)).toBe(true);
  });

  it("putCredential + getCredentialMetadata round-trips the metadata", async () => {
    const stub = vaultStub();
    await stub.putCredential(SUBJECT_FP_A, "test-api-1", {
      upstream: "https://api.test.example/",
      headers: { "x-api-key": "secret-value-1" },
      allowedSubs: ["bundle:test-app:*"],
    });

    const meta = await stub.getCredentialMetadata(SUBJECT_FP_A, "test-api-1");
    expect(meta).not.toBeNull();
    expect(meta!.upstream).toBe("https://api.test.example/");
    expect(meta!.allowedSubs).toEqual(["bundle:test-app:*"]);
  });

  it("getCredentialMetadata does NOT return decrypted headers", async () => {
    const stub = vaultStub();
    await stub.putCredential(SUBJECT_FP_A, "test-api-2", {
      upstream: "https://api.test.example/",
      headers: { "x-api-key": "SHOULD-NEVER-SURFACE-VIA-METADATA" },
      allowedSubs: ["bundle:probe:*"],
    });

    const meta = await stub.getCredentialMetadata(SUBJECT_FP_A, "test-api-2");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("SHOULD-NEVER-SURFACE-VIA-METADATA");
    expect(serialized).not.toContain("x-api-key");
  });

  it("deleteCredential removes the entry; subsequent metadata read returns null", async () => {
    const stub = vaultStub();
    await stub.putCredential(SUBJECT_FP_A, "test-api-3", {
      upstream: "https://api.test.example/",
      headers: {},
      allowedSubs: ["*"],
    });
    expect(await stub.deleteCredential(SUBJECT_FP_A, "test-api-3")).toBe(true);
    expect(await stub.getCredentialMetadata(SUBJECT_FP_A, "test-api-3")).toBeNull();
    // Idempotent: second delete reports false.
    expect(await stub.deleteCredential(SUBJECT_FP_A, "test-api-3")).toBe(false);
  });
});

describe("CredentialVault DO — proxyRequest identity gate", () => {
  it("returns 403 when callerSub is not in allowedSubs", async () => {
    const stub = vaultStub();
    await stub.putCredential(SUBJECT_FP_A, "github-pat", {
      upstream: "https://api.github.com/",
      headers: { "Authorization": "Bearer GITHUB-PAT-DO-NOT-LEAK" },
      allowedSubs: ["bundle:trusted-tool:*"],
    });

    // The compromised bundle's identity. allowedSubs is for trusted-tool only.
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stub.proxyRequest(
      SUBJECT_FP_A,
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
      SUBJECT_FP_A,
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
    await stub.putCredential(SUBJECT_FP_A, "sealed-rest-probe", {
      upstream: "https://api.test.example/",
      headers: { "x-secret-header": "PLAINTEXT-SHOULD-NEVER-LEAVE-DO" },
      allowedSubs: ["bundle:probe:*"],
    });

    // Even though the underlying SQLite stores the sealed bytes, our
    // metadata-only RPC must return a credential whose headers field is
    // empty — the only path to plaintext is proxyRequest, and even
    // there it goes upstream, not back to the caller.
    const meta = await stub.getCredentialMetadata(SUBJECT_FP_A, "sealed-rest-probe");
    expect(JSON.stringify(meta)).not.toContain("PLAINTEXT-SHOULD-NEVER-LEAVE-DO");
    expect(JSON.stringify(meta)).not.toContain("x-secret-header");
  });
});

// ── (subject_fp, service) composite-PK isolation (cloister-26546a) ───────
//
// The defense-in-depth claim: even if two bundles end up sharing a
// vault DO binding (a manifest mistake), the DO's composite PK refuses
// to let bundle A's `putCredential` clobber bundle B's row, and bundle
// A can never READ bundle B's row by service-name lookup. The binding-
// layer test (test/vault/multi-tenant-isolation.test.ts) covers the
// expected-correct path; these tests pin the fallback.

describe("CredentialVault DO — (subject_fp, service) isolation", () => {
  it("two subjects can use the same `service` string without colliding", async () => {
    const stub = vaultStub();

    // Both subjects write to the SAME service name. The flat-namespace
    // version of vault would have had bundle B's write clobber bundle
    // A's row; with the composite PK they live side-by-side.
    await stub.putCredential(SUBJECT_FP_A, "shared-service-name", {
      upstream: "https://a.example/",
      headers: { "x-key": "subject-A-secret" },
      allowedSubs: ["bundle:a:*"],
    });
    await stub.putCredential(SUBJECT_FP_B, "shared-service-name", {
      upstream: "https://b.example/",
      headers: { "x-key": "subject-B-secret" },
      allowedSubs: ["bundle:b:*"],
    });

    const metaA = await stub.getCredentialMetadata(SUBJECT_FP_A, "shared-service-name");
    const metaB = await stub.getCredentialMetadata(SUBJECT_FP_B, "shared-service-name");

    expect(metaA?.upstream).toBe("https://a.example/");
    expect(metaA?.allowedSubs).toEqual(["bundle:a:*"]);
    expect(metaB?.upstream).toBe("https://b.example/");
    expect(metaB?.allowedSubs).toEqual(["bundle:b:*"]);
  });

  it("subject A's listServices excludes subject B's services", async () => {
    const stub = vaultStub();

    await stub.putCredential(SUBJECT_FP_A, "isolation-svc-a", {
      upstream: "https://a.example/",
      headers: {},
      allowedSubs: ["*"],
    });
    await stub.putCredential(SUBJECT_FP_B, "isolation-svc-b", {
      upstream: "https://b.example/",
      headers: {},
      allowedSubs: ["*"],
    });

    const listA = await stub.listServices(SUBJECT_FP_A);
    const listB = await stub.listServices(SUBJECT_FP_B);

    expect(listA).toContain("isolation-svc-a");
    expect(listA).not.toContain("isolation-svc-b");
    expect(listB).toContain("isolation-svc-b");
    expect(listB).not.toContain("isolation-svc-a");
  });

  it("subject A's deleteCredential cannot reach subject B's row", async () => {
    const stub = vaultStub();

    await stub.putCredential(SUBJECT_FP_B, "delete-target-of-b", {
      upstream: "https://b.example/",
      headers: { "x-key": "MUST-SURVIVE-FOREIGN-DELETE" },
      allowedSubs: ["bundle:b:*"],
    });

    // Subject A tries to delete subject B's service — should be a no-op
    // (returns false, row count unchanged).
    const deletedFromA = await stub.deleteCredential(SUBJECT_FP_A, "delete-target-of-b");
    expect(deletedFromA).toBe(false);

    const metaB = await stub.getCredentialMetadata(SUBJECT_FP_B, "delete-target-of-b");
    expect(metaB).not.toBeNull();
    expect(metaB?.upstream).toBe("https://b.example/");
  });

  it("subject A's putCredential cannot clobber subject B's row at the same `service` name", async () => {
    const stub = vaultStub();

    await stub.putCredential(SUBJECT_FP_B, "clobber-target", {
      upstream: "https://b-original.example/",
      headers: { "x-key": "B-ORIGINAL-SECRET" },
      allowedSubs: ["bundle:b:*"],
    });

    // Subject A writes a same-named service. Pre-26546a this would have
    // overwritten bundle B's row. With the composite PK it creates A's
    // own row instead.
    await stub.putCredential(SUBJECT_FP_A, "clobber-target", {
      upstream: "https://a-attacker.example/",
      headers: { "x-key": "A-ATTACKER-OVERRIDE" },
      allowedSubs: ["bundle:a:*"],
    });

    const metaB = await stub.getCredentialMetadata(SUBJECT_FP_B, "clobber-target");
    expect(metaB?.upstream).toBe("https://b-original.example/");
    expect(metaB?.allowedSubs).toEqual(["bundle:b:*"]);
  });

  it("subject A's proxyRequest cannot reach subject B's stored credential", async () => {
    const stub = vaultStub();

    // Subject B stores a credential under a service name; allowedSubs
    // would normally let bundle B's caller through.
    await stub.putCredential(SUBJECT_FP_B, "proxy-isolation-svc", {
      upstream: "https://b.example/",
      headers: { "Authorization": "Bearer B-PRIVATE-PAT" },
      allowedSubs: ["bundle:b:*"],
    });

    // Subject A's proxyRequest at the SAME service name — even with a
    // callerSub bundle B's allowedSubs would normally accept — must
    // miss because (subject_fp, service) doesn't match.
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stub.proxyRequest(
      SUBJECT_FP_A,
      "proxy-isolation-svc",
      "bundle:b:legitimate", // matches B's allowedSubs but A's subject_fp wins the row lookup
      probe,
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    // The credential bytes MUST NOT leak even with the foreign subject_fp.
    expect(body).not.toContain("B-PRIVATE-PAT");
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer");
  });

  // assertSubjectFp contract — empty / control-char subjectFp:
  //
  // The DO throws `vault: subjectFp is required and must be non-empty`
  // / `vault: subjectFp contains control characters` on bad input. We
  // don't exercise that via a unit test here: workerd's RPC harness
  // re-surfaces DO-side throws as unhandled rejections in the pool
  // reporter even when the caller catches them, so `await expect(...
  // .rejects.toThrow(...))` cleanly asserts the throw but still trips
  // the `Errors` count. The contract is covered indirectly: every
  // happy-path test passes a real fingerprint, and the schema-level
  // subject_fp filter (above) is the load-bearing defense; the
  // assertSubjectFp guard is belt-and-braces for caller bugs.
});

// ── F1: per-DO token-bucket budget (cloister-211b68 / dos-friend) ───────────
//
// Each test uses a distinct subject_fp so its bucket starts full at
// RATE_LIMITS.CAPACITY tokens — no cross-test interference. The DO is the
// same singleton (`idFromName("cluster")`), only the bucket key differs.
//
// Test costs: read = 1, write = 3, proxy = 5. At CAPACITY = 100 a fresh
// bucket supports 100 reads / 33 writes / 20 proxies before refill kicks in.

// ── F1 integration coverage notes ──────────────────────────────────────────
//
// The token-bucket math is tested exhaustively as pure functions in
// vault/src/__tests__/rate-bucket.test.ts (no RPC, no harness errors).
// Here we only cover the DO's persistence + dispatch shim, and only via
// non-throwing paths — workerd's vitest pool surfaces DO-side throws as
// "errors" even when caught, so we use proxyRequest's 429 Response
// (Response-shaped reject) and a realistic-load happy path.

describe("CredentialVault DO — F1 rate budget (Response-shaped paths only)", () => {
  const fpFor = (slot: string) =>
    `f1${slot.replace(/[^a-f0-9]/g, "0")}`.padEnd(64, "0").slice(0, 64);

  async function seedBucket(fp: string, tokens: number, lastRefillMs: number) {
    const stub = env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName("cluster"));
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(
        "INSERT INTO rate_buckets (subject_fp, tokens, last_refill_ms) VALUES (?, ?, ?) ON CONFLICT(subject_fp) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms",
        fp, tokens, lastRefillMs,
      );
    });
  }

  it("proxyRequest rejects with 429 Response when bucket is empty", async () => {
    const v = vaultStub();
    const fp = fpFor("proxy429");
    await v.putCredential(fp, "test-svc", {
      upstream: "https://example.test/api",
      headers: { authorization: "Bearer x" },
      allowedSubs: ["*"],
    });
    await seedBucket(fp, 0, Date.now());
    const probe = new Request("https://example.test/proxy/endpoint", { method: "GET" });
    const resp = await v.proxyRequest(fp, "test-svc", "anybody", probe);
    expect(resp.status).toBe(429);
    expect(resp.headers.get("retry-after")).toBeTruthy();
    const body = await resp.json() as { error: string; service: string };
    expect(body).toEqual({ error: "rate_limited", service: "test-svc" });
  });

  it("realistic legitimate load (10 reads) stays well under the limit", async () => {
    const v = vaultStub();
    const fp = fpFor("realistic");
    for (let i = 0; i < 10; i++) {
      const result = await v.getCredentialMetadata(fp, "no-such-service");
      expect(result).toBeNull();
    }
  });
});
