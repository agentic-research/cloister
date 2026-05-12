/**
 * Generic HTTP-forwarding ToolBackend, parameterized by spec.
 *
 * Spec fields (from manifest/cloister.capnp):
 *   - `urlBinding`      — name of the text-var binding holding the upstream URL
 *   - `tools`           — Asserted catalog (overrides Derived on collision)
 *   - `dynamicTools`    — when true, fetch `tools/list` from upstream and
 *                         merge with Asserted (ADR-0006). Cached with 60s TTL.
 *   - `stripPrefix`     — prefix stripped from tool names before forwarding
 *                         `tools/call`. Empty ⇒ no stripping.
 *   - `requiresSession` — when true, perform MCP Streamable HTTP `initialize`
 *                         handshake on first contact and send the captured
 *                         `Mcp-Session-Id` on every subsequent request.
 *                         Required for mark3labs/mcp-go servers (mache, rsry)
 *                         which validate session-id format on every request.
 *   - `protocolMode`    — ADR-0015 Phase 2 / cloister-a35fdb. Per-upstream
 *                         protocol selector. Values:
 *                           - "current" / "" (default): legacy 2025-11-25
 *                              lifecycle. `initialize` + (optional) sessions.
 *                           - "next":    sessionless (SEP-2575 + SEP-2567).
 *                              Per-request `MCP-Protocol-Version` header +
 *                              inline `_meta` block. No `initialize`. No
 *                              `Mcp-Session-Id`. Capability introspection
 *                              uses `server/discover`.
 *                           - "auto":    try sessionless first; on a 400
 *                              `UnsupportedProtocolVersionError` from the
 *                              upstream, cache that fact and fall back to
 *                              legacy for the lifetime of the binding.
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

const DERIVED_TTL_MS = 60_000;

/** Legacy MCP-spec wire version (`initialize` lifecycle). */
const LEGACY_PROTOCOL_VERSION = "2024-11-05";
/** Sessionless wire version (SEP-2575). Provisional — see mcp.ts. */
const SESSIONLESS_PROTOCOL_VERSION = "2026-XX-XX";
const CLOISTER_INFO    = { name: "cloister", version: "0.1.0" } as const;
/**
 * Client capabilities cloister-the-MCP-client declares to upstreams.
 * Phase 1/2 obligation (ADR-0015 + SEP §3 Obligation 5): the declaration
 * must be non-empty. Cloister is a proxy aggregating upstreams — it does
 * not consume sampling / roots / elicitation primitives, so the only
 * positively-asserted bit is its proxy identity. In sessionless mode this
 * rides inside the per-request `_meta`; in legacy mode it goes into the
 * `initialize` params.
 *
 * NOTE: this is intentionally a minimal proxy declaration. When cloister
 * grows the ability to surface upstream sampling / elicitation to the
 * external client, declare those capabilities here.
 */
const CLOISTER_CLIENT_CAPABILITIES = {
  // Marker bit so the upstream's empty-capabilities check sees a non-empty
  // capabilities block. The exact key name is informational; the spec
  // mandates "declare what you support", and what cloister supports
  // intrinsically is the proxy-aggregation pattern.
  experimental: { proxy: true },
} as const;

/** SEP-2575 meta key for protocol version inside `_meta`. */
const META_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/**
 * Common Accept header — Streamable HTTP servers (mark3labs/mcp-go) require
 * both formats; legacy stateless servers (LLO) ignore it. Sending both is
 * always correct.
 */
const ACCEPT_HEADER = "application/json, text/event-stream";

/**
 * Per-upstream protocol-mode resolved at construction time. `"current"`
 * keeps the legacy lifecycle. `"next"` flips us into sessionless. `"auto"`
 * tries sessionless first and caches a sticky fallback if the upstream
 * returns `UnsupportedProtocolVersionError`.
 */
type ProtocolMode = "current" | "next" | "auto";

export class HttpForwardToolBackend implements ToolBackend {
  private readonly assertedTools: McpTool[];

  private readonly assertedNames: Set<string>;

  private derivedByUpstreamName = new Map<string, McpTool>();

  private fetchedAt = 0;

  private toolsInflight: Promise<void> | null = null;

  /**
   * Captured session-id from the upstream's `initialize` response, when
   * `requiresSession` is set. Null until `ensureSession()` succeeds, or
   * after a 4xx invalid-session response invalidates it.
   *
   * Always null in sessionless mode (SEP-2567 removed sessions). The
   * dispatch path consults `effectiveMode()` before using this field.
   */
  private sessionId: string | null = null;

