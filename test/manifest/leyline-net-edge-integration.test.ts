/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { McpEdgeRoute } from "../../src/routes/mcp.js";
import { LeylineNetToolBackend } from "../../src/manifest/backends/leyline-net.js";
import type { Env, JsonRpcResponse } from "../../src/types.js";
import { encodeToolResult } from "../../src/wire/tool-result.js";
import { decodeToolCall } from "../../src/wire/tool-call.js";

/**
 * Phase 2D-wire end-to-end integration (cloister-5183bc, iteration 11).
 *
 * The unit tests in `leyline-net-backend.test.ts` cover the backend's
 * internal behavior. This file proves the WIRE-UP through `McpEdgeRoute`:
 * a JSON-RPC tools/call at the public face dispatches to the leylineNet
 * backend, capnp bytes flow over (stubbed) HTTP to the "companion", and
 * the result surfaces back as MCP-shaped JSON-RPC.
 *
 * Tests skip the manifest runtime layer (unit-tested in
 * `runtime.test.ts`) and construct backends directly so the stubbed
 * fetcher can be injected through `LeylineNetToolBackend`'s constructor.
 */

const bin = (b: Uint8Array): BodyInit => b as unknown as BodyInit;

function envWith(url: string): Env {
  return { COMPANION_URL: url, CLOISTER_MODE: "dev" } as unknown as Env;  // ADR-0053: dev opt-out
}

function postMcp(route: McpEdgeRoute, body: unknown, env: Env): Promise<Response> {
  return route.handle(
    new Request("http://x/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

const BASE_SPEC = {
  companionUrlBinding: "COMPANION_URL",
  upstreamId:          "rosary",
  tools: [
    { name: "rsry_status", description: "rosary status", inputSchemaJson: '{"type":"object"}' },
    { name: "rsry_search", description: "search beads",  inputSchemaJson: '{"type":"object"}' },
  ],
} as const;

// ── Public face → leylineNet backend → public face ────────────────────────

describe("McpEdgeRoute + LeylineNetToolBackend integration", () => {
  it("tools/list aggregates leylineNet tools alongside other backends", async () => {
    const upstream = encodeToolResult({ content: [{ kind: "text", text: "{}" }], isError: false });
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_", () => Promise.resolve(new Response(bin(upstream))));
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(route, { jsonrpc: "2.0", method: "tools/list", id: 1 }, envWith("http://x/"));
    const body = (await res.json()) as JsonRpcResponse;
    const tools = (body.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    expect(tools).toEqual(// Sorted by name (2026-07-28 deterministic-ordering SHOULD) — this used
      // to pin registration order.
      ["rsry_search", "rsry_status"]);
  });

  it("tools/call: success surfaces upstream's text-content as MCP content[0].text", async () => {
    let captured: Uint8Array | null = null;
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: '{"phase":"ready","head_sha":"abc123"}' }],
      isError: false,
    });
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_", async (_url, init) => {
      captured = init?.body instanceof Uint8Array ? init.body :
                 init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) : null;
      return new Response(bin(upstream));
    });
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(
      route,
      { jsonrpc: "2.0", method: "tools/call", params: { name: "rsry_status", arguments: {} }, id: 7 },
      envWith("http://companion/mcp"),
    );
    const body = (await res.json()) as JsonRpcResponse;
    const result = body.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    // McpEdgeRoute wraps backend.invoke()'s return as JSON.stringify(...).
    // LeylineNetToolBackend's single-text fast-path parses the upstream
    // text as JSON, so the wrapped string is its JSON serialization.
    expect(JSON.parse(result.content[0].text)).toEqual({ phase: "ready", head_sha: "abc123" });

    // Wire fidelity: capnp ToolCall on the wire carries upstreamId + toolName.
    expect(captured).not.toBeNull();
    const tc = decodeToolCall(captured!);
    expect(tc.upstreamId).toBe("rosary");
    expect(tc.toolName).toBe("rsry_status");
  });

  it("tools/call: passes args verbatim through canonical-JSON encoding", async () => {
    let captured: Uint8Array | null = null;
    const upstream = encodeToolResult({ content: [{ kind: "text", text: "{}" }], isError: false });
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_", async (_url, init) => {
      captured = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init!.body as ArrayBuffer);
      return new Response(bin(upstream));
    });
    const route = new McpEdgeRoute([backend]);
    await postMcp(
      route,
      {
        jsonrpc: "2.0", method: "tools/call",
        params: { name: "rsry_search", arguments: { query: "foo", repo: "bar" } },
        id: 1,
      },
      envWith("http://x/"),
    );
    const tc = decodeToolCall(captured!);
    expect(new TextDecoder().decode(tc.argumentsJson)).toBe('{"query":"foo","repo":"bar"}');
  });

  it("tools/call: isError=true from upstream → JSON-RPC error -32000", async () => {
    const upstream = encodeToolResult({
      content: [{ kind: "text", text: '{"error":"bead not found: xyz"}' }],
      isError: true,
    });
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_", () => Promise.resolve(new Response(bin(upstream))));
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(
      route,
      { jsonrpc: "2.0", method: "tools/call", params: { name: "rsry_status", arguments: {} }, id: 1 },
      envWith("http://x/"),
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error).toEqual({ code: -32000, message: "bead not found: xyz" });
    expect(body.result).toBeUndefined();
  });

  it("tools/call: companion HTTP 502 → JSON-RPC error -32603 with status snippet", async () => {
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_", () =>
      Promise.resolve(new Response("companion is down", { status: 502 })),
    );
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(
      route,
      { jsonrpc: "2.0", method: "tools/call", params: { name: "rsry_status", arguments: {} }, id: 1 },
      envWith("http://x/"),
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain("HTTP 502");
  });

  it("tools/call: companion network failure → JSON-RPC error -32603 'unreachable'", async () => {
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_",
      () => Promise.reject(new Error("ECONNREFUSED")),
    );
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(
      route,
      { jsonrpc: "2.0", method: "tools/call", params: { name: "rsry_status", arguments: {} }, id: 1 },
      envWith("http://x/"),
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toMatch(/unreachable/);
  });

  it("tools/call: COMPANION_URL not configured → JSON-RPC error -32603", async () => {
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_",
      () => { throw new Error("fetcher should not be called when URL is missing"); },
    );
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(
      route,
      { jsonrpc: "2.0", method: "tools/call", params: { name: "rsry_status", arguments: {} }, id: 1 },
      { CLOISTER_MODE: "dev" } as Env,  // no COMPANION_URL (ADR-0053 dev opt-out)
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain("COMPANION_URL");
  });

  it("tools/call: unknown tool name (not handled by any backend) → JSON-RPC error -32601", async () => {
    const upstream = encodeToolResult({ content: [{ kind: "text", text: "{}" }], isError: false });
    const backend = new LeylineNetToolBackend(BASE_SPEC, "rsry_", () => Promise.resolve(new Response(bin(upstream))));
    const route = new McpEdgeRoute([backend]);

    const res = await postMcp(
      route,
      { jsonrpc: "2.0", method: "tools/call", params: { name: "bead_create", arguments: {} }, id: 1 },
      envWith("http://x/"),
    );
    const body = (await res.json()) as JsonRpcResponse;
    expect(body.error?.code).toBe(-32601);
  });
});
