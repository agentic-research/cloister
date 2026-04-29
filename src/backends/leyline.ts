/**
 * LeylineLifecycleBackend — daemon lifecycle ops on the LLO MCP HTTP port.
 *
 * Mirrors LspToolBackend in shape (same fetcher pattern, same error mapping)
 * but exposes a small set of *non-LSP* leyline tools that the cloister CC
 * plugin (cloister-acbf27) needs to keep LLO's view fresh during a session:
 *
 *   reparse  — re-run tree-sitter (whole tree or a single file via `source`)
 *   enrich   — run an enrichment pass (`pass: "lsp" | "embed" ...`) over files
 *   status   — daemon phase + last-reparse timestamp + per-pass enrichment state
 *
 * Why a sibling backend rather than extending LspToolBackend: the prefix-based
 * routing in McpEdgeRoute keeps tool families orthogonal. `lsp_*` semantics
 * (read LSP info) and lifecycle semantics (mutate LLO state) are different
 * shapes; lumping them under one prefix would couple unrelated concerns.
 *
 * Schemas mirror ll-open/cli-lib/src/daemon/mcp.rs registrations. If LLO's
 * surface drifts, regenerate from `tools/list` rather than hand-edit here.
 */

import type { Env, JsonRpcResponse, McpTool } from "../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../backends.js";

// ── Tool definitions ───────────────────────────────────────────────────────

export const LEYLINE_LIFECYCLE_TOOLS: McpTool[] = [
  {
    name: "reparse",
    description: "Re-run tree-sitter parsing over the source tree (or a single file via `source`).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source dir or single file; falls back to daemon --source" },
        lang:   { type: "string", description: "Optional language filter" },
      },
    },
  },
  {
    name: "enrich",
    description: "Run an enrichment pass (e.g. `lsp`, `embed`) optionally scoped to specific files.",
    inputSchema: {
      type: "object",
      properties: {
        pass:  { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["pass"],
    },
  },
  {
    name: "status",
    description: "Daemon lifecycle status: phase, head_sha, last_reparse_at_ms, per-pass enrichment.",
    inputSchema: { type: "object", properties: {} },
  },
];

const HANDLED = new Set(LEYLINE_LIFECYCLE_TOOLS.map(t => t.name));

// ── Backend ────────────────────────────────────────────────────────────────

interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** See lsp.ts for why fetch is wrapped at the default rather than stored bare. */
type FetchFn = typeof fetch;

export class LeylineLifecycleBackend implements ToolBackend {
  constructor(
    private readonly toolDefs: McpTool[] = LEYLINE_LIFECYCLE_TOOLS,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {}

  tools(): McpTool[] { return this.toolDefs; }

  handles(toolName: string): boolean { return HANDLED.has(toolName); }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
  ): Promise<unknown> {
    const url = env.LLO_MCP_URL;
    if (!url) {
      throw new JsonRpcInvocationError(
        -32603,
        "LLO_MCP_URL not configured — cannot route lifecycle ops",
      );
    }

    const innerReq = {
      jsonrpc: "2.0" as const,
      id: 0,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(innerReq),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `LLO unreachable: ${msg}`);
    }

    if (!res.ok) {
      throw new JsonRpcInvocationError(-32603, `LLO returned HTTP ${res.status}`);
    }

    let body: JsonRpcResponse;
    try {
      body = (await res.json()) as JsonRpcResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `LLO response not JSON: ${msg}`);
    }

    if (body.error) {
      throw new JsonRpcInvocationError(body.error.code, body.error.message);
    }

    const result = body.result as McpToolResult | undefined;
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      throw new JsonRpcInvocationError(-32603, "LLO returned no MCP content");
    }

    const text = result.content[0]!.text ?? "";
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (result.isError) {
      const err =
        parsed && typeof parsed === "object" && "error" in (parsed as object)
          ? String((parsed as { error: unknown }).error)
          : `tool ${toolName} failed`;
      throw new JsonRpcInvocationError(-32000, err);
    }

    return parsed;
  }
}
