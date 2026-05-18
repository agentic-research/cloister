/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// multi-tenant-isolation.test.ts — vault cross-bundle isolation invariants
// (cloister-26546a).
//
// Two layers of isolation. This test exercises both.
//
//   1. Binding layer (which DO instance, manifest-enforced):
//      ADR-0013 says each bundle gets a distinct vault DO via its
//      `idFromName(...)` namespace. With workerd's API, "distinct DO ID"
//      means `idFromName("A") !== idFromName("B")` and the two stubs
//      reach independent SQLite-backed storage. This is the primary
//      gate.
//
//   2. SQL row layer (which row, subject_fp-enforced):
//      The vault DO's composite-PK schema namespaces credentials by
//      the caller's verified cert fingerprint. Even if two callers
//      share a binding (a manifest mistake), they cannot read or
//      overwrite each other's rows. This is defense-in-depth.
//
// The test does NOT enforce a manifest-side ban on shared bindings —
// that's a question for the future (a lint over `cluster.capnp` once
// real `workerd`-tier bundles appear; tracked separately). The
// invariant we CAN assert today is the runtime property: distinct
// idFromName() values yield distinct row-spaces, and within a shared
// idFromName() the subject_fp filter holds.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Two subject fingerprints — what `VerifiedLease.peerFp` looks like
// for two different bundles. Used to drive the SQL-layer invariant.
const SUBJECT_FP_BUNDLE_A =
  "1111111111111111111111111111111111111111111111111111111111111111";
const SUBJECT_FP_BUNDLE_B =
  "2222222222222222222222222222222222222222222222222222222222222222";

// Symbolic "bundle binding names" — in a real deployment these would
// be distinct env-var bindings declared in cluster.capnp. In this test
// we simulate the per-bundle DO namespace by using distinct
// `idFromName()` arguments. The IDs that result are what workerd
// would route to in the binding layer.
const BUNDLE_A_ID_NAME = "bundle-a-vault";
const BUNDLE_B_ID_NAME = "bundle-b-vault";

interface VaultStub extends DurableObjectStub {
  putCredential(subjectFp: string, service: string, cred: {
    upstream: string;
    headers: Record<string, string>;
    allowedSubs: string[];
  }): Promise<void>;
  getCredentialMetadata(subjectFp: string, service: string): Promise<{
    upstream: string;
    allowedSubs: string[];
  } | null>;
  listServices(subjectFp: string): Promise<string[]>;
  deleteCredential(subjectFp: string, service: string): Promise<boolean>;
  proxyRequest(
    subjectFp: string,
    service: string,
    callerSub: string,
    req: Request,
  ): Promise<Response>;
}

function stubForIdName(idName: string): VaultStub {
  const ns = env.VAULT_STORE!;
  return ns.get(ns.idFromName(idName)) as VaultStub;
}

// ── Binding layer: distinct DO IDs per bundle ────────────────────────────
//
// The load-bearing claim ADR-0013 makes is that the binding mediates
// cross-bundle isolation. `idFromName(...)` is the mechanism. Two
// bundles given different binding names resolve to different DOs;
// state in one is unreachable from the other.

