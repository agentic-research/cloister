/**
 * Generic HTTP-forwarding ToolBackend, parameterized by spec.
 *
 * Spec fields (from manifest/cloister.capnp):
 *   - `urlBinding`   — name of the text-var binding holding the upstream URL
 *   - `tools`        — Asserted catalog (overrides Derived on name collision)
 *   - `dynamicTools` — when true, fetch `tools/list` from upstream and merge
 *                      with Asserted (ADR-0006). Cached with a 60s TTL.
 *   - `stripPrefix`  — prefix stripped from tool names before forwarding
 *                      `tools/call`. Empty ⇒ no stripping.
 *
 * Forwards `tools/call` JSON-RPC verbatim to the upstream MCP HTTP endpoint
 * (after stripping `stripPrefix` from the name); unwraps `content[0].text`
 * as JSON when possible, falling back to raw text for upstreams that emit
 * prose. isError responses surface as -32000.
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

interface UpstreamToolsListResult {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

/**
 * TTL for Derived tool catalogs. 60 seconds is a deliberate compromise:
 * long enough to amortize the upstream `tools/list` round-trip across a
 * burst of `tools/list` calls (Claude Code re-lists periodically), short
 * enough that schema drift is detected within one cache window.
 */
const DERIVED_TTL_MS = 60_000;

export class HttpForwardToolBackend implements ToolBackend {
  private readonly assertedTools: McpTool[];

  private readonly assertedNames: Set<string>;

  /**
   * Derived cache, keyed by upstream tool name (the bare name on the wire,
   * before prepending `handlesPrefix` for advertisement). Empty until the
   * first successful `refreshTools()`; stays empty if the upstream is down.
   */
  private derivedByUpstreamName = new Map<string, McpTool>();

  private fetchedAt = 0;

  private inflight: Promise<void> | null = null;

  constructor(
    private readonly spec: HttpForwardBackend,
    private readonly handlesPrefix: string,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {
    this.assertedTools = toolsFromSpecs(spec.tools);
    this.assertedNames = new Set(this.assertedTools.map(t => t.name));
  }

  /**
   * Snapshot view: Asserted ⊕ Derived, with Asserted winning on name
   * collision. Static backends (`dynamicTools` falsy) return only Asserted —
   * unchanged behavior.
   */
  tools(): McpTool[] {
    if (!this.spec.dynamicTools) return this.assertedTools;

    const out = [...this.assertedTools];
    for (const [upstreamName, tool] of this.derivedByUpstreamName) {
      const advertisedName = this.handlesPrefix + upstreamName;
      if (this.assertedNames.has(advertisedName)) continue;
      out.push({ ...tool, name: advertisedName });
    }
    return out;
  }

  /**
   * Empty prefix → exact-match against Asserted ⊕ Derived names.
   * Non-empty prefix → standard prefix match (covers Derived names whose
   * advertised form starts with the prefix even before the cache populates).
   */
  handles(toolName: string): boolean {
    if (this.handlesPrefix !== "") return toolName.startsWith(this.handlesPrefix);
    if (this.assertedNames.has(toolName)) return true;
    return this.derivedByUpstreamName.has(toolName);
  }

  /**
   * Pre-`tools/list` hook. No-op for static backends. For dynamic backends:
   *   - cache fresh ⇒ return immediately
   *   - in-flight fetch ⇒ await it (concurrent dedupe)
   *   - otherwise ⇒ fetch upstream, populate cache; on failure leave cache
   *     untouched and let the next call retry
   */
  async refreshTools(env: Env): Promise<void> {
    if (!this.spec.dynamicTools) return;
    if (Date.now() - this.fetchedAt < DERIVED_TTL_MS) return;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchUpstreamTools(env)
      .catch(() => { /* leave cache stale; tools() returns Asserted fallback */ })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchUpstreamTools(env: Env): Promise<void> {
    const url = (env as unknown as Record<string, string>)[this.spec.urlBinding];
    if (!url) return;

    const innerReq = { jsonrpc: "2.0" as const, id: 0, method: "tools/list" };
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept":       "application/json, text/event-stream",
      },
      body: JSON.stringify(innerReq),
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      return;
    }

    let body: JsonRpcResponse | null = null;
    try { body = (await res.json()) as JsonRpcResponse; }
    catch { return; }
    if (!body || body.error) return;

    const result = body.result as UpstreamToolsListResult | undefined;
    if (!result || !Array.isArray(result.tools)) return;

    const next = new Map<string, McpTool>();
    for (const t of result.tools) {
      if (typeof t.name !== "string" || t.name === "") continue;
      next.set(t.name, {
        name:        t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: (t.inputSchema as McpTool["inputSchema"]) ?? {
          type: "object", properties: {}, required: [],
        },
      });
    }
    this.derivedByUpstreamName = next;
    this.fetchedAt = Date.now();
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

    const stripPrefix = this.spec.stripPrefix ?? "";
    const wireName = stripPrefix && toolName.startsWith(stripPrefix)
      ? toolName.slice(stripPrefix.length)
      : toolName;

    const innerReq = {
      jsonrpc: "2.0" as const,
      id:      0,
      method:  "tools/call",
      params:  { name: wireName, arguments: args },
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
