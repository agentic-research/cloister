/**
 * cloister — portable MCP gateway via Cloudflare Workers / workerd.
 *
 * Exposes an MCP Streamable HTTP endpoint that:
 *   POST /mcp   — receive JSON-RPC tool calls, respond immediately or via SSE
 *   GET  /mcp   — open an SSE stream; server pushes notifications here
 *
 * SSE format is standard text/event-stream — compatible with any MCP client
 * regardless of language (Rust, Go, Python, TypeScript, etc.):
 *
 *   data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n
 *
 * Tool routing:
 *   bead_*  → BeadStore Durable Object (one per repo, native SQLite)
 *   (future) mache_*, crumb_* → proxy to local backends via service bindings
 */

import type { Env, JsonRpcRequest, JsonRpcResponse, McpTool } from "./types.js";
import { okResponse, errResponse } from "./types.js";
export { BeadStore } from "./beads.js";

// ── MCP tool registry ─────────────────────────────────────────────────────

const TOOLS: McpTool[] = [
  {
    name: "bead_create",
    description: "Create a new bead (work item) in the store for the given repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string", description: "Absolute path to the repo." },
        title:       { type: "string", description: "Short title for the bead." },
        description: { type: "string", description: "Detailed description." },
        priority:    { type: "integer", description: "0=none 1=low 2=medium 3=high 4=urgent.", enum: [0,1,2,3,4] },
        labels:      { type: "array", items: { type: "string" } },
        created_by:  { type: "string", description: "Git username of creator." },
      },
      required: ["repo", "title"],
    },
  },
  {
    name: "bead_update",
    description: "Update fields on an existing bead.",
    inputSchema: {
      type: "object",
      properties: {
        repo:        { type: "string" },
        id:          { type: "string" },
        title:       { type: "string" },
        description: { type: "string" },
        state:       { type: "string", enum: ["open","in_progress","done","blocked"] },
        priority:    { type: "integer", enum: [0,1,2,3,4] },
        labels:      { type: "array", items: { type: "string" } },
        notes:       { type: "string", description: "JSON blob for provenance / extras." },
      },
      required: ["repo", "id"],
    },
  },
  {
    name: "bead_search",
    description: "Full-text search beads by title/description.",
    inputSchema: {
      type: "object",
      properties: {
        repo:  { type: "string" },
        query: { type: "string" },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "bead_list",
    description: "List beads, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        repo:  { type: "string" },
        state: { type: "string", enum: ["open","in_progress","done","blocked"] },
      },
      required: ["repo"],
    },
  },
  {
    name: "bead_close",
    description: "Mark a bead as done.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        id:   { type: "string" },
      },
      required: ["repo", "id"],
    },
  },
  {
    name: "bead_comment",
    description: "Add a comment to a bead.",
    inputSchema: {
      type: "object",
      properties: {
        repo:   { type: "string" },
        id:     { type: "string" },
        body:   { type: "string" },
        author: { type: "string" },
      },
      required: ["repo", "id", "body"],
    },
  },
];

// ── Main Worker ───────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (request.method === "GET")  return handleSse(request, env);
      if (request.method === "POST") return handlePost(request, env);
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "cloister" });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ── SSE endpoint (GET /mcp) ───────────────────────────────────────────────
//
// MCP Streamable HTTP: client opens GET /mcp and keeps the connection alive.
// Server pushes JSON-RPC notifications as SSE events.
//
// Event format (standard text/event-stream, per W3C SSE spec):
//   data: <json>\n\n
//
// Cross-language compat: any SSE reader (EventSource in JS/Python/Go/Rust)
// can consume this without MCP-specific libraries.

function handleSse(_request: Request, _env: Env): Response {
  const encoder = new TextEncoder();

  // ReadableStream<Uint8Array> — the correct type for Workers SSE.
  // Any EventSource consumer (browser, Python httpx, Go eventsource, Rust eventsource-client)
  // reads the raw bytes and parses the standard `data: ...\n\n` framing.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Announce capabilities on connect (MCP handshake notification)
      const initNotification: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
      };
      controller.enqueue(encoder.encode(sseEvent(initNotification)));

      // Keep-alive comment line every 15s so proxies / LBs don't time out.
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ── JSON-RPC POST handler ─────────────────────────────────────────────────

async function handlePost(request: Request, env: Env): Promise<Response> {
  let req: JsonRpcRequest;
  try {
    req = await request.json<JsonRpcRequest>();
  } catch {
    return Response.json(errResponse(0, -32700, "parse error"), { status: 400 });
  }

  const res = await routeMethod(req, env);
  return Response.json(res, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

async function routeMethod(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  switch (req.method) {
    // ── MCP lifecycle ──────────────────────────────────────────────────
    case "initialize":
      return okResponse(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cloister", version: "0.1.0" },
      });

    case "tools/list":
      return okResponse(req.id, { tools: TOOLS });

    case "tools/call":
      return handleToolCall(req, env);

    // ── Ping ───────────────────────────────────────────────────────────
    case "ping":
      return okResponse(req.id, {});

    default:
      return errResponse(req.id, -32601, `method not found: ${req.method}`);
  }
}

// ── Tool dispatch ─────────────────────────────────────────────────────────

async function handleToolCall(req: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  const params = req.params as { name: string; arguments?: Record<string, unknown> };
  const toolName = params.name;
  const args     = params.arguments ?? {};

  // All bead_* tools route to BeadStore DO keyed by repo path.
  if (toolName.startsWith("bead_")) {
    const repo = String(args.repo ?? "");
    if (!repo) return errResponse(req.id, -32602, "repo is required for bead tools");

    const stub = beadStoreFor(repo, env);
    const innerReq: JsonRpcRequest = { jsonrpc: "2.0", method: toolName, params: args, id: req.id };
    const res  = await stub.fetch(new Request("https://internal/", {
      method: "POST",
      body:   JSON.stringify(innerReq),
      headers: { "Content-Type": "application/json" },
    }));
    const inner = await res.json<JsonRpcResponse>();

    // Unwrap and re-wrap so the tool call result is in MCP's content format
    if (inner.error) {
      return errResponse(req.id, inner.error.code, inner.error.message);
    }
    return okResponse(req.id, {
      content: [{ type: "text", text: JSON.stringify(inner.result, null, 2) }],
    });
  }

  return errResponse(req.id, -32601, `unknown tool: ${toolName}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Return the BeadStore DO stub for a given repo path.
 * The DO name is the repo path itself — stable, human-readable, one-per-repo.
 */
function beadStoreFor(repoPath: string, env: Env): DurableObjectStub {
  const id = env.BEAD_STORE.idFromName(repoPath);
  return env.BEAD_STORE.get(id);
}