describe("vault binding layer — distinct DO IDs per bundle", () => {
  it("idFromName(A) and idFromName(B) produce distinct IDs", () => {
    const ns = env.VAULT_STORE!;
    const idA = ns.idFromName(BUNDLE_A_ID_NAME);
    const idB = ns.idFromName(BUNDLE_B_ID_NAME);

    // DurableObjectId.equals exists in workerd; toString gives a
    // stable hex form we can compare directly.
    expect(idA.toString()).not.toEqual(idB.toString());
  });

  it("writes to bundle A's DO are invisible to bundle B's DO", async () => {
    const stubA = stubForIdName(BUNDLE_A_ID_NAME);
    const stubB = stubForIdName(BUNDLE_B_ID_NAME);

    // Bundle A writes under its OWN subject fingerprint.
    await stubA.putCredential(SUBJECT_FP_BUNDLE_A, "binding-layer-svc", {
      upstream: "https://a.example/",
      headers: { "x-key": "A-ONLY-CREDENTIAL" },
      allowedSubs: ["bundle:a:*"],
    });

    // Bundle B looks up the same service name, with its own subject_fp
    // AND with bundle A's subject_fp. Neither should find a row — the
    // write went to a different DO entirely.
    const missByOwnFp     = await stubB.getCredentialMetadata(SUBJECT_FP_BUNDLE_B, "binding-layer-svc");
    const missByForeignFp = await stubB.getCredentialMetadata(SUBJECT_FP_BUNDLE_A, "binding-layer-svc");

    expect(missByOwnFp).toBeNull();
    expect(missByForeignFp).toBeNull();
  });

  it("listServices on bundle B never surfaces bundle A's services", async () => {
    const stubA = stubForIdName(BUNDLE_A_ID_NAME);
    const stubB = stubForIdName(BUNDLE_B_ID_NAME);

    await stubA.putCredential(SUBJECT_FP_BUNDLE_A, "binding-list-only-on-a", {
      upstream: "https://a.example/",
      headers: {},
      allowedSubs: ["*"],
    });

    // Both subjects on bundle B's DO must come up empty for this service.
    const listOwnFp     = await stubB.listServices(SUBJECT_FP_BUNDLE_B);
    const listForeignFp = await stubB.listServices(SUBJECT_FP_BUNDLE_A);
    expect(listOwnFp).not.toContain("binding-list-only-on-a");
    expect(listForeignFp).not.toContain("binding-list-only-on-a");
  });

  it("proxyRequest on bundle B for bundle A's service is a clean 404", async () => {
    const stubA = stubForIdName(BUNDLE_A_ID_NAME);
    const stubB = stubForIdName(BUNDLE_B_ID_NAME);

    await stubA.putCredential(SUBJECT_FP_BUNDLE_A, "binding-proxy-target", {
      upstream: "https://a.example/",
      headers: { "Authorization": "Bearer A-BINDING-PRIVATE-PAT" },
      allowedSubs: ["bundle:a:*"],
    });

    // Bundle B tries to proxy through to A's service. Even with the
    // "correct" subject_fp (forged from somewhere) and "correct"
    // callerSub, the binding layer means there's no row in this DO.
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stubB.proxyRequest(
      SUBJECT_FP_BUNDLE_A,            // forged subject_fp
      "binding-proxy-target",
      "bundle:a:legitimate",          // satisfies A's allowedSubs grammar
      probe,
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("A-BINDING-PRIVATE-PAT");
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer");
  });
});

// ── SQL row layer: subject_fp filter inside a shared DO ──────────────────
//
// The defense-in-depth scenario: imagine a manifest mistake places
// bundle A and bundle B both on the same vault DO ID. The binding
// layer no longer separates them. The composite PK is the next line
// of defense.
//
// We simulate the "shared binding" by giving both bundles a stub
// against the SAME idFromName(). The SQL filter must still isolate
// them by subject_fp.

describe("vault SQL row layer — subject_fp filter inside a shared DO", () => {
  // Both bundles "wired" to the same DO ID — what a manifest mistake
  // would look like.
  const SHARED_ID_NAME = "shared-binding-mistake-26546a";

  it("two subjects can write the same service name without colliding", async () => {
    const stub = stubForIdName(SHARED_ID_NAME);

    await stub.putCredential(SUBJECT_FP_BUNDLE_A, "shared-svc", {
      upstream: "https://a.example/",
      headers: { "x-key": "A-SECRET-VALUE" },
      allowedSubs: ["bundle:a:*"],
    });
    await stub.putCredential(SUBJECT_FP_BUNDLE_B, "shared-svc", {
      upstream: "https://b.example/",
      headers: { "x-key": "B-SECRET-VALUE" },
      allowedSubs: ["bundle:b:*"],
    });

    const metaA = await stub.getCredentialMetadata(SUBJECT_FP_BUNDLE_A, "shared-svc");
    const metaB = await stub.getCredentialMetadata(SUBJECT_FP_BUNDLE_B, "shared-svc");

    expect(metaA?.upstream).toBe("https://a.example/");
    expect(metaB?.upstream).toBe("https://b.example/");
    expect(metaA?.allowedSubs).toEqual(["bundle:a:*"]);
    expect(metaB?.allowedSubs).toEqual(["bundle:b:*"]);
  });

  it("bundle A's putCredential cannot reach into bundle B's row", async () => {
    const stub = stubForIdName(SHARED_ID_NAME);

    // Bundle B sets a row first.
    await stub.putCredential(SUBJECT_FP_BUNDLE_B, "clobber-svc", {
      upstream: "https://b-original.example/",
      headers: { "x-key": "B-ORIGINAL" },
      allowedSubs: ["bundle:b:*"],
    });

    // Bundle A writes the same service name — the composite PK takes
    // (A, "clobber-svc") which is a different row from (B, "clobber-svc").
    await stub.putCredential(SUBJECT_FP_BUNDLE_A, "clobber-svc", {
      upstream: "https://a-attacker.example/",
      headers: { "x-key": "A-OVERRIDE" },
      allowedSubs: ["bundle:a:*"],
    });

    // Bundle B's row is preserved.
    const metaB = await stub.getCredentialMetadata(SUBJECT_FP_BUNDLE_B, "clobber-svc");
    expect(metaB?.upstream).toBe("https://b-original.example/");
    expect(metaB?.allowedSubs).toEqual(["bundle:b:*"]);
  });

  it("bundle A's proxyRequest cannot reach bundle B's credential by service name alone", async () => {
    const stub = stubForIdName(SHARED_ID_NAME);

    await stub.putCredential(SUBJECT_FP_BUNDLE_B, "proxy-shared-svc", {
      upstream: "https://b.example/",
      headers: { "Authorization": "Bearer B-SQL-LAYER-PRIVATE-PAT" },
      allowedSubs: ["bundle:b:*"],
    });

    // Bundle A's proxyRequest at the same service name — the (A,
    // "proxy-shared-svc") row doesn't exist; clean 404 with no
    // credential leak.
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stub.proxyRequest(
      SUBJECT_FP_BUNDLE_A,
      "proxy-shared-svc",
      "bundle:b:legitimate",
      probe,
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("B-SQL-LAYER-PRIVATE-PAT");
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer");
  });

  it("listServices is per-subject inside a shared DO", async () => {
    const stub = stubForIdName(SHARED_ID_NAME);

    await stub.putCredential(SUBJECT_FP_BUNDLE_A, "list-a-only", {
      upstream: "https://a.example/",
      headers: {},
      allowedSubs: ["*"],
    });
    await stub.putCredential(SUBJECT_FP_BUNDLE_B, "list-b-only", {
      upstream: "https://b.example/",
      headers: {},
      allowedSubs: ["*"],
    });

    const listA = await stub.listServices(SUBJECT_FP_BUNDLE_A);
    const listB = await stub.listServices(SUBJECT_FP_BUNDLE_B);

    expect(listA).toContain("list-a-only");
    expect(listA).not.toContain("list-b-only");
    expect(listB).toContain("list-b-only");
    expect(listB).not.toContain("list-a-only");
  });
});

// ── Composite scenario: binding-layer wrong AND attacker forges subject_fp ─
//
// The most pessimistic attacker: the manifest is wrong (same binding
// shared between two bundles) AND the attacker controls the
// subject_fp they pass (e.g. they somehow learn bundle B's
// fingerprint). Even then the credential bytes never leak through
// the proxy denial response — that's preserved by the existing
// allowedSubs gate + the buildErrorResponse contract (the cred param
// is deliberately ignored).
//
// This composite scenario isn't fully defended at the SQL row layer —
// if the attacker truly has bundle B's fingerprint, the row lookup
// succeeds. The remaining gates are: vault's allowedSubs glob match
// (does the caller's identity satisfy the credential's grant?), and
// the buildErrorResponse contract (no plaintext in error bodies).
// Both are exercised in test/security/prompt-injection.test.ts and
// vault/src/__tests__/vault-adversarial.test.ts.

describe("vault composite — subject_fp forge + manifest mistake", () => {
  it("if the attacker also forges subject_fp but fails allowedSubs glob, no plaintext leaks", async () => {
    const stub = stubForIdName("composite-failure-26546a");

    await stub.putCredential(SUBJECT_FP_BUNDLE_B, "composite-target", {
      upstream: "https://b.example/",
      headers: { "Authorization": "Bearer COMPOSITE-MUST-NEVER-LEAK" },
      allowedSubs: ["bundle:b:*"],
    });

    // Forge subject_fp = B's. Row lookup succeeds. callerSub claims
    // to be A's bundle. allowedSubs gate fires. Post-cloister-aa9376
    // the gate emits a byte-identical 404 (not 403) to deny the
    // enumeration oracle — the no-payload-leak invariant survives the
    // shape collapse.
    const probe = new Request("https://anything.invalid/", { method: "GET" });
    const response = await stub.proxyRequest(
      SUBJECT_FP_BUNDLE_B,             // forged
      "composite-target",
      "bundle:a:malicious-payload",    // fails B's allowedSubs
      probe,
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("COMPOSITE-MUST-NEVER-LEAK");
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer");
  });
});
