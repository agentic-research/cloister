// Tests for src/routes/vault-proxy-credential-store.ts — the
// credential-store seam for cloister/credential-isolation/v1
// (cloister-8f57f0).
//
// Pure-function unit tests; no DO, no fetch, no MCP server.

import { describe, expect, it } from "vitest";
import {
  InMemoryCredentialStore,
  type CredentialStore,
} from "../../src/routes/vault-proxy-credential-store.js";

describe("InMemoryCredentialStore", () => {
  it("returns null when (peerFp, service) is not present", async () => {
    const store = new InMemoryCredentialStore();
    expect(await store.resolve("sha256:nobody", "openai")).toBeNull();
  });

  it("returns the stored credential after set", async () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:alice", "openai", { credential: "sk-alice" });
    const got = await store.resolve("sha256:alice", "openai");
    expect(got?.credential).toBe("sk-alice");
    expect(got?.username).toBeUndefined();
  });

  it("preserves the optional username for basic-auth services", async () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:bob", "internal-svc", {
      credential: "secret123",
      username:   "operator",
    });
    const got = await store.resolve("sha256:bob", "internal-svc");
    expect(got?.credential).toBe("secret123");
    expect(got?.username).toBe("operator");
  });

  it("isolates lookups by peerFp (same service, different peers)", async () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:peer-A", "openai", { credential: "sk-A" });
    store.set("sha256:peer-B", "openai", { credential: "sk-B" });
    expect((await store.resolve("sha256:peer-A", "openai"))?.credential).toBe("sk-A");
    expect((await store.resolve("sha256:peer-B", "openai"))?.credential).toBe("sk-B");
  });

  it("isolates lookups by service (same peer, different services)", async () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:alice", "openai",    { credential: "sk-openai" });
    store.set("sha256:alice", "anthropic", { credential: "sk-anthropic" });
    expect((await store.resolve("sha256:alice", "openai"))?.credential).toBe("sk-openai");
    expect((await store.resolve("sha256:alice", "anthropic"))?.credential).toBe("sk-anthropic");
  });

  it("delete removes the entry; subsequent resolve returns null", async () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:alice", "openai", { credential: "sk-alice" });
    expect(store.delete("sha256:alice", "openai")).toBe(true);
    expect(await store.resolve("sha256:alice", "openai")).toBeNull();
    // Idempotent: second delete reports false.
    expect(store.delete("sha256:alice", "openai")).toBe(false);
  });

  it("set replaces an existing entry (no merge)", async () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:alice", "openai", { credential: "sk-old" });
    store.set("sha256:alice", "openai", { credential: "sk-new" });
    expect((await store.resolve("sha256:alice", "openai"))?.credential).toBe("sk-new");
  });

  it("clear() empties the store", () => {
    const store = new InMemoryCredentialStore();
    store.set("sha256:alice", "openai", { credential: "sk-alice" });
    store.set("sha256:bob",   "openai", { credential: "sk-bob" });
    expect(store.size).toBe(2);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("structurally satisfies the CredentialStore interface", () => {
    const store: CredentialStore = new InMemoryCredentialStore();
    // tsc passes ↔ the structural type matches; this assertion just
    // documents the contract for human readers.
    expect(typeof store.resolve).toBe("function");
  });
});
