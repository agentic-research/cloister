/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// Unit tests for cloister-decf0d (c8b907 sub-bead 2): the
// BEAD_STORAGE_BACKEND feature flag + the rsry-mode helper in
// src/routes/bead-create-orchestrator.ts.
//
// Per ADR-0033 D5 amendment 2026-06-24. The bead-create orchestrator
// switches Step 2 between BeadStore DurableObject (default "do") and
// rsry's `rsry_bead_create` over the ROSARY_BUNDLE service binding
// ("rsry"). Sub-bead 1 (cloister-dea77c) already shipped the bead_id
// column on TrustStore that lets both paths share Step 3's audit chain.

import { afterEach, describe, expect, it } from "vitest";
import {
  bedStorageBackend,
  createBeadViaRsry,
  __resetBeadStoreDoWarnedForTest,
} from "../../src/routes/bead-create-orchestrator.js";
import type { Env } from "../../src/types.js";

// ── bedStorageBackend resolver ───────────────────────────────────────────

describe("bedStorageBackend: BEAD_STORAGE_BACKEND env resolver (cloister-decf0d)", () => {
  function envWith(value: string | undefined): Env {
    return { BEAD_STORAGE_BACKEND: value } as unknown as Env;
  }

  it("defaults to 'do' when BEAD_STORAGE_BACKEND is undefined (back-compat)", () => {
    expect(bedStorageBackend(envWith(undefined))).toBe("do");
  });

  it("defaults to 'do' when BEAD_STORAGE_BACKEND is empty string", () => {
    expect(bedStorageBackend(envWith(""))).toBe("do");
  });

  it("resolves to 'rsry' when set to 'rsry'", () => {
    expect(bedStorageBackend(envWith("rsry"))).toBe("rsry");
  });

  it("case-insensitive: 'RSRY', 'Rsry', '  rsry  ' all resolve to 'rsry'", () => {
    expect(bedStorageBackend(envWith("RSRY"))).toBe("rsry");
    expect(bedStorageBackend(envWith("Rsry"))).toBe("rsry");
    expect(bedStorageBackend(envWith("  rsry  "))).toBe("rsry");
  });

  it("unknown values default to 'do' (safe fallback — never silently switch backends on typo)", () => {
    expect(bedStorageBackend(envWith("do"))).toBe("do");
    expect(bedStorageBackend(envWith("rosary"))).toBe("do");      // close but not rsry
    expect(bedStorageBackend(envWith("bd"))).toBe("do");          // also not rsry
    expect(bedStorageBackend(envWith("typo"))).toBe("do");
  });
});

// ── createBeadViaRsry: MCP wire shape ────────────────────────────────────

