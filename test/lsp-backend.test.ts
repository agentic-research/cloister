/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { LspToolBackend, LSP_TOOLS } from "../src/backends/lsp.js";
import { JsonRpcInvocationError } from "../src/backends.js";
import type { Env, JsonRpcResponse } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeEnv(url = "http://stub.local/mcp"): Env {
  return { LLO_MCP_URL: url } as unknown as Env;
}

/** Build a fetch impl that records calls and returns the supplied response. */
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

// ── tools() / handles() contract ───────────────────────────────────────────

describe("LspToolBackend.tools", () => {
  it("returns the static lsp_* tool list", () => {
    const b = new LspToolBackend();
    const names = b.tools().map((t) => t.name);
    expect(names).toEqual([
      "lsp_hover",
      "lsp_defs",
      "lsp_refs",
      "lsp_symbols",
      "lsp_diagnostics",
    ]);
  });

  it("matches the exported LSP_TOOLS constant", () => {
    const b = new LspToolBackend();
    expect(b.tools()).toBe(LSP_TOOLS);
  });
});

describe("LspToolBackend.handles", () => {
  it("claims lsp_* tool names", () => {
    const b = new LspToolBackend();
    expect(b.handles("lsp_hover")).toBe(true);
    expect(b.handles("lsp_diagnostics")).toBe(true);
  });

  it("does not claim non-lsp names", () => {
    const b = new LspToolBackend();
    expect(b.handles("bead_create")).toBe(false);
    expect(b.handles("status")).toBe(false);
    expect(b.handles("vec_search")).toBe(false);
  });
});

// ── invoke() forwarding contract ───────────────────────────────────────────

describe("LspToolBackend.invoke (success path)", () => {
  it("forwards tools/call to LLO and unwraps content[0].text as JSON", async () => {
    const inner = { ok: true, hover: "fn foo()", node_id: "src/foo.rs/0" };
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
        isError: false,
      },
    };
    const { fetch: stub, calls } = recordingFetch({ body: llo });
    const b = new LspToolBackend(undefined, stub);
    const args = { file: "/x/foo.rs", line: 10, col: 5 };
    const out = await b.invoke("lsp_hover", args, fakeEnv());

    expect(out).toEqual(inner);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "lsp_hover", arguments: args },
    });
  });

  it("returns raw text when LLO content is non-JSON", async () => {
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: "free-form prose" }],
        isError: false,
      },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LspToolBackend(undefined, stub);
    const out = await b.invoke("lsp_hover", { file: "x", line: 0, col: 0 }, fakeEnv());
    expect(out).toBe("free-form prose");
  });
});

// ── invoke() error mapping ─────────────────────────────────────────────────

describe("LspToolBackend.invoke (error mapping)", () => {
  it("throws JsonRpcInvocationError when LLO returns JSON-RPC error", async () => {
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32601, message: "unknown tool: lsp_foo" },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LspToolBackend(undefined, stub);
    await expect(b.invoke("lsp_foo", {}, fakeEnv())).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32601,
      message: expect.stringContaining("unknown tool"),
    });
  });

  it("translates LLO isError:true to JsonRpcInvocationError(-32000)", async () => {
    const inner = { ok: false, error: "no such table: _lsp" };
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: {
        content: [{ type: "text", text: JSON.stringify(inner) }],
        isError: true,
      },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LspToolBackend(undefined, stub);
    await expect(
      b.invoke("lsp_diagnostics", { file: "x.rs" }, fakeEnv()),
    ).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32000,
      message: expect.stringContaining("no such table"),
    });
  });

  it("maps network failure to -32603", async () => {
    const stub: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const b = new LspToolBackend(undefined, stub);
    await expect(b.invoke("lsp_hover", {}, fakeEnv())).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("maps non-2xx HTTP to -32603", async () => {
    const { fetch: stub } = recordingFetch({ status: 502, body: { ok: false } });
    const b = new LspToolBackend(undefined, stub);
    await expect(
      b.invoke("lsp_hover", {}, fakeEnv()),
    ).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("HTTP 502"),
    });
  });

  it("rejects when LLO_MCP_URL is unset", async () => {
    const b = new LspToolBackend();
    const env = {} as unknown as Env;
    await expect(b.invoke("lsp_hover", {}, env)).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("LLO_MCP_URL"),
    });
  });

  it("rejects malformed LLO response (no content)", async () => {
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      result: { ok: true },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LspToolBackend(undefined, stub);
    await expect(
      b.invoke("lsp_hover", {}, fakeEnv()),
    ).rejects.toMatchObject({
      name: "JsonRpcInvocationError",
      code: -32603,
      message: expect.stringContaining("no MCP content"),
    });
  });
});

// Sanity: the JsonRpcInvocationError sentinel is reachable here so the test
// suite would catch a regression where LspToolBackend imports the wrong type.
describe("error type identity", () => {
  it("uses the same JsonRpcInvocationError as backends.ts", async () => {
    const llo: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32602, message: "bad args" },
    };
    const { fetch: stub } = recordingFetch({ body: llo });
    const b = new LspToolBackend(undefined, stub);
    try {
      await b.invoke("lsp_hover", {}, fakeEnv());
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(JsonRpcInvocationError);
    }
  });
});