  private sessionInflight: Promise<void> | null = null;

  private readonly protocolMode: ProtocolMode;

  /**
   * Sticky downgrade flag for `protocolMode === "auto"`. Once an upstream
   * has rejected the sessionless protocol with
   * `UnsupportedProtocolVersionError`, we remember the fact for the
   * lifetime of the binding so we don't keep paying the failed-request
   * cost on every refresh. Cleared only at process restart (cloister
   * lifecycle).
   */
  private sessionlessDowngraded = false;

  constructor(
    private readonly spec: HttpForwardBackend,
    private readonly handlesPrefix: string,
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {
    this.assertedTools = toolsFromSpecs(spec.tools);
    this.assertedNames = new Set(this.assertedTools.map(t => t.name));
    this.protocolMode = normalizeProtocolMode(spec.protocolMode);
  }

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

  handles(toolName: string): boolean {
    if (this.handlesPrefix !== "") return toolName.startsWith(this.handlesPrefix);
    if (this.assertedNames.has(toolName)) return true;
    return this.derivedByUpstreamName.has(toolName);
  }

  async refreshTools(env: Env): Promise<void> {
    if (!this.spec.dynamicTools) return;
    if (Date.now() - this.fetchedAt < DERIVED_TTL_MS) return;
    if (this.toolsInflight) return this.toolsInflight;

    this.toolsInflight = this.fetchUpstreamTools(env)
      .catch(() => { /* leave cache stale; tools() returns Asserted fallback */ })
      .finally(() => { this.toolsInflight = null; });
    return this.toolsInflight;
  }

  /**
   * Resolve which wire protocol to speak right now. `current` and `next`
   * are static; `auto` flips to `current` after a sessionless probe is
   * rejected with `UnsupportedProtocolVersionError`.
   */
  private effectiveMode(): "current" | "next" {
    if (this.protocolMode === "current") return "current";
    if (this.protocolMode === "next")    return "next";
    return this.sessionlessDowngraded ? "current" : "next";
  }

  /**
   * Common per-request headers. In `next` mode every request carries
   * `MCP-Protocol-Version` (SEP-2575) and never `Mcp-Session-Id`
   * (SEP-2567). In `current` mode behavior matches the pre-Phase-2
   * implementation: session header is sent when `requiresSession` is set
   * and we have a session id.
   */
  private requestHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept":       ACCEPT_HEADER,
    };
    if (this.effectiveMode() === "next") {
      h["MCP-Protocol-Version"] = SESSIONLESS_PROTOCOL_VERSION;
      return h;
    }
    if (this.spec.requiresSession && this.sessionId) {
      h["Mcp-Session-Id"] = this.sessionId;
    }
    return h;
  }

  /**
   * Build the per-request `_meta` block required by SEP-2575 in sessionless
   * mode. Returned only on the sessionless path; legacy `tools/list` and
   * `tools/call` requests are unchanged.
   */
  private sessionlessMeta(): Record<string, unknown> {
    return {
      [META_PROTOCOL_VERSION_KEY]: SESSIONLESS_PROTOCOL_VERSION,
      clientInfo:         CLOISTER_INFO,
      clientCapabilities: CLOISTER_CLIENT_CAPABILITIES,
    };
  }

  /**
   * Decorate a JSON-RPC params object with `_meta` when in sessionless
   * mode. No-op in legacy mode. Pure helper — does not mutate `base`.
   */
  private withMeta<T extends Record<string, unknown> | undefined>(base: T): T | Record<string, unknown> {
    if (this.effectiveMode() !== "next") return base;
    return { ...(base ?? {}), _meta: this.sessionlessMeta() };
  }

  private async fetchUpstreamTools(env: Env): Promise<void> {
    const url = (env as unknown as Record<string, string>)[this.spec.urlBinding];
    if (!url) return;

    // Sessionless path — no initialize handshake, no session header.
    // `server/discover` is the SEP-2575 catalog-introspection RPC; we
    // call it as a sanity check (its response carries the upstream's
    // supportedVersions + capabilities, which we ignore today but will
    // surface through `/.well-known/mcp-registry/` once Phase 3 lands).
    // Then we POST `tools/list` with the same per-request `_meta`.
    if (this.effectiveMode() === "next") {
      const discoverOk = await this.doDiscover(url);
      if (!discoverOk && this.protocolMode === "auto") {
        // Sticky downgrade. Re-enter via the current-spec path.
        this.sessionlessDowngraded = true;
        return this.fetchUpstreamTools(env);
      }
      if (!discoverOk) return;

      const innerReq = {
        jsonrpc: "2.0" as const,
        id:      0,
        method:  "tools/list",
        params:  this.withMeta(undefined as undefined) as Record<string, unknown>,
      };
      const res = await this.fetchImpl(url, {
        method:  "POST",
        headers: this.requestHeaders(),
        body:    JSON.stringify(innerReq),
      });
      if (!res.ok) return;
      let body: JsonRpcResponse;
      try { body = await res.json() as JsonRpcResponse; } catch { return; }
      if (body.error) return;
      this.captureDerivedTools(body.result);
      return;
    }

    // Legacy path — initialize handshake (when requiresSession set), then
    // tools/list. Unchanged from pre-Phase-2 behavior.
    const tryFetch = async (): Promise<{ status: number; body: JsonRpcResponse | null } | null> => {
      if (this.spec.requiresSession) await this.ensureSession(url);
      const innerReq = { jsonrpc: "2.0" as const, id: 0, method: "tools/list" };
      const res = await this.fetchImpl(url, {
        method:  "POST",
        headers: this.requestHeaders(),
        body:    JSON.stringify(innerReq),
      });
      if (!res.ok) {
        await res.text().catch(() => "");
        return { status: res.status, body: null };
      }
      try {
        const body = (await res.json()) as JsonRpcResponse;
        return { status: res.status, body };
      } catch { return null; }
    };

    let result = await tryFetch();
    // 400/404 with requiresSession ⇒ session expired. Reset and retry once.
    if (result && result.status >= 400 && this.spec.requiresSession) {
      this.sessionId = null;
      result = await tryFetch();
    }
    if (!result?.body || result.body.error) return;
    this.captureDerivedTools(result.body.result);
  }

  /**
   * Pull `tools` out of a JSON-RPC `tools/list` result and store them in
   * the Derived cache (advertised under the prefix). No-op on shape
   * mismatch — Asserted fallback continues to be returned by `tools()`.
   */
  private captureDerivedTools(result: unknown): void {
    const upstreamResult = result as UpstreamToolsListResult | undefined;
    if (!upstreamResult || !Array.isArray(upstreamResult.tools)) return;

    const next = new Map<string, McpTool>();
    for (const t of upstreamResult.tools) {
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

  /**
   * Sessionless capability-introspection probe (SEP-2575). Returns true
   * when `server/discover` succeeded and `false` if the upstream returned
   * a 4xx (likely because it doesn't speak sessionless), which is the
   * trigger for the `auto`-mode downgrade. Other transport errors are
   * swallowed and surface as `false` so the caller can decide whether
   * to retry or fall back.
   */
  private async doDiscover(url: string): Promise<boolean> {
    const innerReq = {
      jsonrpc: "2.0" as const,
      id:      0,
      method:  "server/discover",
      params:  this.withMeta(undefined as undefined) as Record<string, unknown>,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method:  "POST",
        headers: this.requestHeaders(),
        body:    JSON.stringify(innerReq),
      });
    } catch {
      return false;
    }
    if (!res.ok) {
      // Drain body so the connection can release.
      await res.text().catch(() => "");
      return false;
    }
    // We don't currently consume the `server/discover` result. Drain the
    // body to release the connection; future work surfaces upstream
    // capabilities into `/.well-known/mcp-registry/` (ADR-0015 Phase 3).
    await res.json().catch(() => null);
    return true;
  }

  /**
   * MCP Streamable HTTP `initialize` handshake. Captures the
   * `Mcp-Session-Id` response header and stores it for subsequent calls.
   * Concurrent callers share an in-flight Promise.
   *
   * Legacy-only — sessionless mode skips this entirely.
   */
  private async ensureSession(url: string): Promise<void> {
    if (this.sessionId !== null) return;
    if (this.sessionInflight) return this.sessionInflight;

    this.sessionInflight = this.doInitialize(url)
      .finally(() => { this.sessionInflight = null; });
    return this.sessionInflight;
  }

  /**
   * Captured upstream server capabilities from the `initialize` response.
   * Today this is informational only — we don't gate behavior on it.
   * Future work: surface upstream capabilities into the proxy's
   * `tools/list` aggregation (per SEP §3 Obligation 5, future
   * sampling/elicitation forwarding will require capability checks).
   * ADR-0015 Phase 1: captured to prove the proxy is paying attention.
   */
  private upstreamServerCapabilities: Record<string, unknown> = {};

  /**
   * Captured upstream protocol version from the `initialize` response.
   * Cloister accepts any upstream that responds with a version it knows
   * (today: `LEGACY_PROTOCOL_VERSION`). Mismatches mark the upstream
   * unreachable — `derivedByUpstreamName` stays empty and the asserted
   * fallback wins. ADR-0015 Phase 1.
   */
  private upstreamProtocolVersion: string | null = null;

  /**
   * Set when the upstream returned an incompatible `protocolVersion` and
   * the lifecycle aborted. Forces `fetchUpstreamTools` to skip the
   * `tools/list` round-trip — the upstream is effectively unreachable
   * from the proxy's perspective. ADR-0015 Phase 1.
   */
  private upstreamVersionIncompatible = false;

  private async doInitialize(url: string): Promise<void> {
    // ── Step 1: initialize request ──────────────────────────────────────
    const innerReq = {
      jsonrpc: "2.0" as const,
      id:      0,
      method:  "initialize",
      params:  {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        // ADR-0015 Phase 1 / SEP §3 Obligation 5: declare non-empty
        // client capabilities. A bare `{}` here is a spec violation; the
        // proxy advertises its proxy-aggregation marker so upstreams
        // can see they're being aggregated.
        capabilities:    CLOISTER_CLIENT_CAPABILITIES,
        clientInfo:      CLOISTER_INFO,
      },
    };
    const res = await this.fetchImpl(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Accept": ACCEPT_HEADER },
      body:    JSON.stringify(innerReq),
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      throw new JsonRpcInvocationError(
        -32603,
        `upstream initialize failed: HTTP ${res.status}`,
      );
    }
    // ── Step 2: parse the initialize response body ──────────────────────
    //
    // Capture protocolVersion + capabilities + serverInfo. The body shape
    // mirrors MCP Lifecycle §3.1:
    //
    //   { jsonrpc: "2.0", id: 0, result: {
    //       protocolVersion: "...",
    //       capabilities:    { ... },
    //       serverInfo:      { ... },
    //   }}
    //
    // Drain-and-ignore on parse failure preserves pre-Phase-1 behavior
    // (upstreams that respond with empty bodies still work).
    interface InitializeResult {
      protocolVersion?: string;
      capabilities?:    Record<string, unknown>;
      serverInfo?:      { name?: string; version?: string };
    }
    let body: JsonRpcResponse | null = null;
    try { body = (await res.json()) as JsonRpcResponse; } catch { body = null; }
    const result = (body?.result ?? null) as InitializeResult | null;
    if (result) {
      // Version negotiation — ADR-0015 Phase 1 / SEP §3 Obligation 2.
      // We currently speak exactly one legacy version; any mismatch is
      // an "unreachable" condition, NOT a fallback. The proxy refuses
      // to silently down-shift its protocol stance.
      this.upstreamProtocolVersion = result.protocolVersion ?? null;
      if (
        this.upstreamProtocolVersion !== null
        && this.upstreamProtocolVersion !== LEGACY_PROTOCOL_VERSION
      ) {
        this.upstreamVersionIncompatible = true;
        // Don't send notifications/initialized — the lifecycle aborts
        // here, the session is unusable. Future work could record this
        // for surfacing in /.well-known/mcp-registry health output.
        throw new JsonRpcInvocationError(
          -32603,
          `upstream protocolVersion mismatch: got ${this.upstreamProtocolVersion}, expected ${LEGACY_PROTOCOL_VERSION}`,
        );
      }
      // Capture capabilities — informational today, gating future
      // capability-dependent forwards (sampling/elicitation).
      if (result.capabilities && typeof result.capabilities === "object") {
        this.upstreamServerCapabilities = result.capabilities;
      }
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    // ── Step 3: notifications/initialized ───────────────────────────────
    //
    // MCP Lifecycle §3.1 step 3: after the initialize response, the
    // client MUST send `notifications/initialized` before any other RPC.
    // mark3labs/mcp-go enforces this — sending other requests before
    // the notification produces "Invalid session ID" errors (this was
    // the cloister-91e5d4 mache bug). ADR-0015 Phase 1 fix.
    //
    // Notifications carry no `id` (JSON-RPC §4.1.5) and expect no
    // response body. We POST-and-discard. Failures here are surfaced
    // as throws because the lifecycle MUST complete — if the upstream
    // can't accept the notification, subsequent calls will fail anyway
    // and we want to fail fast at the lifecycle boundary, not later in
    // a `tools/list` retry loop.
    const initializedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept":       ACCEPT_HEADER,
    };
    if (this.sessionId) initializedHeaders["Mcp-Session-Id"] = this.sessionId;
    const notifyRes = await this.fetchImpl(url, {
      method:  "POST",
      headers: initializedHeaders,
      body:    JSON.stringify({
        jsonrpc: "2.0" as const,
        method:  "notifications/initialized",
        // No `id` field — this is a notification, not a request.
        // Notifications in MCP carry params (optional) but no id.
        // mark3labs/mcp-go and the spec both treat presence of `id`
        // as marking a request, not a notification.
      }),
    });
    // Drain the response body so the connection releases. Per the spec
    // the server SHOULD respond with 202 Accepted (no body), but some
    // implementations return 200 with an empty body — both are
    // acceptable. We don't gate on the status here because the
    // notification has no JSON-RPC error envelope to surface.
    await notifyRes.text().catch(() => "");
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

    const params: Record<string, unknown> = { name: wireName, arguments: args };
    if (this.effectiveMode() === "next") {
      params._meta = this.sessionlessMeta();
    }

    const innerReq = {
      jsonrpc: "2.0" as const,
      id:      0,
      method:  "tools/call",
      params,
    };

    const tryCall = async (): Promise<Response> => {
      if (this.effectiveMode() === "current" && this.spec.requiresSession) {
        await this.ensureSession(url);
      }
      return this.fetchImpl(url, {
        method:  "POST",
        headers: this.requestHeaders(),
        body:    JSON.stringify(innerReq),
      });
    };

    let res: Response;
    try {
      res = await tryCall();
      // 400 in sessionless mode under "auto" is treated as the protocol-
      // downgrade signal. We swap to current-spec and retry once with the
      // legacy lifecycle. In "next" mode (no auto fallback configured)
      // the error surfaces as an upstream HTTP failure.
      if (
        !res.ok && res.status >= 400
        && this.effectiveMode() === "next"
        && this.protocolMode === "auto"
      ) {
        await res.text().catch(() => "");
        this.sessionlessDowngraded = true;
        res = await tryCall();
      }
      if (!res.ok && res.status >= 400 && this.effectiveMode() === "current" && this.spec.requiresSession) {
        // Drain + reset session, retry once. Catches mache restarts and
        // upstream session-table evictions without surfacing the blip.
        await res.text().catch(() => "");
        this.sessionId = null;
        res = await tryCall();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `upstream unreachable: ${msg}`);
    }

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
    let parsed: unknown;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // Non-JSON text — pass through raw. Some MCP servers may emit prose.
      parsed = text;
    }

    let isError = result.isError === true;
    if (!isError && parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (p.ok === false || p.error !== undefined) {
        isError = true;
      }
    }

    if (isError) {
      const err =
        parsed && typeof parsed === "object" && "error" in (parsed as object)
          ? String((parsed as { error: unknown }).error)
          : `tool ${toolName} failed`;
      throw new JsonRpcInvocationError(-32000, err);
    }

    return parsed;
  }
}

