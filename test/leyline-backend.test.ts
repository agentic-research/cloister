/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { LeylineLifecycleBackend, LEYLINE_LIFECYCLE_TOOLS } from "../src/backends/leyline.js";
import { JsonRpcInvocationError } from "../src/backends.js";
import type { Env, JsonRpcResponse } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeEnv(url = "http://stub.local/mcp"): Env {
  return { LLO_MCP_URL: url } as unknown as Env;
}

function recordingFetch(
  response: { ok?: boolean; status?: number; body: unknown },
): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const status = response.status ?? (response.ok === false ? 500 : 200);
    return new Response(JSON.stringify(response.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: stub, calls };
}

// ── tools() / handles() ────────────────────────────────────────────────────

describe("LeylineLifecycleBackend.tools", () => {
  it("returns reparse, enrich, status (no overlap with lsp_* or bead_*)", () => {
    const names = new LeylineLifecycleBackend().tools().map(t => t.name);
    expect(names).toEqual(["reparse", "enrich", "status"]);
  });

  it("matches the exported LEYLINE_LIFECYCLE_TOOLS constant", () => {
    expect(new LeylineLifecycleBackend().tools()).toBe(LEYLINE_LIFECYCLE_TOOLS);
  });

  it("enrich requires `pass`; reparse and status require nothing", () => {
    const byName = new Map(LEYLINE_LIFECYCLE_TOOLS.map(t => [t.name, t]));
    expect(byName.get("enrich")!.inputSchema.required).toEqual(["pass"]);
    expect(byName.get("reparse")!.inputSchema.required ?? []).toEqual([]);
    expect(byName.get("status")!.inputSchema.required ?? []).toEqual([]);
  });
});

describe("LeylineLifecycleBackend.handles", () => {
  it("claims the three lifecycle ops by exact name", () => {
    const b = new LeylineLifecycleBackend();
    expect(b.handles("reparse")).toBe(true);
    expect(b.handles("enrich")).toBe(true);
    expect(b.handles("status")).toBe(true);
  });

  it("does NOT claim lsp_*, bead_*, or unrelated names", () => {
    const b = new LeylineLifecycleBackend();
    expect(b.handles("lsp_hover")).toBe(false);
    expect(b.handles("bead_create")).toBe(false);
    expect(b.handles("vec_search")).toBe(false);
    expect(b.handles("snapshot")).toBe(false);   // valid LLO tool, not exposed here
    expect(b.handles("reparse_extra")).toBe(false); // exact-match only
  });
});

// ── invoke() — happy path ──────────────────────────────────────────────────

describe("LeylineLifecycleBackend.invoke (success path)", () => {
  it("forwards reparse with `source` to LLO and unwraps content[0].text JSON", async () => {
    const inner = { ok: true, files_reparsed: 1 };
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
        isError: false,
      },
    };
    const { fetch: stub, calls } = recordingFetch({ body: llo });
    const b = new LeylineLifecycleBackend(undefined, stub);
    const out = await b.invoke("reparse", { source: "/x/foo.rs" }, fakeEnv());

    expect(out).toEqual(inner);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "reparse", arguments: { source: "/x/foo.rs" } },
    });
  });

  it("forwards enrich with `pass` + `files`", async () => {
    const inner = { enriched: 3 };
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
        isError: false,
      },
    };
    const { fetch: stub, calls } = recordingFetch({ body: llo });
    const b = new LeylineLifecycleBackend(undefined, stub);
    const out = await b.invoke("enrich", { pass: "lsp", files: ["a.rs", "b.rs"] }, fakeEnv());

    expect(out).toEqual(inner);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent.params).toEqual({
      name: "enrich",
      arguments: { pass: "lsp", files: ["a.rs", "b.rs"] },
    });
  });

  it("forwards status with empty args", async () => {
    const inner = { phase: "ready", head_sha: "abc123" };
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
        isError: false,
      },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LeylineLifecycleBackend(undefined, stub);
    const out = await b.invoke("status", {}, fakeEnv());
    expect(out).toEqual(inner);
  });
});

// ── invoke() — failure modes ───────────────────────────────────────────────

describe("LeylineLifecycleBackend.invoke (error mapping)", () => {
  it("rejects when LLO_MCP_URL is unset", async () => {
    const b = new LeylineLifecycleBackend();
    const env = {} as unknown as Env;
    await expect(b.invoke("reparse", {}, env)).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("LLO_MCP_URL"),
    });
  });

  it("maps upstream JSON-RPC error to JsonRpcInvocationError with the same code", async () => {
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32602, message: "missing pass" },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LeylineLifecycleBackend(undefined, stub);
    await expect(b.invoke("enrich", {}, fakeEnv())).rejects.toBeInstanceOf(JsonRpcInvocationError);
    await expect(b.invoke("enrich", {}, fakeEnv())).rejects.toMatchObject({
      code: -32602,
      message: "missing pass",
    });
  });

  it("translates LLO isError:true to JsonRpcInvocationError(-32000)", async () => {
    const inner = { ok: false, error: "tree-sitter parse failed" };
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
        isError: true,
      },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LeylineLifecycleBackend(undefined, stub);
    await expect(b.invoke("reparse", { source: "x" }, fakeEnv())).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32000,
      message: expect.stringContaining("tree-sitter"),
    });
  });

  it("maps non-2xx HTTP to -32603", async () => {
    const { fetch: stub } = recordingFetch({ status: 502, body: { ok: false } });
    const b = new LeylineLifecycleBackend(undefined, stub);
    await expect(b.invoke("status", {}, fakeEnv())).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("maps network failure to -32603 'unreachable'", async () => {
    const stub: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    const b = new LeylineLifecycleBackend(undefined, stub);
    await expect(b.invoke("reparse", {}, fakeEnv())).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("rejects malformed LLO response (no content)", async () => {
    const llo: JsonRpcResponse = { jsonrpc: "2.0", id: 0, result: { ok: true } };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LeylineLifecycleBackend(undefined, stub);
    await expect(b.invoke("reparse", {}, fakeEnv())).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("no MCP content"),
    });
  });
});
