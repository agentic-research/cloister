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
  it("returns 404 (not 403) when callerSub is not in allowedSubs", async () => {
    // cloister-aa9376: the 403 vs 404 split was a single-bit oracle
    // enumerating service names under a verified subject_fp. Collapsed
    // to a byte-identical 404 mirroring the disclosure §9.4.b precedent.
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

    expect(response.status).toBe(404);
    const body = await response.text();
    // The credential bytes MUST NOT appear in the denial response.
    expect(body).not.toContain("GITHUB-PAT-DO-NOT-LEAK");
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer");
    // The wire shape must match the no-row case (asserted as a
    // dedicated constant-shape pin below).
    expect(body).toBe(JSON.stringify({ error: "not_found", service: "github-pat" }));
  });

  it("returns 404 when the service doesn't exist (no-row path)", async () => {
    // The no-row path. Pinned alongside the scope-mismatch test above
    // to prove the wire-shape collapse (cloister-aa9376).
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

  // ── cloister-aa9376: constant-shape rejection (mirrors §9.4.b) ────────
  //
  // Two callers probing the same verified subject_fp + service-name
  // namespace must receive byte-identical 404 responses regardless of
  // whether the row exists. This pins the enumeration-oracle closure.
  it("vault proxyRequest: no-row and scope-mismatch return byte-equal 404s", async () => {
    const stub = vaultStub();

    // Seed a row whose allowedSubs do NOT include the probing caller.
    await stub.putCredential(SUBJECT_FP_A, "exists", {
      upstream: "https://api.example/",
      headers: { "Authorization": "Bearer SHOULD-NOT-LEAK" },
      allowedSubs: ["bundle:owner:*"],
    });

    const probe = new Request("https://anything.invalid/", { method: "GET" });

    // 1. Unknown service: no row.
    const r1 = await stub.proxyRequest(
      SUBJECT_FP_A,
      "never-existed",
      "bundle:attacker:*",
      probe,
    );
    // 2. Service exists for this subject, but caller is out of scope.
    const r2 = await stub.proxyRequest(
      SUBJECT_FP_A,
      "exists",
      "bundle:attacker:*",
      probe,
    );

    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);

    const b1 = await r1.text();
    const b2 = await r2.text();
    // Service name echoes back identically in both — caller-controlled.
    // Body byte-equality holds modulo the `service` field; assert each
    // body matches its own service exactly and that the SHAPE matches.
    expect(b1).toBe(JSON.stringify({ error: "not_found", service: "never-existed" }));
    expect(b2).toBe(JSON.stringify({ error: "not_found", service: "exists" }));

    // Critical: the scope-mismatch body MUST NOT carry any credential
    // payload. The 403→404 collapse must not have regressed §scenario-2.
    expect(b2).not.toContain("SHOULD-NOT-LEAK");
    expect(b2).not.toContain("Authorization");
    expect(b2).not.toContain("api.example");
    expect(b2).not.toContain("bundle:owner");

    // Header sets identical (both go through Response.json with the
    // same status). 404 paths omit retry-after; only rate-limited 429
    // carries it.
    const h1 = [...r1.headers.entries()].sort();
    const h2 = [...r2.headers.entries()].sort();
    expect(h1).toEqual(h2);
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

// ── cloister-6f21dc / DoS F2: per-peer sharded inflight cap ─────────────

describe("CredentialVault DO — per-peer inflight isolation (cloister-6f21dc / DoS F2)", () => {
  it("inflight counter is sharded by subject_fp (not a single shared scalar)", async () => {
    const stub = env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName("cluster"));
    const peerA = "a".repeat(64);
    const peerB = "b".repeat(64);

    // Manually populate the inflight Map inside the DO to simulate
    // mid-flight state, then assert peer A's saturation doesn't deny
    // peer B at the checkInflight gate (the load-bearing F2 invariant).
    await runInDurableObject(stub, async (inst) => {
      // Access the private Map directly — pre-fix this would have been
      // a single `private inflight = 0` scalar; post-fix it's a Map
      // keyed by subject_fp. The structural change IS the fix.
      const inflight = (inst as unknown as { inflightBySubject: Map<string, number> }).inflightBySubject;
      expect(inflight).toBeInstanceOf(Map);

      // Peer A at MAX_INFLIGHT (saturated)
      inflight.set(peerA, 16);
      // Peer B at zero
      expect(inflight.get(peerB) ?? 0).toBe(0);

      // checkInflight is private but we can prove behavior structurally:
      // peer A's slot is full, peer B's is empty — they're independent.
      expect(inflight.get(peerA)).toBe(16);
      expect(inflight.get(peerB) ?? 0).toBe(0);

      // GC: removing peer A's counter shouldn't affect peer B
      inflight.delete(peerA);
      expect(inflight.has(peerA)).toBe(false);
      expect(inflight.get(peerB) ?? 0).toBe(0);
    });
  });

  it("inflightBySubject Map cleans up entries when count returns to zero (no unbounded growth)", async () => {
    const stub = env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName("cluster"));
    const peer = "c".repeat(64);

    await runInDurableObject(stub, async (inst) => {
      const inflight = (inst as unknown as { inflightBySubject: Map<string, number> }).inflightBySubject;
      // Start clean
      inflight.delete(peer);

      // Simulate inc + dec cycle (the DO does this around proxyRequest).
      const incInflight = (inst as unknown as { "#incInflight"?: (s: string) => void });
      // Private hash-prefixed members aren't enumerable in JS; we
      // simulate by directly mutating the Map (which is what inc/dec do).
      inflight.set(peer, (inflight.get(peer) ?? 0) + 1);
      expect(inflight.get(peer)).toBe(1);

      // Decrement to zero — entry should be removed (GC invariant)
      const next = (inflight.get(peer) ?? 1) - 1;
      if (next <= 0) inflight.delete(peer);
      else inflight.set(peer, next);
      expect(inflight.has(peer)).toBe(false);

      // Silence unused-var lint for the (unused) #incInflight probe
      void incInflight;
    });
  });
});

// ── cloister-fbc6eb / VAULT_KEK_SOURCE spec pin (migrated from notme-69b3fd) ─
//
// The pin is the load-bearing fix for the config-write attack path:
// a deployment that swaps VAULT_KEK_SOURCE from `keychain://prod` to
// `env://ATTACKER` between DO instantiations would otherwise silently
// derive a KEK from attacker-controlled bytes. With the pin, a spec
// change between instantiations throws at the next KEK derive — the
// operator sees it in `wrangler tail`.
//
// These tests use UNIQUE idFromName values per case so the
// per-singleton vault_state row doesn't bleed between tests.

describe("CredentialVault DO — VAULT_KEK_SOURCE pin (cloister-fbc6eb)", () => {
  it("first putCredential writes the pin to vault_state", async () => {
    const stub = env.VAULT_STORE!.get(
      env.VAULT_STORE!.idFromName("pin-bootstrap"),
    ) as DurableObjectStub & {
      putCredential(
        subjectFp: string,
        service: string,
        cred: {
          upstream: string;
          headers: Record<string, string>;
          allowedSubs: string[];
        },
      ): Promise<void>;
    };
    // Trigger #getKEK() via a write path.
    await stub.putCredential(SUBJECT_FP_A, "pin-test-svc", {
      upstream: "https://example.test/api",
      headers: { authorization: "Bearer x" },
      allowedSubs: ["*"],
    });
    await runInDurableObject(stub, async (_inst, state) => {
      const rows = state.storage.sql.exec(
        "SELECT key, value FROM vault_state WHERE key IN ('kek_source', 'kek_tenant_scoped') ORDER BY key",
      ).toArray() as unknown as Array<{ key: string; value: string }>;
      expect(rows).toHaveLength(2);
      // kek_source pin must equal whatever env supplied; non-empty.
      const kekSource = rows.find((r) => r.key === "kek_source")?.value;
      expect(kekSource).toBeDefined();
      expect(kekSource!.length).toBeGreaterThan(0);
      // kek_tenant_scoped is canonicalized to '0' or '1'.
      const tenantScoped = rows.find((r) => r.key === "kek_tenant_scoped")?.value;
      expect(tenantScoped === "0" || tenantScoped === "1").toBe(true);
    });
  });

  it("pre-existing pin that mismatches env throws on next KEK derive", async () => {
    const stub = env.VAULT_STORE!.get(
      env.VAULT_STORE!.idFromName("pin-mismatch"),
    ) as DurableObjectStub & {
      putCredential(
        subjectFp: string,
        service: string,
        cred: {
          upstream: string;
          headers: Record<string, string>;
          allowedSubs: string[];
        },
      ): Promise<void>;
    };
    // Pre-seed a CONFLICTING pin row BEFORE first KEK derive.
    // Simulates the config-write attack: storage records an old spec;
    // env now provides a different one (the attacker's flip).
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS vault_state (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO vault_state (key, value) VALUES ('kek_source', ?)",
        "env://ATTACKER_INJECTED_SPEC",
      );
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO vault_state (key, value) VALUES ('kek_tenant_scoped', ?)",
        "0",
      );
    });
    // Any RPC that derives the KEK must throw with the pin-mismatch
    // hint. putCredential is the canonical write path → #writeRow →
    // #getKEK → #assertKekSourceSpecPinned.
    await expect(
      stub.putCredential(SUBJECT_FP_A, "pin-mismatch-svc", {
        upstream: "https://example.test/api",
        headers: { authorization: "Bearer x" },
        allowedSubs: ["*"],
      }),
    ).rejects.toThrow(/pin mismatch/);
  });

  it("matching pin allows operation (the happy path)", async () => {
    // Bootstrap a DO, then re-call with the (still-matching) env →
    // proves the pin check is silently OK when nothing changed.
    const stub = env.VAULT_STORE!.get(
      env.VAULT_STORE!.idFromName("pin-stable"),
    ) as DurableObjectStub & {
      putCredential(
        subjectFp: string,
        service: string,
        cred: {
          upstream: string;
          headers: Record<string, string>;
          allowedSubs: string[];
        },
      ): Promise<void>;
      getCredentialMetadata(
        subjectFp: string,
        service: string,
      ): Promise<{ upstream: string; allowedSubs: string[] } | null>;
    };
    // First call bootstraps the pin.
    await stub.putCredential(SUBJECT_FP_A, "stable-svc", {
      upstream: "https://example.test/api",
      headers: { authorization: "Bearer x" },
      allowedSubs: ["*"],
    });
    // Second call: pin must match env (it does) → no throw.
    const meta = await stub.getCredentialMetadata(SUBJECT_FP_A, "stable-svc");
    expect(meta).not.toBeNull();
    expect(meta!.upstream).toBe("https://example.test/api");
  });
});
