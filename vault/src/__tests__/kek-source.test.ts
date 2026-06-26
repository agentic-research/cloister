// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors

/**
 * kek-source.test.ts — unit tests for the pluggable KEK source.
 *
 * These tests exercise the URL-driven resolver in isolation, with
 * fake env shapes and stub Fetcher bindings. The actual macOS Keychain
 * round-trip is gated behind a separate end-to-end test (run manually
 * via the dogfood smoke described in ADR-0014). The kek-helper sidecar
 * is tested over a real HTTP server in
 * `test/vault/kek-helper-smoke.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { buildKekSource, HELPER_SCHEMES, type KekSourceEnv } from "../kek-source";

// ── env:// ──────────────────────────────────────────────────────────────────

describe("env:// KEK source", () => {
  it("resolves the value of the named env binding", async () => {
    const env: KekSourceEnv = { MY_KEK: "super-secret-32-bytes-pretend" };
    const src = buildKekSource("env://MY_KEK", env);
    await expect(src.resolve()).resolves.toBe("super-secret-32-bytes-pretend");
  });

  it("throws when the env binding is unset", async () => {
    const env: KekSourceEnv = {};
    const src = buildKekSource("env://NOPE", env);
    await expect(src.resolve()).rejects.toThrow(/env:\/\/NOPE is unset or empty/);
  });

  it("throws when the env binding is the empty string", async () => {
    const env: KekSourceEnv = { EMPTY: "" };
    const src = buildKekSource("env://EMPTY", env);
    await expect(src.resolve()).rejects.toThrow(/unset or empty/);
  });

  it("rejects invalid var names at construction (no shell-like chars)", () => {
    const env: KekSourceEnv = {};
    expect(() => buildKekSource("env://", env)).toThrow();
    expect(() => buildKekSource("env://has spaces", env)).toThrow();
    expect(() => buildKekSource("env://semi;colon", env)).toThrow();
    expect(() => buildKekSource("env://dotted.name", env)).toThrow();
  });
});

// ── file:// ─────────────────────────────────────────────────────────────────

describe("file:// KEK source", () => {
  function fakeDisk(handler: (path: string) => Response): Fetcher {
    return {
      fetch: async (input: RequestInfo) => {
        const url = typeof input === "string" ? input : input.url;
        const path = new URL(url).pathname;
        return handler(path);
      },
    } as unknown as Fetcher;
  }

  it("GETs the path from the KEK_DISK service binding", async () => {
    let seen = "";
    const env: KekSourceEnv = {
      KEK_DISK: fakeDisk((path) => {
        seen = path;
        return new Response("file-kek-bytes\n");
      }),
    };
    const src = buildKekSource("file:///etc/cloister/kek.bin", env);
    await expect(src.resolve()).resolves.toBe("file-kek-bytes");
    expect(seen).toBe("/etc/cloister/kek.bin");
  });

  it("strips trailing newlines (single)", async () => {
    const env: KekSourceEnv = {
      KEK_DISK: fakeDisk(() => new Response("abc\n")),
    };
    const src = buildKekSource("file:///x", env);
    await expect(src.resolve()).resolves.toBe("abc");
  });

  it("strips trailing newlines (multiple + CRLF)", async () => {
    const env: KekSourceEnv = {
      KEK_DISK: fakeDisk(() => new Response("abc\r\n\n\r\n")),
    };
    const src = buildKekSource("file:///x", env);
    await expect(src.resolve()).resolves.toBe("abc");
  });

  it("throws if KEK_DISK is unbound", async () => {
    const env: KekSourceEnv = {};
    const src = buildKekSource("file:///x", env);
    await expect(src.resolve()).rejects.toThrow(/KEK_DISK service binding/);
  });

  it("throws on non-2xx disk response", async () => {
    const env: KekSourceEnv = {
      KEK_DISK: fakeDisk(() => new Response("nope", { status: 404 })),
    };
    const src = buildKekSource("file:///missing.bin", env);
    await expect(src.resolve()).rejects.toThrow(/status 404/);
  });

  it("throws on empty disk response", async () => {
    const env: KekSourceEnv = {
      KEK_DISK: fakeDisk(() => new Response("\n\n")),
    };
    const src = buildKekSource("file:///empty", env);
    await expect(src.resolve()).rejects.toThrow(/empty bytes/);
  });

  it("rejects file:// with a non-empty host", () => {
    expect(() => buildKekSource("file://somehost/path", {})).toThrow(/host must be empty/);
  });

  it("rejects file:// with no path", () => {
    expect(() => buildKekSource("file:///", {})).toThrow(/path must be non-empty/);
  });
});

// ── keychain:// + http(s):// via KEK_HELPER ─────────────────────────────────

describe("keychain:// + http(s):// KEK source (via KEK_HELPER)", () => {
  function fakeHelper(handler: (url: string) => Response): Fetcher {
    return {
      fetch: async (input: RequestInfo) => {
        const url = typeof input === "string" ? input : input.url;
        return handler(url);
      },
    } as unknown as Fetcher;
  }

  it("issues GET /resolve?url=<spec> against KEK_HELPER and returns body", async () => {
    let seenUrl = "";
    const env: KekSourceEnv = {
      KEK_HELPER: fakeHelper((url) => {
        seenUrl = url;
        return new Response("keychain-bytes-here");
      }),
    };
    const src = buildKekSource("keychain://com.cloister/kek", env);
    await expect(src.resolve()).resolves.toBe("keychain-bytes-here");
    expect(seenUrl).toContain("/resolve?url=");
    expect(decodeURIComponent(seenUrl)).toContain("keychain://com.cloister/kek");
  });

  it("strips trailing newlines from helper response", async () => {
    const env: KekSourceEnv = {
      KEK_HELPER: fakeHelper(() => new Response("hex\n")),
    };
    const src = buildKekSource("keychain://x", env);
    await expect(src.resolve()).resolves.toBe("hex");
  });

  it("throws if KEK_HELPER is unbound", async () => {
    const src = buildKekSource("keychain://x", {});
    await expect(src.resolve()).rejects.toThrow(/KEK_HELPER service binding/);
  });

  it("throws on non-2xx helper response and does NOT leak the spec", async () => {
    const env: KekSourceEnv = {
      KEK_HELPER: fakeHelper(() => new Response("not found", { status: 404 })),
    };
    const src = buildKekSource("keychain://secret-service-name", env);
    await expect(src.resolve()).rejects.toThrow(/keychain:\/\/ lookup returned 404/);
    // The error must NOT contain the service name (potential info leak).
    try {
      await src.resolve();
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-service-name");
    }
  });

  it("throws on empty helper body", async () => {
    const env: KekSourceEnv = {
      KEK_HELPER: fakeHelper(() => new Response("")),
    };
    const src = buildKekSource("keychain://x", env);
    await expect(src.resolve()).rejects.toThrow(/returned empty body/);
  });

  it("supports http:// helper URLs (treated as helper-backed)", async () => {
    const env: KekSourceEnv = {
      KEK_HELPER: fakeHelper(() => new Response("http-backed-kek")),
    };
    const src = buildKekSource("http://my-helper.local/kek", env);
    await expect(src.resolve()).resolves.toBe("http-backed-kek");
  });

  // ── cloister-1d952e: additional helper-routed schemes ─────────────
  //
  // All four extra schemes use the same HelperKekSource path the
  // keychain:// + http(s):// tests above exercise. The dispatch test
  // here proves each scheme is recognized at construction (no
  // "unsupported URL scheme" throw) AND routes through KEK_HELPER
  // with the spec passed through to the helper unchanged. Per-scheme
  // platform behavior (libsecret-tool, 1Password CLI, etc.) is the
  // HELPER's responsibility — those tests live in the helper's repo.

  it.each([
    ["secret-tool://attribute/value",  "secret-tool-kek"],
    ["op://Personal/cloister-kek",     "1password-kek"],
    ["apple-password://com.cloister",  "apple-keychain-kek"],
    ["keyring://cloister-kek",         "keyring-kek"],
  ])("routes %s through KEK_HELPER with spec preserved", async (spec, body) => {
    let seenUrl = "";
    const env: KekSourceEnv = {
      KEK_HELPER: fakeHelper((url) => {
        seenUrl = url;
        return new Response(body);
      }),
    };
    const src = buildKekSource(spec, env);
    await expect(src.resolve()).resolves.toBe(body);
    // The spec must reach the helper verbatim (URL-encoded). If the
    // dispatcher silently rewrote schemes (e.g. `op://` → something
    // else), this assertion would fail.
    expect(decodeURIComponent(seenUrl)).toContain(spec);
  });

  it.each([
    "secret-tool://x",
    "op://x/y",
    "apple-password://x",
    "keyring://x",
  ])("%s throws when KEK_HELPER is unbound (same error path as keychain://)", async (spec) => {
    const src = buildKekSource(spec, {});
    await expect(src.resolve()).rejects.toThrow(/KEK_HELPER service binding/);
  });

  it("HELPER_SCHEMES is the authoritative list — dispatch routes every entry", async () => {
    // Regression guard: if someone adds a scheme to HELPER_SCHEMES but
    // forgets to verify it actually dispatches, this catches it. Every
    // declared prefix MUST construct without throwing the "unsupported
    // URL scheme" error.
    for (const prefix of HELPER_SCHEMES) {
      // Minimal valid spec per scheme — `<prefix>x` is enough since we
      // only test construction routing, not the helper interaction.
      const spec = `${prefix}x`;
      expect(() => buildKekSource(spec, {})).not.toThrow(/unsupported URL scheme/);
    }
  });
});

// ── Construction errors ────────────────────────────────────────────────────

describe("buildKekSource — construction errors", () => {
  it("rejects empty spec", () => {
    expect(() => buildKekSource("", {})).toThrow();
  });

  it("rejects unknown scheme", () => {
    expect(() => buildKekSource("dpapi://stuff", {})).toThrow(/unsupported URL scheme/);
  });

  it("rejects a spec missing a scheme entirely", () => {
    expect(() => buildKekSource("just-some-string", {})).toThrow(/unsupported URL scheme/);
  });
});
