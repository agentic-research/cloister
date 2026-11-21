// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/notme (Apache-2.0); see ../NOTICE.

/**
 * vault.test.ts — TDD tests for the credential vault.
 *
 * Tests the core vault logic: store credentials, proxy requests with
 * identity-based scope checks, reject unauthorized access.
 *
 * No DO bindings needed — vault logic is tested via pure functions
 * with injected storage (same pattern as dpop-handler.ts).
 */

import { describe, expect, it, beforeEach } from "vitest";
import type { StoredCredential, VaultStorage } from "../vault";

// ── In-memory storage for tests ────────────────────────────────────────────

// The real types, so the test cannot drift from what the vault stores.

function createMemoryStorage(): VaultStorage {
  const store = new Map<string, StoredCredential>();
  return {
    async get(service) { return store.get(service) ?? null; },
    async put(service, cred) { store.set(service, cred); },
    async delete(service) { return store.delete(service); },
    async list() { return [...store.keys()]; },
  };
}

// ── Import vault functions (will fail until implemented) ───────────────────

async function getVault() {
  return import("../vault");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("storeCredential", () => {
  it("stores and retrieves a credential", async () => {
    const { storeCredential, getCredential } = await getVault();
    const storage = createMemoryStorage();

    await storeCredential(storage, "nvd", {
      upstream: "https://services.nvd.nist.gov/rest/json/cves/2.0",
      credential: "test-nvd-key",
      allowedSubs: ["repo:org/venturi:*"],
    });

    const cred = await getCredential(storage, "nvd");
    expect(cred).not.toBeNull();
    expect(cred!.upstream).toBe("https://services.nvd.nist.gov/rest/json/cves/2.0");
    expect(cred!.credential).toBe("test-nvd-key");
    expect(cred!.allowedSubs).toEqual(["repo:org/venturi:*"]);
  });

  it("overwrites existing credential for same service", async () => {
    const { storeCredential, getCredential } = await getVault();
    const storage = createMemoryStorage();

    await storeCredential(storage, "nvd", {
      upstream: "https://old.api",
      credential: "old-key",
      allowedSubs: ["*"],
    });

    await storeCredential(storage, "nvd", {
      upstream: "https://new.api",
      credential: "new-key",
      allowedSubs: ["repo:org/venturi:*"],
    });

    const cred = await getCredential(storage, "nvd");
    expect(cred!.credential).toBe("new-key");
    expect(cred!.upstream).toBe("https://new.api");
  });
});

describe("deleteCredential", () => {
  it("removes a stored credential", async () => {
    const { storeCredential, deleteCredential, getCredential } = await getVault();
    const storage = createMemoryStorage();

    await storeCredential(storage, "nvd", {
      upstream: "https://api.example.com",
      credential: "key",
      allowedSubs: ["*"],
    });

    const deleted = await deleteCredential(storage, "nvd");
    expect(deleted).toBe(true);
    expect(await getCredential(storage, "nvd")).toBeNull();
  });

  it("returns false for non-existent service", async () => {
    const { deleteCredential } = await getVault();
    const storage = createMemoryStorage();

    const deleted = await deleteCredential(storage, "nonexistent");
    expect(deleted).toBe(false);
  });
});

describe("listServices", () => {
  it("lists all stored service names", async () => {
    const { storeCredential, listServices } = await getVault();
    const storage = createMemoryStorage();

    await storeCredential(storage, "nvd", {
      upstream: "https://nvd.api",
      credential: "k1",
      allowedSubs: ["*"],
    });
    await storeCredential(storage, "github", {
      upstream: "https://api.github.com",
      credential: "gh_...",
      allowedSubs: ["repo:org/*"],
    });

    const services = await listServices(storage);
    expect(services).toContain("nvd");
    expect(services).toContain("github");
    expect(services).toHaveLength(2);
  });
});

describe("checkAccess", () => {
  it("allows matching glob pattern", async () => {
    const { checkAccess } = await getVault();

    expect(checkAccess(["repo:org/venturi:*"], "repo:org/venturi:read")).toBe(true);
    expect(checkAccess(["repo:org/venturi:*"], "repo:org/venturi:write")).toBe(true);
  });

  it("allows wildcard-all pattern", async () => {
    const { checkAccess } = await getVault();

    expect(checkAccess(["*"], "anything")).toBe(true);
    expect(checkAccess(["*"], "repo:org/venturi:read")).toBe(true);
  });

  it("allows exact match", async () => {
    const { checkAccess } = await getVault();

    expect(checkAccess(["repo:org/venturi:read"], "repo:org/venturi:read")).toBe(true);
  });

  it("rejects non-matching sub", async () => {
    const { checkAccess } = await getVault();

    expect(checkAccess(["repo:org/venturi:*"], "repo:org/other:read")).toBe(false);
    expect(checkAccess(["repo:org/venturi:read"], "repo:org/venturi:write")).toBe(false);
  });

  it("rejects empty allowedSubs", async () => {
    const { checkAccess } = await getVault();

    expect(checkAccess([], "anything")).toBe(false);
  });

  it("supports multiple patterns (any match = allow)", async () => {
    const { checkAccess } = await getVault();

    const patterns = ["repo:org/a:*", "repo:org/b:*"];
    expect(checkAccess(patterns, "repo:org/a:read")).toBe(true);
    expect(checkAccess(patterns, "repo:org/b:write")).toBe(true);
    expect(checkAccess(patterns, "repo:org/c:read")).toBe(false);
  });
});

describe("injectCredential (the one injection, ADR-0082 §1)", () => {
  // LLO's vectors pin every strategy byte for byte, through the vault's
  // Durable Object (test/routes/credential-isolation-conformance.test.ts).
  // These pin what the vectors leave out.
  const caller = (headers: Record<string, string>, upstreamPath = "/data", search = "") => ({
    method: "GET",
    upstreamPath,
    search,
    headers: Object.entries(headers),
  });

  it("sends the call to the declared base, the parsed path and the caller's query, byte for byte", async () => {
    const { injectCredential } = await import("../inject");
    const out = injectCredential({
      injection: { kind: "headerNamed", name: "apiKey" },
      credential: "test-key-123",
      username: "nvd",
      upstreamBase: "https://services.nvd.nist.gov/rest/json/",
      request: caller({}, "/cves/2.0", "?cveId=CVE-2026-1234&q=a%20b+c"),
    });
    expect(out.url).toBe("https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-1234&q=a%20b+c");
    expect(out.headers).toEqual([["apikey", "test-key-123"]]);
  });

  it("keeps the caller's other headers and does not leak its identity or the vault's host", async () => {
    const { injectCredential } = await import("../inject");
    const out = injectCredential({
      injection: { kind: "headerNamed", name: "X-Api-Key" },
      credential: "secret",
      username: "svc",
      upstreamBase: "https://api.example.com",
      request: caller({
        Host: "vault.example.com",
        Authorization: "Signet MIIB",
        "X-Client-Cert": "PEM-data",
        "X-Signet-Sig": "sig",
        "X-Signet-Ts": "1700000000000",
        "X-Signet-Nonce": "nonce",
        "X-Interlace-Peer": "fp",
        "Content-Type": "application/json",
      }),
    });
    expect(out.headers).toEqual([["content-type", "application/json"], ["x-api-key", "secret"]]);
  });

  it("refuses a credential that would end a header, instead of sending it", async () => {
    const { injectCredential, InjectionRefused } = await import("../inject");
    for (const injection of [{ kind: "authorizationBearer" as const }, { kind: "headerNamed" as const, name: "x-api-key" }]) {
      expect(() => injectCredential({
        injection,
        credential: "legit-key\r\nX-Injected: evil-value",
        username: "svc",
        upstreamBase: "https://api.example.com",
        request: caller({}),
      })).toThrow(InjectionRefused);
    }
  });

  it("encodes a Basic username and secret as UTF-8", async () => {
    const { injectCredential } = await import("../inject");
    const out = injectCredential({
      injection: { kind: "authorizationBasic" },
      credential: "pässwörd",
      username: "üser",
      upstreamBase: "https://api.example.com",
      request: caller({}),
    });
    const encoded = out.headers.find(([name]) => name === "authorization")![1].slice("Basic ".length);
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))).toBe("üser:pässwörd");
  });

  it("refuses a bodyField call it cannot carry the credential in", async () => {
    const { injectCredential, InjectionRefused } = await import("../inject");
    const body = (method: string) => injectCredential({
      injection: { kind: "bodyField", path: "auth.client_secret" },
      credential: "s",
      username: "svc",
      upstreamBase: "https://api.example.com",
      request: { ...caller({ "Content-Type": "application/json" }), method },
    });
    expect(() => body("GET")).toThrow(InjectionRefused);
    const rewrite = body("POST").rewriteBody!;
    expect(rewrite('{"auth":{"client_id":"a"},"z":1}')).toBe('{"auth":{"client_id":"a","client_secret":"s"},"z":1}');
    expect(rewrite("")).toBe('{"auth":{"client_secret":"s"}}');
    for (const notAnObject of ["[1]", "\"text\"", "not json", '{"id":12345678901234567890}']) {
      expect(() => rewrite(notAnObject)).toThrow(InjectionRefused);
    }
  });
});
