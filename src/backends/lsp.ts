/**
 * LspToolBackend — `lsp_*` MCP tools backed by the LLO daemon's HTTP MCP
 * transport (see `leyline-cli-lib/src/daemon/mcp.rs`).
 *
 * LLO exposes its existing UDS ops as MCP tools at `${LLO_MCP_URL}` once the
 * daemon is started with `--mcp-port <PORT>`. cloister forwards `lsp_*` calls
 * verbatim — same name, same arguments — and unwraps the MCP `content[0].text`
 * payload back into raw JSON so the McpEdgeRoute can re-wrap it canonically.
 *
 * Failure mapping:
 *   - JSON-RPC `error` from LLO  → `JsonRpcInvocationError(error.code, message)`
 *   - LLO's `isError: true`      → `JsonRpcInvocationError(-32000, inner.error)`
 *   - Network / unparseable      → `JsonRpcInvocationError(-32603, ...)`
 *
 * In production, `LLO_MCP_URL` should point at notme-proxy on a UDS-backed
 * HTTP endpoint so traffic is attested. In dev it's a plain TCP URL — the
 * backend doesn't care which.
 */

import type { Env, JsonRpcResponse, McpTool } from "../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../backends.js";

// ── Tool definitions ───────────────────────────────────────────────────────
//
// Mirrors `tool_registry()` in leyline-cli-lib/src/daemon/mcp.rs. Kept in
// sync manually for now; the long-term plan is to fetch tools/list from LLO
// at startup, but that requires async construction or lazy aggregation.

const FILE_SCHEMA = {
  type: "object" as const,
  properties: { file: { type: "string" } },
  required: ["file"],
};

const POSITION_SCHEMA = {
  type: "object" as const,
  properties: {
    file: { type: "string" },
    line: { type: "integer", description: "Zero-based line." },
    col:  { type: "integer", description: "Zero-based column." },
  },
  required: ["file", "line", "col"],
};

export const LSP_TOOLS: McpTool[] = [
  {
    name: "lsp_hover",
    description:
      "Position-based LSP hover; resolves (file, line, col) to the node and returns hover text.",
    inputSchema: POSITION_SCHEMA,
  },
  {
    name: "lsp_defs",
    description: "Position-based LSP definitions.",
    inputSchema: POSITION_SCHEMA,
  },
  {
    name: "lsp_refs",
    description: "Position-based LSP references.",
    inputSchema: POSITION_SCHEMA,
  },
  {
    name: "lsp_symbols",
    description: "Document symbols for a file.",
    inputSchema: FILE_SCHEMA,
  },
  {
    name: "lsp_diagnostics",
    description:
      "Diagnostics for a file. LLO enriches on demand if the file hasn't been parsed yet.",
    inputSchema: FILE_SCHEMA,
  },
];

// ── Backend ────────────────────────────────────────────────────────────────

/** What an MCP `tools/call` result looks like coming back from LLO. */
interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Optional fetch override — exposed so tests can inject without spinning up a
 * real LLO daemon. Production code uses the global `fetch` in workerd.
 *
 * NOTE: storing `fetch` as a class field strips its `this` binding in
 * workerd, which raises "Illegal invocation" at call time. The default wraps
 * the global so it's always called with workerd's expected receiver.
 */
type FetchFn = typeof fetch;

export class LspToolBackend implements ToolBackend {
  constructor(
    private readonly toolDefs: McpTool[] = LSP_TOOLS,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {}

  tools(): McpTool[] { return this.toolDefs; }

  handles(toolName: string): boolean { return toolName.startsWith("lsp_"); }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
  ): Promise<unknown> {
    const url = env.LLO_MCP_URL;
    if (!url) {
      throw new JsonRpcInvocationError(
        -32603,
        "LLO_MCP_URL not configured — cannot route lsp_* calls",
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
      throw new JsonRpcInvocationError(
        -32603,
        `LLO returned HTTP ${res.status}`,
      );
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

    // LLO's `result` is an MCP tool result: { content: [{type, text}], isError }.
    // Unwrap content[0].text (which is itself stringified JSON for our ops),
    // then surface isError as a JsonRpcInvocationError so the McpEdgeRoute
    // returns a JSON-RPC error rather than a "successful" tool result.
    const result = body.result as McpToolResult | undefined;
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      throw new JsonRpcInvocationError(
        -32603,
        "LLO returned no MCP content",
      );
    }

    const text = result.content[0]!.text ?? "";
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON — pass through as raw text. Most LLO ops return JSON, but
      // we don't want to fail on a future op that returns prose.
      parsed = text;
    }

    if (result.isError) {
      const err =
        (parsed && typeof parsed === "object" && "error" in (parsed as object))
          ? String((parsed as { error: unknown }).error)
          : `tool ${toolName} failed`;
      throw new JsonRpcInvocationError(-32000, err);
    }

    return parsed;
  }
}
