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
import type { OriginSet } from "./wire/origin.js";

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
  /**
   * Optional cache metadata from the backend's last refresh (SEP-2549 /
   * cloister-db6ac8). For proxy backends this is whatever the UPSTREAM's
   * tools/list declared; the MCP edge merges across backends by taking the
   * MINIMUM ttlMs — serving one backend's entries past the freshness it
   * declared is a correctness bug — and never widens cacheScope beyond
   * "private". Backends without an opinion omit the method.
   */
  cacheMeta?(): { ttlMs?: number; cacheScope?: "public" | "private" } | undefined;
  /**
   * The content-origin set for what this backend ingests (ADR-0065 phase 2,
   * threat model §21). Optional — a backend that serves only content cloister
   * itself composed has no ingress and omits it.
   *
   * A property of the BACKEND, not of a call: an `mcpProxy` always dials the
   * same operator-declared endpoint, so the origin does not vary per invocation
   * and does not need to ride the `invoke()` return (which is `unknown`, and
   * threading provenance through it would put a trust fact in a channel with no
   * shape).
   *
   * What it means is narrow, deliberately: cloister dialled THIS ENDPOINT. It is
   * not a claim about the bytes returned. An upstream that itself relays content
   * has origins of its own, and until it propagates them cloister's set is
   * incomplete — which must present as origin-asserted, never as attestation of
   * the part cloister never saw (§21.1).
   */
  contentOrigin?(env: Env): OriginSet;
}

export class JsonRpcInvocationError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcInvocationError";
  }
}
