/**
 * Generic Durable-Object-backed ToolBackend, parameterized by spec.
 *
 * Generalizes BeadToolBackend (src/backends/bead.ts):
 *   - `binding`  — name of the DurableObjectNamespace binding
 *   - `keyArg`   — name of the tool argument used to derive the DO instance
 *                  (e.g. "repo", "session_id")
 *   - `tools`    — full McpTool list this backend advertises
 *
 * Dispatch is the same as BeadToolBackend's: forward the JSON-RPC inner
 * call to the DO; unwrap result, convert errors to JsonRpcInvocationError.
 *
 * Tool prefix matching uses the manifest's `handlesPrefix` (set at
 * construction by the runtime registry), not a hard-coded "bead_".
 */

import type { Env, JsonRpcRequest, JsonRpcResponse, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { DoBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";

export class DurableObjectToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];

  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: DoBackend,
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
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[this.spec.binding];
    if (!ns) {
      throw new JsonRpcInvocationError(
        -32603,
        `manifest: DO binding "${this.spec.binding}" not present in env`,
      );
    }
    const key = String(args[this.spec.keyArg] ?? "");
    if (!key) {
      throw new JsonRpcInvocationError(
        -32602,
        `${this.spec.keyArg} is required for ${this.handlesPrefix}* tools`,
      );
    }

    const stub = ns.get(ns.idFromName(key));
    const innerReq: JsonRpcRequest = {
      jsonrpc: "2.0", method: toolName, params: args, id: 0,
    };
    const res = await stub.fetch(new Request("https://internal/", {
      method:  "POST",
      body:    JSON.stringify(innerReq),
      headers: { "Content-Type": "application/json" },
    }));
    const body = await res.json<JsonRpcResponse>();
    if (body.error) {
      throw new JsonRpcInvocationError(body.error.code, body.error.message);
    }
    return body.result;
  }
}
