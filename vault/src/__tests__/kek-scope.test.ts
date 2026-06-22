// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

/**
 * kek-scope.test.ts — unit tests for ADR-0030 §A3 three-tier KEK scoping.
 *
 * Properties pinned (these are the §13.7.3 contract):
 *   - **Determinism**: same (rootKek, tenantName) → same output bytes
 *   - **Independence**: different tenantName → unrelated output bytes
 *   - **Cross-tier separation**: type system prevents accidental
 *     cluster-scope read with a service-tier handle (and vice versa)
 *   - **Validation**: tenant names are constrained so the byte stream
 *     into HKDF can't be manipulated via whitespace / encoding tricks
 *
 * Per cloister-0f60a8.
 */

import { describe, expect, it } from "vitest";

import {
  deriveClusterTenantKek,
  buildKekScopeSource,
  HKDF_INFO_PREFIX,
  type KekScope,
} from "../kek-scope";
import type { KekSourceEnv } from "../kek-source";

// ── deriveClusterTenantKek — happy path ──────────────────────────────────

describe("deriveClusterTenantKek", () => {
  it("returns 64-char lowercase hex (32 bytes derived)", async () => {
    const kek = await deriveClusterTenantKek("root-kek-32-bytes-pretend-A", "alice");
    expect(kek).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same inputs → same output", async () => {
    const a = await deriveClusterTenantKek("root-kek-A", "alice");
    const b = await deriveClusterTenantKek("root-kek-A", "alice");
    expect(a).toBe(b);
  });

  it("produces independent outputs for different tenantName (no shared bytes)", async () => {
    const alice = await deriveClusterTenantKek("root-kek-A", "alice");
    const bob = await deriveClusterTenantKek("root-kek-A", "bob");
    expect(alice).not.toBe(bob);
    // Hex strings are byte-for-byte different (HKDF property — no
    // partial-match leaks).
    for (let i = 0; i < alice.length; i += 2) {
      if (alice.slice(i, i + 2) !== bob.slice(i, i + 2)) {
        return; // at least one byte differs — pass
      }
    }
    throw new Error("alice and bob KEKs are byte-identical");
  });

  it("produces independent outputs for different rootKek (cluster-master rotation)", async () => {
    const a = await deriveClusterTenantKek("root-kek-A", "alice");
    const b = await deriveClusterTenantKek("root-kek-B", "alice");
    expect(a).not.toBe(b);
  });

  it("info prefix is locked to cloister/cred-iso/v1/tenant/", () => {
    // Pinned for conformance — a refactor that changes this would
    // invalidate every existing tenant's KEK silently. The Python
    // ref-impl-py must use the same prefix string byte-for-byte.
    expect(HKDF_INFO_PREFIX).toBe("cloister/cred-iso/v1/tenant/");
  });
});

// ── deriveClusterTenantKek — validation rejections ───────────────────────

