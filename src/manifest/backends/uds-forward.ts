/**
 * UDS-forwarding ToolBackend.
 *
 * Workerd Workers cannot dial Unix-domain sockets directly — the runtime
 * exposes HTTP fetch, service bindings, DO RPC, and outbound TCP via
 * `connect()`, but not `AF_UNIX`. Per ADR-0005 (and its 2026-04-30
 * amendment), the **cloister-companion** sidecar is the IPC seam: cloister
 * POSTs a capnp ToolCall over loopback HTTP to companion, and companion —
 * a Rust process with full kernel access — opens the actual UDS,
 * proxies the bytes, and returns the capnp ToolResult.
 *
 * Wire pattern mirrors `LeylineNetToolBackend` exactly:
 *
 *   1. Encode the call as a capnp `ToolCall`. `upstreamId` is the backend's
 *      tool-name prefix (or the explicit tool name when the prefix is
 *      empty) — companion uses it as an opaque routing tag for logs.
 *   2. POST the bytes to `env.COMPANION_URL` with content-type
 *      `application/x-capnp; type=ToolCall`. Two extra headers tell
 *      companion this is a UDS transport rather than the default
 *      network-bound leyline-net path:
 *         X-Cloister-Transport: uds
 *         X-Cloister-Socket-Path: <socketPath>
 *      Companion routes by these headers to a local `connect("AF_UNIX",
 *      socketPath)` and forwards the ToolCall bytes to the backend.
 *   3. Read the response, decode as capnp ToolResult, surface the result
 *      to the MCP edge.
 *
 * Companion ↔ UDS-backend bytes are **plain capnp** today (see
 * `docs/deployment/cluster-in-a-pod.md`: "capnp ToolCall over a Unix
 * Domain Socket, plain (no AEAD)"). Intra-pod UDS is inside the trust
 * boundary; AEAD on a same-host loopback hop within an apko image is
 * ceremony, not security. The full leyline-net wire (signed manifests +
 * AEAD) lives at companion↔off-platform-backend, where bytes actually
 * traverse a network.
 *
 * Why we don't need a `companionUrlBinding` field on the schema: the
 * cluster's companion endpoint is a singleton — one companion per
 * cloister-router. Reusing the well-known `COMPANION_URL` env binding
 * keeps the manifest's `UdsForwardBackend` shape unchanged (no schema
 * evolution needed) and matches how operators configure the leyline-net
 * path.
 */

import type { Env, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { UdsForwardBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";
import { canonical, type CanonicalValue } from "../../storage/canonical.js";
import { encodeToolCall } from "../../wire/tool-call.js";
import { decodeToolResult, type ToolResult, type Content } from "../../wire/tool-result.js";

type FetchFn = typeof fetch;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/**
 * Well-known env binding for the companion endpoint. Singleton per
 * cluster — see file-header rationale.
 */
const COMPANION_URL_BINDING = "COMPANION_URL";

export class UdsForwardToolBackend implements ToolBackend {
  private readonly toolList: McpTool[];

  private readonly toolNames: Set<string>;

  constructor(
    private readonly spec: UdsForwardBackend,
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
    const url = (env as unknown as Record<string, string>)[COMPANION_URL_BINDING];
    if (!url) {
      throw new JsonRpcInvocationError(
        -32603,
        `manifest: ${COMPANION_URL_BINDING} not configured — cannot route ${this.handlesPrefix || toolName}* calls to UDS socket "${this.spec.socketPath}"`,
      );
    }

    // upstreamId is an opaque routing tag for companion logs. Using the
    // handlesPrefix (or toolName for empty-prefix backends) keeps each
    // backend distinguishable without adding a new schema field.
    const upstreamId = this.handlesPrefix !== "" ? this.handlesPrefix.replace(/_$/, "") : toolName;

    const argumentsJson = canonical(args as CanonicalValue);
    const requestBytes = encodeToolCall({
      upstreamId,
      toolName,
      argumentsJson,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method:  "POST",
        headers: {
          "Content-Type":            "application/x-capnp; type=ToolCall",
          "X-Cloister-Transport":    "uds",
          "X-Cloister-Socket-Path":  this.spec.socketPath,
        },
        body: requestBytes,
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

    // Single-text fast path: parse-as-JSON-or-raw-text. Mirrors
    // HttpForwardToolBackend + LeylineNetToolBackend so callers see the
    // same shape regardless of backend kind.
    if (result.content.length === 1 && result.content[0]!.kind === "text") {
      const text = (result.content[0] as { kind: "text"; text: string }).text;
      try {
        return text === "" ? null : JSON.parse(text);
      } catch {
        return text;
      }
    }

    // Multiple or non-text content: return the full content array, with
    // binary/resource bytes base64-encoded so the edge's JSON.stringify
    // doesn't lose them.
    return result.content.map(contentToJsonShape);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function errorMessageFromContent(content: readonly Content[], toolName: string): string {
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
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
