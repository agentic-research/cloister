/**
 * Generic service-binding ToolBackend — for MCP tools whose upstream is
 * another workerd Worker exposed via a Fetcher binding.
 *
 * Same wire shape as HttpForwardToolBackend (POST tools/call JSON-RPC, unwrap
 * MCP content), but the upstream is a workerd `Fetcher`, so the call goes
 * through the service-binding RPC path with no network hop.
 */

import type { Env, JsonRpcResponse, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { ServiceBindingBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";

interface UpstreamMcpResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class ServiceBindingToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];

  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: ServiceBindingBackend,
    private readonly handlesPrefix: string,
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
    const fetcher = (env as unknown as Record<string, Fetcher>)[this.spec.binding];
    if (!fetcher) {
      throw new JsonRpcInvocationError(
        -32603,
        `manifest: service binding "${this.spec.binding}" not present in env`,
      );
    }

    const innerReq = {
      jsonrpc: "2.0" as const,
      id: 0,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };

    const res = await fetcher.fetch("https://upstream/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(innerReq),
    });

    if (!res.ok) {
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
    try {
      return text === "" ? null : JSON.parse(text);
    } catch {
      return text;
    }
  }
}