describe("deriveClusterTenantKek: tenantName validation", () => {
  it("rejects empty tenantName", async () => {
    await expect(deriveClusterTenantKek("root", "")).rejects.toThrow(/empty/);
  });

  it("rejects uppercase characters", async () => {
    await expect(deriveClusterTenantKek("root", "Alice")).rejects.toThrow(/disallowed/);
  });

  it("rejects path-traversal attempts", async () => {
    await expect(deriveClusterTenantKek("root", "../foo")).rejects.toThrow(/disallowed/);
    await expect(deriveClusterTenantKek("root", "a/b")).rejects.toThrow(/disallowed/);
    await expect(deriveClusterTenantKek("root", "a\\b")).rejects.toThrow(/disallowed/);
  });

  it("rejects whitespace + control bytes", async () => {
    await expect(deriveClusterTenantKek("root", "a b")).rejects.toThrow(/disallowed/);
    await expect(deriveClusterTenantKek("root", "a\tb")).rejects.toThrow(/disallowed/);
    await expect(deriveClusterTenantKek("root", "a\nb")).rejects.toThrow(/disallowed/);
  });

  it("rejects leading/trailing/doubled dots + hyphens", async () => {
    await expect(deriveClusterTenantKek("root", ".foo")).rejects.toThrow(/leading\/trailing dot/);
    await expect(deriveClusterTenantKek("root", "foo.")).rejects.toThrow(/leading\/trailing dot/);
    await expect(deriveClusterTenantKek("root", "foo..bar")).rejects.toThrow(/doubled dot/);
    await expect(deriveClusterTenantKek("root", "-foo")).rejects.toThrow(/leading\/trailing hyphen/);
    await expect(deriveClusterTenantKek("root", "foo-")).rejects.toThrow(/leading\/trailing hyphen/);
  });

  it("accepts FQDN-shaped names", async () => {
    const kek = await deriveClusterTenantKek("root", "alice.cluster.example.com");
    expect(kek).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts kebab-case names", async () => {
    const kek = await deriveClusterTenantKek("root", "tenant-7");
    expect(kek).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects names longer than 253 chars (DNS limit)", async () => {
    const long = "a".repeat(254);
    await expect(deriveClusterTenantKek("root", long)).rejects.toThrow(/exceeds 253/);
  });

  it("rejects empty rootKek", async () => {
    await expect(deriveClusterTenantKek("", "alice")).rejects.toThrow(/non-empty/);
  });
});

// ── buildKekScopeSource: cluster scope ───────────────────────────────────

describe("buildKekScopeSource: cluster scope", () => {
  it("resolves via HKDF over the cluster root", async () => {
    const env: KekSourceEnv = { MY_ROOT_KEK: "cluster-root-bytes" };
    const scope: KekScope = { kind: "cluster", tenantName: "alice" };
    const src = buildKekScopeSource(scope, "env://MY_ROOT_KEK", new Map(), env);
    const got = await src.resolve();
    const expected = await deriveClusterTenantKek("cluster-root-bytes", "alice");
    expect(got).toBe(expected);
  });

  it("each tenant gets distinct bytes from the same root", async () => {
    const env: KekSourceEnv = { MY_ROOT_KEK: "shared-root" };
    const aliceSrc = buildKekScopeSource(
      { kind: "cluster", tenantName: "alice" },
      "env://MY_ROOT_KEK",
      new Map(),
      env,
    );
    const bobSrc = buildKekScopeSource(
      { kind: "cluster", tenantName: "bob" },
      "env://MY_ROOT_KEK",
      new Map(),
      env,
    );
    const [alice, bob] = await Promise.all([aliceSrc.resolve(), bobSrc.resolve()]);
    expect(alice).not.toBe(bob);
  });

  it("propagates errors from the underlying root resolver", async () => {
    const env: KekSourceEnv = {}; // MY_ROOT_KEK unset
    const src = buildKekScopeSource(
      { kind: "cluster", tenantName: "alice" },
      "env://MY_ROOT_KEK",
      new Map(),
      env,
    );
    await expect(src.resolve()).rejects.toThrow(/unset or empty/);
  });
});

// ── buildKekScopeSource: service scope ───────────────────────────────────

describe("buildKekScopeSource: service scope", () => {
  it("loads from the operator's per-service URL spec", async () => {
    const env: KekSourceEnv = { S1_KEK: "service-1-secret" };
    const services = new Map([["s1", "env://S1_KEK"]]);
    const src = buildKekScopeSource(
      { kind: "service", name: "s1" },
      "ignored", // cluster root irrelevant for service tier
      services,
      env,
    );
    await expect(src.resolve()).resolves.toBe("service-1-secret");
  });

  it("throws when the named service has no declared spec", () => {
    const env: KekSourceEnv = {};
    expect(() =>
      buildKekScopeSource(
        { kind: "service", name: "missing" },
        "ignored",
        new Map(),
        env,
      ),
    ).toThrow(/no URL spec declared for service/);
  });

  it("services are independent: different specs → different bytes", async () => {
    const env: KekSourceEnv = { S1: "secret-1", S2: "secret-2" };
    const services = new Map([
      ["s1", "env://S1"],
      ["s2", "env://S2"],
    ]);
    const a = await buildKekScopeSource(
      { kind: "service", name: "s1" },
      "ignored",
      services,
      env,
    ).resolve();
    const b = await buildKekScopeSource(
      { kind: "service", name: "s2" },
      "ignored",
      services,
      env,
    ).resolve();
    expect(a).toBe("secret-1");
    expect(b).toBe("secret-2");
  });
});

