/**
 * MCP edge route — JSON-RPC over POST /mcp + SSE notifications over GET /mcp.
 *
 * Owns:
 *   - JSON-RPC lifecycle (initialize, ping, tools/list, tools/call)
 *   - tools/list aggregation across registered ToolBackends
 *   - tools/call dispatch to the first backend that handles(name)
 *   - SSE keep-alive stream for server-pushed notifications
 *
 * Does NOT own:
 *   - HTTP transport multiplexing (that is the Router's job)
 *   - any specific tool family — backends are passed in
 */

import type { EdgeRoute } from "../router.js";
import type { Env, JsonRpcRequest, JsonRpcResponse, McpTool } from "../types.js";
import { okResponse, errResponse } from "../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../backends.js";
import { pickAllowedOrigin } from "../cors.js";
import {
  leaseErrorResponse,
  verifyAndUpsertLease,
} from "./lease-middleware.js";
import {
  CaUnavailableError,
  getCABundle,
} from "../storage/ca-bundle-cache.js";
import { notmeBundleFetcher } from "../storage/notme-bundle-fetcher.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "cloister", version: "0.1.0" } as const;
const KEEPALIVE_MS = 15_000;

export class McpEdgeRoute implements EdgeRoute {
  constructor(private readonly backends: readonly ToolBackend[]) {
    assertNoDuplicateToolNames(backends);
  }

  match(request: Request): boolean {
    return new URL(request.url).pathname === "/mcp";
  }

  async handle(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET")  return handleSse(request, env);
    if (request.method === "POST") return this.handlePost(request, env);
    return new Response("method not allowed", { status: 405 });
  }

  private async handlePost(request: Request, env: Env): Promise<Response> {
    const allowOrigin = pickAllowedOrigin(request, env.ALLOWED_ORIGINS);
    const nowMs = Date.now();

    // Read the body ONCE so we can both verify-against-canonical-bytes
    // and pass it as parsed JSON to dispatch. JSON-RPC §5: when the
    // request can't be parsed, id MUST be null.
    const bodyText = await request.text();
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(bodyText) as JsonRpcRequest;
    } catch {
      return Response.json(errResponse(null, -32700, "parse error"), {
        status: 400,
        headers: { "Access-Control-Allow-Origin": allowOrigin },
      });
    }

    // Lease verification — ADR-0007 always-on auth. Skipped entirely
    // when `INTERLACE_ROOT_PUBKEY` is unset (dev/test deployments;
    // production MUST have it set per ADR-0007 and the threat model).
    // The skip is at deployment-binding granularity, NOT per-request,
    // so this is not the `INTERLACE_DEV_BYPASS` the audit removed.
    if (env.INTERLACE_ROOT_PUBKEY) {
      const verifyResult = await this.verifyLease(request, bodyText, req, env, nowMs);
      if (verifyResult) return withCors(verifyResult, allowOrigin);
    }

    const out = await this.dispatch(req, env);
    return Response.json(out, {
      headers: { "Access-Control-Allow-Origin": allowOrigin },
    });
  }

  /**
   * Run the lease pipeline. Returns a `Response` if the request was
   * REJECTED (caller should return it as-is) or `undefined` if the
   * request passed verification (caller continues to dispatch).
   */
  private async verifyLease(
    request: Request,
    body:    string,
    req:     JsonRpcRequest,
    env:     Env,
    nowMs:   number,
  ): Promise<Response | undefined> {
    let bundle;
    try {
      bundle = await getCABundle(notmeBundleFetcher(env), nowMs, {
        rootPubkey: env.INTERLACE_ROOT_PUBKEY,
      });
    } catch (err) {
      if (err instanceof CaUnavailableError) {
        return leaseErrorResponse(req.id, -32005, "CA bundle unavailable");
      }
      throw err;
    }

    const verdict = await verifyAndUpsertLease({
      req:    request,
      body,
      id:     req.id,
      method: req.method,
      params: req.params,
      env,
      bundle,
      nowMs,
    });
    if ("code" in verdict) {
      return leaseErrorResponse(req.id, verdict.code, verdict.message);
    }
    return undefined;
  }

  private async dispatch(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
    switch (req.method) {
      case "initialize":
        return okResponse(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "tools/list":
        await Promise.all(this.backends.map(b => b.refreshTools?.(env)));
        return okResponse(req.id, { tools: this.allTools() });
      case "tools/call":
        return this.callTool(req, env);
      case "ping":
        return okResponse(req.id, {});
      default:
        return errResponse(req.id, -32601, `method not found: ${req.method}`);
    }
  }

  /**
   * Aggregate tools across backends. First-registered wins on name collision,
   * which lets Derived (dynamic) tools coexist with Asserted ones (ADR-0006):
   * the manifest order pins the precedence.
   */
  private allTools(): McpTool[] {
    const seen = new Set<string>();
    const out: McpTool[] = [];
    for (const b of this.backends) {
      for (const t of b.tools()) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }

  private async callTool(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
    const params = req.params as { name: string; arguments?: Record<string, unknown> };
    const name = params.name;
    const args = params.arguments ?? {};
    const backend = this.backends.find(b => b.handles(name));
    if (!backend) return errResponse(req.id, -32601, `unknown tool: ${name}`);
    try {
      const result = await backend.invoke(name, args, env);
      return okResponse(req.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      if (e instanceof JsonRpcInvocationError) return errResponse(req.id, e.code, e.message);
      return errResponse(req.id, -32603, e instanceof Error ? e.message : String(e));
    }
  }
}

// ── SSE handler ────────────────────────────────────────────────────────────

function handleSse(request: Request, env: Env): Response {
  const allowOrigin = pickAllowedOrigin(request, env.ALLOWED_ORIGINS);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const init: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} } },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(init)}\n\n`));
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); }
        catch { clearInterval(keepAlive); }
      }, KEEPALIVE_MS);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
    },
  });
}

// ── CORS helper for lease-error responses ─────────────────────────────────

function withCors(res: Response, allowOrigin: string): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  return new Response(res.body, { status: res.status, headers });
}

// ── Validation ────────────────────────────────────────────────────────────

function assertNoDuplicateToolNames(backends: readonly ToolBackend[]): void {
  const seen = new Set<string>();
  for (const b of backends) {
    for (const t of b.tools()) {
      if (seen.has(t.name)) {
        throw new Error(`duplicate tool name across backends: ${t.name}`);
      }
      seen.add(t.name);
    }
  }
}
