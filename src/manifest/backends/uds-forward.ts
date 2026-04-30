/**
 * UDS-forwarding ToolBackend — placeholder.
 *
 * workerd's outbound is HTTP-only, so a UDS upstream is realized in practice
 * by an external bridge (e.g. `notme-proxy`) that exposes itself as either a
 * service binding or HTTP URL on cloister's face. The honest expression of
 * that bridge is one of the other two backend kinds; this kind is reserved
 * for future inbound-UDS or capnp-RPC paths.
 *
 * Construction succeeds (so manifests can declare the kind) but invocation
 * throws — keeping the kind reserved without silently masquerading as
 * something it isn't.
 */

import type { Env, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { UdsForwardBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";

export class UdsForwardToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];

  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: UdsForwardBackend,
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
    _toolName: string,
    _args: Record<string, unknown>,
    _env: Env,
  ): Promise<unknown> {
    throw new JsonRpcInvocationError(
      -32603,
      `manifest: udsForward backend on socket "${this.spec.socketPath}" is not yet implemented; ` +
      `route via httpForward or serviceBinding to an external bridge instead`,
    );
  }
}