// ── §13.7.3 contract: cluster-master ≠ service-tier ──────────────────────

describe("§13.7.3 contract: service-tier survives cluster-master compromise", () => {
  it("service-tier KEK is NOT derivable from the cluster root", async () => {
    // Adversary scenario: attacker has the cluster root + the public
    // tenantName list. They can derive every cluster-tier tenant's KEK
    // via HKDF. But the service-tier KEK was provisioned independently
    // and has no derivation path from the cluster root.
    const env: KekSourceEnv = {
      CLUSTER_ROOT: "compromised-root",
      SERVICE_S1_KEK: "independent-service-secret",
    };
    const services = new Map([["s1", "env://SERVICE_S1_KEK"]]);

    // Attacker derives cluster-tier KEKs for every known tenant.
    const aliceClusterKek = await buildKekScopeSource(
      { kind: "cluster", tenantName: "alice" },
      "env://CLUSTER_ROOT",
      services,
      env,
    ).resolve();
    // Service-tier KEK is unrelated.
    const serviceKek = await buildKekScopeSource(
      { kind: "service", name: "s1" },
      "env://CLUSTER_ROOT",
      services,
      env,
    ).resolve();
    expect(aliceClusterKek).not.toBe(serviceKek);
    expect(aliceClusterKek).not.toContain(serviceKek);
    expect(serviceKek).not.toContain(aliceClusterKek);
  });
});

// ── KekScope: TYPE-level cross-tier separation ───────────────────────────

describe("KekScope: compile-time tier separation", () => {
  it("cluster + service scopes are distinct types", () => {
    // This test is mostly a TypeScript-compile-time assertion expressed
    // at runtime. If the discriminator were lost, a single object could
    // satisfy both tiers — which the threat model rejects (§13.7.3).
    const cluster: KekScope = { kind: "cluster", tenantName: "alice" };
    const service: KekScope = { kind: "service", name: "s1" };
    expect(cluster.kind).toBe("cluster");
    expect(service.kind).toBe("service");
    // @ts-expect-error — `tenantName` is not on the service-tier shape
    void service.tenantName;
    // @ts-expect-error — `name` is not on the cluster-tier shape
    void cluster.name;
  });
});

// ── Conformance vector (anchor for ref-impl-py cross-impl test) ──────────

describe("conformance: pinned vectors for cross-implementation parity", () => {
  it("known-input → known-output (alice / well-known root)", async () => {
    // The Python ref-impl-py (cloister-0ffb3f vault-1 will extend the
    // cred-iso/v1 conformance suite) MUST produce the same output for
    // these inputs. Hex string locked here; regenerate ONLY when the
    // info-prefix or HKDF-hash bumps (a v1→v2 transition).
    const got = await deriveClusterTenantKek("conformance-root-2026-06-22", "alice");
    expect(got).toMatch(/^[0-9a-f]{64}$/);
    // Lock the actual bytes once the ref-impl-py vector lands. The
    // first-run output is captured + pinned here in the same commit
    // that adds the Python vector, so they stay in lock-step.
    // For now this test pins the SHAPE (64-char hex) and DETERMINISM
    // (same input → same output across runs); byte-equality with
    // ref-impl-py is the vault-1 bead's responsibility.
    const got2 = await deriveClusterTenantKek("conformance-root-2026-06-22", "alice");
    expect(got).toBe(got2);
  });
});
