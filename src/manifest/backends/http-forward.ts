/**
 * Generic HTTP-forwarding ToolBackend, parameterized by spec.
 *
 * Spec fields (from manifest/cloister.capnp):
 *   - `urlBinding` — name of the text-var binding holding the upstream URL
 *   - `tools`      — full McpTool list this backend advertises
 *
 * Forwards `tools/call` JSON-RPC verbatim to the upstream MCP HTTP endpoint;
 * unwraps `content[0].text` as JSON when possible, falling back to raw text
 * for upstreams that emit prose. isError responses surface as -32000.
 *
 * Fetch-injection pattern: tests pass a stub fetcher; production uses the
 * global `fetch` wrapped to preserve `this` binding under workerd.
 */

import type { Env, JsonRpcResponse, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { HttpForwardBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";

type FetchFn = typeof fetch;

interface UpstreamMcpResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class HttpForwardToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];

  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: HttpForwardBackend,
    private readonly handlesPrefix: string,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {
    this.toolList = toolsFromSpecs(spec.tools);
    this.toolNames = new Set(this.toolList.map(t => t.name));
  }

  tools(): McpTool[] { return this.toolList; }

  /**
   * Empty prefix → exact-match against advertised tool names.
   * Non-empty prefix → standard prefix match.
   */
  handles(toolName: string): boolean {
    return this.handlesPrefix === ""
      ? this.toolNames.has(toolName)
      : toolName.startsWith(this.handlesPrefix);
  }

  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    env: Env,
  ): Promise<unknown> {
    const url = (env as unknown as Record<string, string>)[this.spec.urlBinding];
    if (!url) {
      throw new JsonRpcInvocationError(
        -32603,
        `manifest: ${this.spec.urlBinding} not configured — cannot route ${this.handlesPrefix}* calls`,
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
        headers: {
          "Content-Type": "application/json",
          // MCP Streamable HTTP servers (e.g. rsry's axum impl) require
          // both formats in Accept; servers that don't care (leyline) just
          // ignore it. Sending both is always correct.
          "Accept":       "application/json, text/event-stream",
        },
        body: JSON.stringify(innerReq),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `upstream unreachable: ${msg}`);
    }

    if (!res.ok) {
      // Drain the body so workerd doesn't leak a half-read response.
      // Include a short snippet in the error for debuggability; truncate
      // so a giant 500 page doesn't drown the log.
      const body = await res.text().catch(() => "");
      const snippet = body.length > 200 ? body.slice(0, 200) + "…" : body;
      throw new JsonRpcInvocationError(
        -32603,
        snippet ? `upstream returned HTTP ${res.status}: ${snippet}` : `upstream returned HTTP ${res.status}`,
      );
    }

    let body: JsonRpcResponse;
    try {
      body = (await res.json()) as JsonRpcResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `upstream response not JSON: ${msg}`);
    }

    if (body.error) {
      throw new JsonRpcInvocationError(body.error.code, body.error.message);
    }

    const result = body.result as UpstreamMcpResult | undefined;
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      throw new JsonRpcInvocationError(-32603, "upstream returned no MCP content");
    }

    const text = result.content[0]!.text ?? "";
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // Non-JSON text — pass through raw. Some MCP servers may emit prose.
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
