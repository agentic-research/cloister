/**
 * MCP tool backends — inner dispatch layer for the MCP edge route.
 *
 * A ToolBackend self-advertises a list of MCP tools via `tools()` and answers
 * `handles(name)` for the names it claims (typically a name-prefix check). The
 * MCP edge aggregates `tools()` for `tools/list` and dispatches `tools/call`
 * to the first backend whose `handles` returns true.
 *
 * Backends receive `env` only at `invoke` time — they never capture env at
 * construction. This preserves the unforgeable-reference property of workerd
 * service bindings: a backend cannot reach a binding it was not handed.
 *
 * Failures are signalled by throwing JsonRpcInvocationError(code, message).
 * Unknown throws map to JSON-RPC -32603 (internal error) by the edge.
 */

import type { Env, McpTool } from "./types.js";

export interface ToolBackend {
  tools(): McpTool[];
  handles(toolName: string): boolean;
  /**
   * Invoke a tool. The optional `peerFp` carries the calling peer's
   * fingerprint from the verified lease (or the anonymous sentinel in
   * dev/test mode). HttpForward backends thread this into the reverse-RPC
   * handler so upstream `roots/list` requests answer with the right
   * peer's filesystem-roots cache. Static / non-MCP backends ignore it.
   */
  invoke(toolName: string, args: Record<string, unknown>, env: Env, peerFp?: string): Promise<unknown>;
  /**
   * Optional pre-`tools/list` hook for backends with Derived schemas
   * (ADR-0006). The MCP edge calls this on every backend before
   * aggregating `tools/list`; static backends omit it. Should be cheap on
   * the hot path: implementations cache with a TTL and dedupe concurrent
   * calls. Errors are swallowed — Asserted catalog stays as fallback.
   */
  refreshTools?(env: Env): Promise<void>;
}

export class JsonRpcInvocationError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcInvocationError";
  }
}