/**
 * Normalize the `protocolMode` field. Accepts the three documented values
 * and treats anything else (including empty string and unset) as
 * `"current"` — schema-evolution safe (older manifests + future-but-typo'd
 * values both land on legacy behavior). Adding a new mode here is a
 * deliberate schema change, not a stringly-typed footgun.
 */
function normalizeProtocolMode(value: string | undefined): ProtocolMode {
  if (value === "next" || value === "auto") return value;
  return "current";
}

/**
 * Spec-aligned alias for `HttpForwardToolBackend` (ADR-0015 Phase 1).
 *
 * The class implements the MCP-Proxy-Server client lifecycle (per the
 * Security Best Practices §"MCP Proxy Server" doc): `initialize` →
 * `notifications/initialized` → version check → capability capture →
 * `tools/list` + `tools/call` forwarding with prefix-strip. New code
 * should reference `McpProxyToolBackend`; the `HttpForwardToolBackend`
 * name stays for one release as a deprecation alias.
 *
 * Same class — re-exported under the spec-aligned name. A future release
 * will (a) rename the class symbol outright, (b) move the file to
 * `mcp-proxy.ts`, and (c) retire the alias. Today's change is
 * intentionally minimal-churn.
 */
export { HttpForwardToolBackend as McpProxyToolBackend };
