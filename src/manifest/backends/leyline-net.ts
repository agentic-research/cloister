/**
 * leyline-net ToolBackend — wires the capnp codec into the cloister↔companion
 * IPC seam.
 *
 * Per ADR-0005 + its 2026-04-30 amendment: the cloister↔companion hop is
 * IPC over loopback HTTP, NOT full leyline-net wire. The HTTP body is a
 * plain capnp `ToolCall` going out, plain capnp `ToolResult` coming back.
 * No Manifest envelope, no AEAD, no signing — those guarantees live at
 * cloister-companion's egress face (companion↔backend), where bytes
 * actually traverse a network.
 *
 * Flow:
 *
 *   1. Build a ToolCall {upstreamId, toolName, argumentsJson} where
 *      argumentsJson is the canonical JSON encoding of the MCP tool args.
 *   2. Capnp-encode it via `src/wire/tool-call.ts`.
 *   3. POST the bytes to `env[companionUrlBinding]`. Content-type
 *      `application/x-capnp; type=ToolCall`.
 *   4. Read response bytes; decode as capnp ToolResult via
 *      `src/wire/tool-result.ts`.
 *   5. Surface the result up to the MCP edge:
 *        - isError=true            → throw JsonRpcInvocationError(-32000)
 *        - single text item        → JSON.parse(text) || raw text
 *        - other shapes            → return the content array verbatim
 *      (the edge wraps the return value as MCP content[0].text by default;
 *       single-text fast-path matches McpProxyToolBackend's behavior so
 *       leyline-net and HTTP backends look identical to clients)
 */

import type { Env, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { LeylineNetBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";
import { canonical, type CanonicalValue } from "../../storage/canonical.js";
import { encodeToolCall } from "../../wire/tool-call.js";
import { decodeToolResult, type ToolResult, type Content } from "../../wire/tool-result.js";

type FetchFn = typeof fetch;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

export class LeylineNetToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];
  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: LeylineNetBackend,
    private readonly handlesPrefix: string,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {
    this.toolList = toolsFromSpecs(spec.tools);
    this.toolNames = new Set(this.toolList.map(t => t.name));
  }

  tools(): McpTool[] { return this.toolList; }

  /** Empty prefix → exact-match; non-empty → prefix-match. */
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
    const url = (env as unknown as Record<string, string>)[this.spec.companionUrlBinding];
    if (!url) {
      throw new JsonRpcInvocationError(
        -32603,
        `manifest: ${this.spec.companionUrlBinding} not configured — cannot route ${this.handlesPrefix || toolName}* calls`,
      );
    }

    // Encode the call. canonical() already validates input shape (no
    // functions/symbols, no NaN/Infinity).
    const argumentsJson = canonical(args as CanonicalValue);
    const requestBytes = encodeToolCall({
      upstreamId: this.spec.upstreamId,
      toolName,
      argumentsJson,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method:  "POST",
        headers: { "Content-Type": "application/x-capnp; type=ToolCall" },
        body:    requestBytes,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `companion unreachable: ${msg}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const snippet = body.length > 200 ? body.slice(0, 200) + "…" : body;
      throw new JsonRpcInvocationError(
        -32603,
        snippet ? `companion HTTP ${res.status}: ${snippet}` : `companion HTTP ${res.status}`,
      );
    }

    let respBytes: Uint8Array;
    try {
      respBytes = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `companion returned non-binary body: ${msg}`);
    }

    let result: ToolResult;
    try {
      result = decodeToolResult(respBytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `companion response not valid capnp ToolResult: ${msg}`);
    }

    if (result.isError) {
      throw new JsonRpcInvocationError(-32000, errorMessageFromContent(result.content, toolName));
    }

    // Single text content → parse-as-JSON-or-raw-text fast path.
    // Mirrors McpProxyToolBackend's behavior so the same upstream surfaces
    // identically to clients regardless of which backend kind cloister uses.
    if (result.content.length === 1 && result.content[0]!.kind === "text") {
      const text = (result.content[0] as { kind: "text"; text: string }).text;
      try {
        return text === "" ? null : JSON.parse(text);
      } catch {
        return text;
      }
    }

    // Multiple or non-text content: return the full content array, with
    // binary/resource bytes base64-encoded so JSON.stringify (in the edge)
    // doesn't lose them.
    return result.content.map(contentToJsonShape);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function errorMessageFromContent(content: readonly Content[], toolName: string): string {
  // Prefer the first text item's content as the error message. If the upstream
  // emitted JSON {"error": "..."} we surface that string; otherwise we surface
  // the raw text. Falls back to a generic message if the content array is
  // empty or has no text items.
  for (const c of content) {
    if (c.kind === "text") {
      const parsed = tryJsonParse(c.text);
      if (parsed && typeof parsed === "object" && "error" in (parsed as object)) {
        return String((parsed as { error: unknown }).error);
      }
      return c.text;
    }
  }
  return `tool ${toolName} failed`;
}

function tryJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

function contentToJsonShape(c: Content): unknown {
  switch (c.kind) {
    case "text":     return { type: "text", text: c.text };
    case "binary":   return { type: "image", data: bytesToBase64(c.binary.data), mimeType: c.binary.mimeType };
    case "resource": return { type: "resource", text: TEXT_DECODER.decode(c.resource), bytes: bytesToBase64(c.resource) };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  // workerd has btoa.
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
