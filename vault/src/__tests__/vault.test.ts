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

// ── In-memory storage for tests ────────────────────────────────────────────

/** Minimal storage interface matching DO SQLite patterns. */
interface VaultStorage {
  get(service: string): Promise<StoredCredential | null>;
  put(service: string, cred: StoredCredential): Promise<void>;
  delete(service: string): Promise<boolean>;
  list(): Promise<string[]>;
}

interface StoredCredential {
  /** The upstream URL to proxy to. */
  upstream: string;
  /** Headers to inject (e.g. { "apiKey": "sk-..." }). */
  headers: Record<string, string>;
  /** Glob patterns for allowed subs (e.g. ["repo:org/venturi:*"]). */
  allowedSubs: string[];
}

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
      headers: { apiKey: "test-nvd-key" },
      allowedSubs: ["repo:org/venturi:*"],
    });

    const cred = await getCredential(storage, "nvd");
    expect(cred).not.toBeNull();
    expect(cred!.upstream).toBe("https://services.nvd.nist.gov/rest/json/cves/2.0");
    expect(cred!.headers.apiKey).toBe("test-nvd-key");
    expect(cred!.allowedSubs).toEqual(["repo:org/venturi:*"]);
  });

  it("overwrites existing credential for same service", async () => {
    const { storeCredential, getCredential } = await getVault();
    const storage = createMemoryStorage();

    await storeCredential(storage, "nvd", {
      upstream: "https://old.api",
      headers: { apiKey: "old-key" },
      allowedSubs: ["*"],
    });

    await storeCredential(storage, "nvd", {
      upstream: "https://new.api",
      headers: { apiKey: "new-key" },
      allowedSubs: ["repo:org/venturi:*"],
    });

    const cred = await getCredential(storage, "nvd");
    expect(cred!.headers.apiKey).toBe("new-key");
    expect(cred!.upstream).toBe("https://new.api");
  });
});

describe("deleteCredential", () => {
  it("removes a stored credential", async () => {
    const { storeCredential, deleteCredential, getCredential } = await getVault();
    const storage = createMemoryStorage();

    await storeCredential(storage, "nvd", {
      upstream: "https://api.example.com",
      headers: { apiKey: "key" },
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
      headers: { apiKey: "k1" },
      allowedSubs: ["*"],
    });
    await storeCredential(storage, "github", {
      upstream: "https://api.github.com",
      headers: { Authorization: "token gh_..." },
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

describe("buildProxyRequest", () => {
  it("injects credential headers into upstream request", async () => {
    const { buildProxyRequest } = await getVault();

    const cred: StoredCredential = {
      upstream: "https://services.nvd.nist.gov/rest/json/cves/2.0",
      headers: { apiKey: "test-key-123" },
      allowedSubs: ["*"],
    };

    const incoming = new Request("https://vault.example.com/nvd?cveId=CVE-2026-1234");
    const proxied = buildProxyRequest(incoming, cred);

    expect(proxied.url).toBe("https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-1234");
    expect(proxied.headers.get("apiKey")).toBe("test-key-123");
  });

  it("preserves query params from original request", async () => {
    const { buildProxyRequest } = await getVault();

    const cred: StoredCredential = {
      upstream: "https://api.github.com/repos",
      headers: { Authorization: "token gh_abc123" },
      allowedSubs: ["*"],
    };

    const incoming = new Request("https://vault.example.com/github?per_page=10&page=2");
    const proxied = buildProxyRequest(incoming, cred);

    const url = new URL(proxied.url);
    expect(url.origin + url.pathname).toBe("https://api.github.com/repos");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(url.searchParams.get("page")).toBe("2");
    expect(proxied.headers.get("Authorization")).toBe("token gh_abc123");
  });

  it("forwards request body for POST requests", async () => {
    const { buildProxyRequest } = await getVault();

    const cred: StoredCredential = {
      upstream: "https://api.example.com/data",
      headers: { "X-Api-Key": "secret" },
      allowedSubs: ["*"],
    };

    const incoming = new Request("https://vault.example.com/example", {
      method: "POST",
      body: JSON.stringify({ query: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    const proxied = buildProxyRequest(incoming, cred);

    expect(proxied.method).toBe("POST");
    expect(proxied.headers.get("X-Api-Key")).toBe("secret");
    expect(proxied.headers.get("Content-Type")).toBe("application/json");
  });

  it("does not leak vault host headers to upstream", async () => {
    const { buildProxyRequest } = await getVault();

    const cred: StoredCredential = {
      upstream: "https://api.example.com/data",
      headers: { "X-Api-Key": "secret" },
      allowedSubs: ["*"],
    };

    const incoming = new Request("https://vault.example.com/example", {
      headers: {
        Host: "vault.example.com",
        Authorization: "Bearer user-token",
        "X-Client-Cert": "PEM-data",
      },
    });
    const proxied = buildProxyRequest(incoming, cred);

    // Caller's auth headers should NOT be forwarded to upstream
    expect(proxied.headers.get("Authorization")).toBeNull();
    expect(proxied.headers.get("X-Client-Cert")).toBeNull();
    // But credential headers should be injected
    expect(proxied.headers.get("X-Api-Key")).toBe("secret");
  });
});