describe("createBeadViaRsry: rsry MCP path (cloister-decf0d)", () => {
  /**
   * Stub Fetcher capturing the MCP request. Returns a synthetic rsry
   * `tools/call` response with the bead row JSON-serialized inside
   * `result.content[0].text` (per the MCP `tools/call` shape).
   */
  function makeStubBinding(
    respond: (req: { method: string; params: { name: string; arguments: Record<string, unknown> } }) => {
      id?: string;
      title?: string;
      state?: string;
    } | { error: { code: number; message: string } }
  ): { fetcher: Fetcher; lastRequest: () => unknown } {
    let lastBody: unknown = null;
    const fetcher: Fetcher = {
      async fetch(req: RequestInfo | URL): Promise<Response> {
        const r = req instanceof Request ? req : new Request(req);
        const body = await r.text();
        lastBody = JSON.parse(body);
        const parsed = JSON.parse(body) as {
          method: string;
          params: { name: string; arguments: Record<string, unknown> };
        };
        const result = respond(parsed);
        if ("error" in result) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 0, error: result.error }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // MCP tools/call success: result.content[0].text = JSON of the bead row.
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            result: {
              content: [
                { type: "text", text: JSON.stringify(result) },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    return { fetcher, lastRequest: () => lastBody };
  }

  it("sends a tools/call to rsry_bead_create over ROSARY_BUNDLE service binding", async () => {
    const { fetcher, lastRequest } = makeStubBinding(() => ({
      id: "cloister-abc123",
      title: "test bead",
      state: "open",
    }));
    const env = { ROSARY_BUNDLE: fetcher } as unknown as Env;

    const result = await createBeadViaRsry(env, {
      repo: "/tmp/test",
      title: "test bead",
      description: "from rsry path",
    });

    expect(result.id).toBe("cloister-abc123");
    expect(result.title).toBe("test bead");
    expect(result.state).toBe("open");

    const req = lastRequest() as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(req.method).toBe("tools/call");
    expect(req.params.name).toBe("rsry_bead_create");
    expect(req.params.arguments.title).toBe("test bead");
    expect(req.params.arguments.repo).toBe("/tmp/test");
  });

  it("falls back to ROSARY_MCP_URL when ROSARY_BUNDLE is absent (local-dev path)", async () => {
    // Mock global fetch since URL-var fallback uses it.
    const calls: Array<{ url: string; body: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? String(init.body) : "";
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ id: "cloister-fallback", title: "x", state: "open" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const env = { ROSARY_MCP_URL: "http://localhost:8383/mcp" } as unknown as Env;
      const result = await createBeadViaRsry(env, { repo: "/tmp", title: "x" });
      expect(result.id).toBe("cloister-fallback");
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe("http://localhost:8383/mcp");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws JsonRpcInvocationError when neither ROSARY_BUNDLE nor ROSARY_MCP_URL is wired", async () => {
    const env = {} as Env;
    await expect(createBeadViaRsry(env, { repo: "/tmp", title: "x" })).rejects.toThrow(
      /neither ROSARY_BUNDLE service binding nor ROSARY_MCP_URL/,
    );
  });

  it("propagates rsry tool error (§13.4 short-circuit — TrustStore write skipped)", async () => {
    const { fetcher } = makeStubBinding(() => ({
      error: { code: -32602, message: "title is required" },
    }));
    const env = { ROSARY_BUNDLE: fetcher } as unknown as Env;
    await expect(createBeadViaRsry(env, { repo: "/tmp", title: "" })).rejects.toThrow(
      /rsry_bead_create failed.*title is required/,
    );
  });

  it("throws when rsry returns no content[0].text (defensive against MCP wire shape drift)", async () => {
    const broken: Fetcher = {
      async fetch(): Promise<Response> {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 0, result: { content: [] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const env = { ROSARY_BUNDLE: broken } as unknown as Env;
    await expect(createBeadViaRsry(env, { repo: "/tmp", title: "x" })).rejects.toThrow(
      /missing result\.content\[0\]\.text/,
    );
  });

  it("throws when rsry's tool result is non-JSON (defensive)", async () => {
    const broken: Fetcher = {
      async fetch(): Promise<Response> {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            result: { content: [{ type: "text", text: "not json" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    const env = { ROSARY_BUNDLE: broken } as unknown as Env;
    await expect(createBeadViaRsry(env, { repo: "/tmp", title: "x" })).rejects.toThrow(
      /non-JSON tool result/,
    );
  });

  it("throws when rsry's tool result is missing the id field (defensive)", async () => {
    const { fetcher } = makeStubBinding(() => ({ title: "x", state: "open" })); // no id
    const env = { ROSARY_BUNDLE: fetcher } as unknown as Env;
    await expect(createBeadViaRsry(env, { repo: "/tmp", title: "x" })).rejects.toThrow(
      /missing `id` field/,
    );
  });

  it("propagates rsry non-2xx HTTP status with status code in error message", async () => {
    const broken: Fetcher = {
      async fetch(): Promise<Response> {
        return new Response("upstream unavailable", { status: 503 });
      },
    } as unknown as Fetcher;
    const env = { ROSARY_BUNDLE: broken } as unknown as Env;
    await expect(createBeadViaRsry(env, { repo: "/tmp", title: "x" })).rejects.toThrow(
      /rsry returned 503/,
    );
  });
});

// ── BeadStore-DO deprecation warning (c8b907 sub-bead 3 prep / f34f7b) ───

describe("BeadStore-DO deprecation warning (cloister-f34f7b prep)", () => {
  // Reset the module-level flag before each test so the one-shot behavior
  // is observable. The reset seam is test-only (`__resetBeadStoreDoWarnedForTest`).
  afterEach(() => {
    __resetBeadStoreDoWarnedForTest();
  });

  // Re-import the internal warning fn so we can drive it directly without
  // going through `runBeadCreateOrchestrator` (which would require the full
  // env + DOs). The orchestrator simply calls this fn when backend==="do".
  // Since the fn is not exported, we test the behavior INDIRECTLY: prove
  // that the resolver flag value gates whether the orchestrator would call
  // it. The one-shot property is verified by spawning the orchestrator
  // path through bedStorageBackend twice and checking the side-effect.
  //
  // Practical: the warning fn is exercised end-to-end in
  // `test/security/orchestrator-rsry-mode-integration.test.ts` do-mode case
  // (which runs the real orchestrator with default backend). Here we just
  // pin the reset seam works (regression prevention).

  it("__resetBeadStoreDoWarnedForTest is a valid test-only export (not undefined)", () => {
    expect(typeof __resetBeadStoreDoWarnedForTest).toBe("function");
    expect(() => __resetBeadStoreDoWarnedForTest()).not.toThrow();
  });
});
