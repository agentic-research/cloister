/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { McpEdgeRoute } from "../src/routes/mcp.js";
import { JsonRpcInvocationError, type ToolBackend } from "../src/backends.js";
import type { Env, JsonRpcResponse, McpTool } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const tool = (name: string): McpTool => ({
  name,
  description: `${name} (test)`,
  inputSchema: { type: "object", properties: {}, required: [] },
});

class FakeBackend implements ToolBackend {
  invocations: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(
    private prefix: string,
    private toolDefs: McpTool[],
    private behavior: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown
      = async () => ({ ok: true }),
  ) {}
  tools()                          { return this.toolDefs; }
  handles(name: string)            { return name.startsWith(this.prefix); }
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.invocations.push({ name, args });
    return await this.behavior(name, args);
  }
}

function fakeEnv(): Env { return {} as Env; }

async function postMcp(route: McpEdgeRoute, body: unknown): Promise<JsonRpcResponse> {
  const res = await route.handle(
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    fakeEnv(),
  );
  return (await res.json()) as JsonRpcResponse;
}

// ── EdgeRoute contract ─────────────────────────────────────────────────────

describe("McpEdgeRoute.match", () => {
  it("matches /mcp exactly", () => {
    const r = new McpEdgeRoute([]);
    expect(r.match(new Request("http://x/mcp"))).toBe(true);
    expect(r.match(new Request("http://x/mcp?q=1"))).toBe(true);
  });

  it("does not match /mcp/foo or other paths", () => {
    const r = new McpEdgeRoute([]);
    expect(r.match(new Request("http://x/mcp/foo"))).toBe(false);
    expect(r.match(new Request("http://x/health"))).toBe(false);
    expect(r.match(new Request("http://x/"))).toBe(false);
  });
});

// ── tools/list aggregation ────────────────────────────────────────────────

describe("McpEdgeRoute tools/list aggregation", () => {
  it("returns union of tools across all backends in declaration order", async () => {
    const a = new FakeBackend("a_", [tool("a_one"), tool("a_two")]);
    const b = new FakeBackend("b_", [tool("b_one")]);
    const route = new McpEdgeRoute([a, b]);
    const res = await postMcp(route, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    const names = ((res.result as { tools: McpTool[] }).tools).map(t => t.name);
    expect(names).toEqual(["a_one", "a_two", "b_one"]);
  });

  it("returns empty list when no backends are registered", async () => {
    const route = new McpEdgeRoute([]);
    const res = await postMcp(route, { jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect((res.result as { tools: McpTool[] }).tools).toEqual([]);
  });

  it("rejects construction when two backends advertise the same tool name", () => {
    const a = new FakeBackend("a_", [tool("dup")]);
    const b = new FakeBackend("b_", [tool("dup")]);
    expect(() => new McpEdgeRoute([a, b])).toThrow(/duplicate tool name/i);
  });
});

// ── tools/call dispatch ───────────────────────────────────────────────────

describe("McpEdgeRoute tools/call dispatch", () => {
  it("routes to the first backend whose handles(name) is true", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => ({ from: "a" }));
    const b = new FakeBackend("b_", [tool("b_x")], async () => ({ from: "b" }));
    const route = new McpEdgeRoute([a, b]);

    await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "b_x", arguments: { k: 1 } }, id: 7,
    });
    expect(a.invocations).toEqual([]);
    expect(b.invocations).toEqual([{ name: "b_x", args: { k: 1 } }]);
  });

  it("wraps backend result as MCP content text", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => ({ count: 42 }));
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "a_x", arguments: {} }, id: 1,
    });
    const result = res.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ count: 42 });
  });

  it("returns -32601 for an unknown tool name", async () => {
    const a = new FakeBackend("a_", [tool("a_x")]);
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "z_unknown", arguments: {} }, id: 9,
    });
    expect(res.error?.code).toBe(-32601);
  });

  it("maps JsonRpcInvocationError to a structured JSON-RPC error", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => {
      throw new JsonRpcInvocationError(-32602, "bad arg");
    });
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "a_x", arguments: {} }, id: 3,
    });
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toBe("bad arg");
  });

  it("maps unexpected throws to -32603 internal error", async () => {
    const a = new FakeBackend("a_", [tool("a_x")], async () => { throw new Error("boom"); });
    const route = new McpEdgeRoute([a]);
    const res = await postMcp(route, {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "a_x", arguments: {} }, id: 4,
    });
    expect(res.error?.code).toBe(-32603);
  });
});

// ── HTTP method gating ─────────────────────────────────────────────────────

describe("McpEdgeRoute HTTP methods", () => {
  it("DELETE /mcp returns 405", async () => {
    const route = new McpEdgeRoute([]);
    const res = await route.handle(
      new Request("http://x/mcp", { method: "DELETE" }),
      fakeEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("GET /mcp returns SSE stream with init notification", async () => {
    const route = new McpEdgeRoute([]);
    const res = await route.handle(new Request("http://x/mcp"), fakeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain("protocolVersion");
    reader.cancel();
  });
});
