/**
 * leyline-net ToolBackend — Phase 2D-skel placeholder.
 *
 * Reserves the `leylineNet` backend kind in the runtime registry and
 * advertises its tools via `tools/list`. Construction succeeds (so manifests
 * can declare the kind today); `invoke` throws `JsonRpcInvocationError(-32603)`
 * with a pointer to the tracking bead. The capnp codec + companion HTTP wire
 * land in subsequent iterations of cloister-5183bc:
 *
 *   - Phase 2D-skel  (this file) — reservation + stub
 *   - Phase 2D-codec — hand-rolled or library capnp encode/decode for
 *                       Manifest, ToolCall, ToolResult; round-trip tests
 *   - Phase 2D-wire  — wire backend uses the codec to talk to companion's
 *                       HTTP endpoint
 *   - Phase 2B       — the Rust companion binary itself
 *
 * Mirrors the shape of `UdsForwardToolBackend` (also a reserved-kind stub).
 *
 * See: docs/adr/0005-internal-wire-leyline-net.md, wire/cloister.capnp.
 */

import type { Env, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { LeylineNetBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";

export class LeylineNetToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];
  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: LeylineNetBackend,
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
      `manifest: leylineNet backend (companion=${this.spec.companionUrlBinding}, ` +
      `upstream=${this.spec.upstreamId}) is reserved but not yet wired; ` +
      `tracked in cloister-5183bc Phase 2D-codec / 2D-wire`,
    );
  }
}
