/**
 * Generic HTTP-forwarding ToolBackend, parameterized by spec.
 *
 * Spec fields (from manifest/cloister.capnp):
 *   - `urlBinding`      — name of the text-var binding holding the upstream URL
 *   - `serviceBinding`  — name of a workerd `Fetcher` Service binding that
 *                         resolves to this upstream. When non-empty AND the
 *                         env binding is a Fetcher, the runtime calls
 *                         `env[serviceBinding].fetch(...)` instead of
 *                         `fetch(env[urlBinding] + path)`. This is the
 *                         workerd-native shape (config.capnp `external =
 *                         (address = "...", http = ())` + a `service`
 *                         binding on the Worker); it sidesteps the
 *                         catch-all `internet` egress and keeps that ACL
 *                         tight (`["public"]`, no loopback). Empty / unset
 *                         falls back to the URL-var path. Per
 *                         cloister-b65a20.
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
 * global `fetch` wrapped to preserve `this` binding under workerd. The
 * Service-binding code path resolves the upstream `Fetcher` from `env`
 * inside the request resolver — tests that drive the URL-var path
 * (leaving `serviceBinding` unset, or passing an `env` without a
 * matching Fetcher) keep their existing fetch-injection behavior.
 */

import { z } from "zod";

import type { Env, JsonRpcResponse, McpTool } from "../../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../../backends.js";
import type { HttpForwardBackend } from "../types.js";
import { toolsFromSpecs } from "../spec.js";
import { ANONYMOUS_PEER, getRoots } from "../../routes/roots-state.js";

type FetchFn = typeof fetch;

/**
 * MCP Lifecycle §3.1 `initialize` response shape. Validated at the wire
 * boundary so the rest of `doInitialize` works with parsed, typed data —
 * no `as JsonRpcResponse` casts hiding malformed upstream responses.
 *
 * `.passthrough()` on both layers because:
 *  - SDK upstreams add extra envelope fields (e.g., `_meta`)
 *  - the spec only fixes the named fields; extras are permitted
 *
 * Anything not in `result` shape (or `result` missing entirely) falls back
 * to the "no version negotiation possible" branch — same as pre-Phase-1
 * behavior, just no longer silently mis-typed.
 */
const InitializeResultSchema = z.object({
  protocolVersion: z.string().optional(),
  capabilities:    z.record(z.string(), z.unknown()).optional(),
  serverInfo:      z.object({
    name:    z.string().optional(),
    version: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const InitializeResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id:      z.union([z.number(), z.string(), z.null()]),
  result:  InitializeResultSchema.optional(),
  error:   z.unknown().optional(),
}).passthrough();

/**
 * Per-request upstream transport. The runtime resolves one of these from
 * `env` at the start of each refresh/invoke; downstream code calls
 * `up.fetch(init)` and gets a Response regardless of whether bytes flow
 * through a workerd Service binding (`env[serviceBinding].fetch`) or the
 * global `fetch()` keyed by a URL var.
 *
 * URL-var path: `fetch(init)` calls `this.fetchImpl(env[urlBinding], init)`
 * — same call shape as before this refactor, so existing test stubs that
 * read `init?.method` / `init?.body` keep working without changes.
 *
 * Service-binding path: `fetch(init)` constructs a `Request` against a
 * synthetic absolute URL (`http://upstream/mcp`) and dispatches via
 * `env[serviceBinding].fetch(req)`. workerd's Service binding ignores
 * the hostname (the upstream is decided by the binding) but `Request`
 * still requires an absolute URL.
 */
interface Upstream {
  fetch: (init: RequestInit) => Promise<Response>;
}

/** Synthetic absolute URL used when an upstream lives behind a Service binding. */
const SERVICE_BINDING_SYNTHETIC_HOST = "http://upstream";

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
  // MCP roots primitive (spec 2025-06-18, §Client Features → Roots):
  // cloister-as-client answers upstream `roots/list` reverse-RPCs from
  // the per-peer cache populated by external `initialize` /
  // `notifications/roots/list_changed`. `listChanged: true` lets the
  // upstream subscribe to invalidation events; cloister fans them out
  // from the external `notifications/roots/list_changed` handler. See
  // src/routes/roots-state.ts + `handleReverseRpc`/`notifyRootsChanged`
  // below for the integration points.
  roots: { listChanged: true },
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

/**
 * A single JSON-RPC message read off an upstream Streamable HTTP response.
 * Responses carry `result` or `error`; requests carry `method`. Notifications
 * (from the server) carry `method` without an `id`. We discriminate on the
 * presence of `method` — anything with `method` is a server-initiated
 * request or notification; anything else is a response to an outgoing call.
 */
interface JsonRpcStreamMessage {
  jsonrpc?: "2.0";
  id?:     number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?:  { code: number; message: string; data?: unknown };
}

export class McpProxyToolBackend implements ToolBackend {
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

  /**
   * Resolve the upstream transport for this request. When the manifest
   * declares a non-empty `serviceBinding` AND the env binding is a
   * workerd `Fetcher` (duck-typed by the presence of `.fetch`), return
   * the Service-binding transport: a synthetic absolute URL plus a
   * fetcher that delegates to `binding.fetch(req)`. Otherwise fall back
   * to the URL-var path — `env[urlBinding]` resolves to a real upstream
   * URL and bytes flow through `this.fetchImpl`. Returns null when
   * neither route is configured (binding empty AND URL var empty).
   */
  private resolveUpstream(env: Env): Upstream | null {
    const envAny = env as unknown as Record<string, unknown>;
    const bindingName = this.spec.serviceBinding ?? "";
    if (bindingName !== "") {
      const binding = envAny[bindingName];
      if (binding && typeof binding === "object" && typeof (binding as { fetch?: unknown }).fetch === "function") {
        const fetcher = binding as { fetch: (req: Request) => Promise<Response> };
        const syntheticUrl = `${SERVICE_BINDING_SYNTHETIC_HOST}/mcp`;
        return {
          fetch: (init) => fetcher.fetch(new Request(syntheticUrl, init)),
        };
      }
    }
    const url = envAny[this.spec.urlBinding];
    if (typeof url !== "string" || url === "") return null;
    return {
      // URL-var path — same call shape as the pre-cloister-b65a20
      // implementation so existing fetch-injection tests are unchanged.
      fetch: (init) => this.fetchImpl(url, init),
    };
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
    const up = this.resolveUpstream(env);
    if (!up) return;

    // Sessionless path — no initialize handshake, no session header.
    // `server/discover` is the SEP-2575 catalog-introspection RPC; we
    // call it as a sanity check (its response carries the upstream's
    // supportedVersions + capabilities, which we ignore today but will
    // surface through `/.well-known/mcp-registry/` once Phase 3 lands).
    // Then we POST `tools/list` with the same per-request `_meta`.
    if (this.effectiveMode() === "next") {
      const discoverOk = await this.doDiscover(up);
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
      const res = await this.postJson(up, innerReq);
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
      if (this.spec.requiresSession) await this.ensureSession(up);
      const innerReq = { jsonrpc: "2.0" as const, id: 0, method: "tools/list" };
      const res = await this.postJson(up, innerReq);
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
   * Build the standard JSON-POST init with the current per-protocol
   * headers and dispatch it through the upstream transport. Wraps the
   * init-shape so the Service-binding and URL-var code paths share one
   * shape.
   */
  private postJson(up: Upstream, body: unknown): Promise<Response> {
    return up.fetch({
      method:  "POST",
      headers: this.requestHeaders(),
      body:    JSON.stringify(body),
    });
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
  private async doDiscover(up: Upstream): Promise<boolean> {
    const innerReq = {
      jsonrpc: "2.0" as const,
      id:      0,
      method:  "server/discover",
      params:  this.withMeta(undefined as undefined) as Record<string, unknown>,
    };
    let res: Response;
    try {
      res = await this.postJson(up, innerReq);
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
  private async ensureSession(up: Upstream): Promise<void> {
    if (this.sessionId !== null) return;
    if (this.sessionInflight) return this.sessionInflight;

    this.sessionInflight = this.doInitialize(up)
      .finally(() => { this.sessionInflight = null; });
    return this.sessionInflight;
  }

  private async doInitialize(up: Upstream): Promise<void> {
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
    const res = await up.fetch({
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
    // ── Step 2: validate the initialize response body ───────────────────
    //
    // Wire-level schema check before trusting any field. Drain-and-ignore
    // on parse failure preserves pre-Phase-1 behavior (upstreams that
    // respond with empty bodies still work — they just skip the version
    // check and rely on the assertion fallback at line ~150).
    const rawText = await res.text().catch(() => "");
    let rawJson: unknown = null;
    try { rawJson = rawText.length ? JSON.parse(rawText) : null; } catch { rawJson = null; }
    const parsed = rawJson === null ? null : InitializeResponseSchema.safeParse(rawJson);
    const result = parsed && parsed.success ? parsed.data.result ?? null : null;

    // Version negotiation — ADR-0015 Phase 1 / SEP §3 Obligation 2.
    // Cloister speaks exactly one legacy version today; any mismatch is
    // an "unreachable" condition, NOT a silent fallback. Throwing here
    // aborts ensureSession; the session is unusable and downstream
    // callers see the throw, which is the explicit failure mode we want.
    if (result?.protocolVersion && result.protocolVersion !== LEGACY_PROTOCOL_VERSION) {
      throw new JsonRpcInvocationError(
        -32603,
        `upstream protocolVersion mismatch: got ${result.protocolVersion}, expected ${LEGACY_PROTOCOL_VERSION}`,
      );
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
    const notifyRes = await up.fetch({
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
    peerFp?: string,
  ): Promise<unknown> {
    const up = this.resolveUpstream(env);
    if (!up) {
      // Distinguish the two failure modes in the error message so an
      // operator can tell which binding wasn't wired.
      const bindingName = this.spec.serviceBinding ?? "";
      const missing = bindingName !== ""
        ? `neither service binding "${bindingName}" nor URL var "${this.spec.urlBinding}"`
        : `URL var "${this.spec.urlBinding}"`;
      throw new JsonRpcInvocationError(
        -32603,
        `manifest: ${missing} configured — cannot route ${this.handlesPrefix}* calls`,
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
        await this.ensureSession(up);
      }
      return this.postJson(up, innerReq);
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

    // Read the upstream response as a multi-message JSON-RPC stream. The
    // upstream MAY return a single `application/json` body (legacy fast
    // path) or `text/event-stream` interleaving reverse-RPC requests
    // before the actual `tools/call` response. We drive the loop until
    // we see a response message whose `id` matches the outgoing request
    // id (which we fix as 0 above); reverse-RPC requests are answered
    // inline on a separate POST to the same upstream URL.
    let body: JsonRpcResponse | null = null;
    try {
      for await (const msg of readJsonRpcStream(res)) {
        if (typeof msg.method === "string") {
          // Server-initiated message. If it has an `id`, it's a request
          // (reverse-RPC) that expects a response. Without an `id`, it's
          // a notification — log and ignore today (cloister doesn't have
          // primitives that consume upstream notifications yet).
          if (msg.id !== undefined && msg.id !== null) {
            await this.handleReverseRpc(
              { jsonrpc: "2.0", id: msg.id, method: msg.method, params: msg.params },
              up,
              peerFp ?? ANONYMOUS_PEER,
            );
          }
          continue;
        }
        if (msg.id === 0) {
          body = {
            jsonrpc: "2.0",
            id:      msg.id,
            ...(msg.result !== undefined ? { result: msg.result } : {}),
            ...(msg.error  !== undefined ? { error:  msg.error  } : {}),
          };
          break;
        }
        // Unmatched id (rare — server replying to a different request).
        // Ignore and continue reading the stream.
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new JsonRpcInvocationError(-32603, `upstream response stream failed: ${m}`);
    }
    if (!body) {
      throw new JsonRpcInvocationError(-32603, "upstream closed stream without responding");
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

  /**
   * Handle an upstream-initiated reverse-RPC request. Today the only
   * supported method is `roots/list` (MCP 2025-06-18 §Client Features →
   * Roots): the upstream is asking "what filesystem roots is the calling
   * peer authorizing me to operate on?". We answer from the per-peer
   * `RootsState` cache populated by external `initialize` /
   * `notifications/roots/list_changed`.
   *
   * Anything else surfaces as a `-32601 method not found` so the upstream
   * doesn't hang waiting for a response.
   *
   * The response is POSTed as a separate request on the same upstream
   * URL (same session header in legacy mode) per the MCP Streamable HTTP
   * bidirectional pattern. We fire-and-await but do not consume the
   * server's response to the reverse-RPC POST (it should be 202 / empty).
   */
  private async handleReverseRpc(
    msg:    { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown },
    up:     Upstream,
    peerFp: string,
  ): Promise<void> {
    let result: unknown;
    let error: { code: number; message: string } | undefined;
    if (msg.method === "roots/list") {
      const state = getRoots(peerFp);
      result = { roots: state?.roots ?? [] };
    } else {
      error = { code: -32601, message: `method not found: ${msg.method}` };
    }
    const response: JsonRpcResponse = error
      ? { jsonrpc: "2.0", id: msg.id, error }
      : { jsonrpc: "2.0", id: msg.id, result };
    try {
      const replyRes = await up.fetch({
        method:  "POST",
        headers: this.requestHeaders(),
        body:    JSON.stringify(response),
      });
      // Drain the body so the connection releases. We do not gate on
      // status — the spec lets the server respond 200/202 with empty
      // body. Surfacing a status error here would mask the
      // original `tools/call` failure mode.
      await replyRes.text().catch(() => "");
    } catch {
      // Swallow — reverse-RPC replies are best-effort. If the upstream
      // really needs the response it will time out its own waiter, but
      // we don't want to abort the outer `tools/call` over a transient
      // reply failure.
    }
  }

  /**
   * Send `notifications/roots/list_changed` to the upstream. Fire-and-
   * forget: notifications carry no `id` and expect no response. Called
   * by `McpEdgeRoute.dispatch` when the external client signals its
   * roots have changed.
   *
   * Skips the call entirely when no upstream transport is configured
   * (e.g. dev manifests with the URL var unset).
   */
  async notifyRootsChanged(env: Env): Promise<void> {
    const up = this.resolveUpstream(env);
    if (!up) return;
    if (this.effectiveMode() === "current" && this.spec.requiresSession) {
      // The upstream's session-table check will reject the notification
      // if we haven't gone through `initialize` yet. Best-effort: try to
      // ensure a session, but swallow if even that fails — the upstream
      // is unreachable and there is nothing to notify.
      try { await this.ensureSession(up); } catch { return; }
    }
    const params: Record<string, unknown> = {};
    if (this.effectiveMode() === "next") {
      params._meta = this.sessionlessMeta();
    }
    try {
      const res = await up.fetch({
        method:  "POST",
        headers: this.requestHeaders(),
        body:    JSON.stringify({
          jsonrpc: "2.0",
          method:  "notifications/roots/list_changed",
          ...(Object.keys(params).length > 0 ? { params } : {}),
        }),
      });
      await res.text().catch(() => "");
    } catch {
      // Fire-and-forget — notifications are not on the hot path of a
      // client request. Drop transient errors silently.
    }
  }
}

/**
 * Read JSON-RPC messages off an upstream MCP Streamable HTTP response.
 *
 *   - `application/json` content-type: the body is a single JSON-RPC
 *     envelope (or batch). Yield each envelope once and end.
 *   - `text/event-stream` content-type: parse Server-Sent Events. Each
 *     event with a `data:` payload is JSON-parsed and yielded.
 *   - Other / missing content-type: best-effort JSON parse on the body
 *     text. Backward-compat with upstreams that don't set the header.
 *
 * Parser is intentionally minimal — workerd has no built-in EventSource
 * server-side, and the upstream side of MCP only uses the `data:` field
 * (no `id:` / `event:` / `retry:` semantics). Lines starting with `:`
 * are SSE comments and ignored. Records are terminated by a blank line
 * (consecutive LF or CRLF).
 */
async function* readJsonRpcStream(res: Response): AsyncGenerator<JsonRpcStreamMessage> {
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();

  if (ctype.includes("text/event-stream")) {
    if (!res.body) return;
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        // Flush complete events. SSE record separator is a blank line
        // (CRLF/LF + CRLF/LF). Normalize CRLF -> LF first so the split
        // pattern is uniform.
        buf = buf.replace(/\r\n/g, "\n");
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const rec = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const payload = extractSseData(rec);
          if (payload === null) continue;
          try {
            yield JSON.parse(payload) as JsonRpcStreamMessage;
          } catch {
            // Malformed SSE payload — skip to the next event rather
            // than aborting the whole stream. The outer caller will
            // raise if no matched response ever arrives.
          }
        }
        if (done) {
          // Trailing record without a final blank line — flush it too.
          const trailing = buf.trim();
          if (trailing.length > 0) {
            const payload = extractSseData(trailing);
            if (payload !== null) {
              try { yield JSON.parse(payload) as JsonRpcStreamMessage; } catch { /* skip */ }
            }
          }
          return;
        }
      }
    } finally {
      // Best-effort release; if the consumer broke out of the loop
      // early we want the underlying connection to free up.
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  // JSON-only (or unknown) fast path — single body. The MCP spec
  // permits both single envelopes and batches; we yield each item of a
  // batch separately so the dispatch loop above can treat both shapes
  // uniformly.
  let text = "";
  try { text = await res.text(); } catch { return; }
  if (text === "") return;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return; }
  if (Array.isArray(parsed)) {
    for (const m of parsed) yield m as JsonRpcStreamMessage;
    return;
  }
  yield parsed as JsonRpcStreamMessage;
}

/**
 * Pull the joined `data:` payload from a single SSE event record.
 * Per the SSE spec, a record may carry multiple `data:` lines; they
 * concatenate with a single LF between them. Returns null if the
 * record has no `data:` field (e.g. a keep-alive comment).
 */
function extractSseData(record: string): string | null {
  const lines = record.split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;          // comment
    if (line.startsWith("data:")) {
      // The spec strips a single leading space after the colon, if any.
      let v = line.slice(5);
      if (v.startsWith(" ")) v = v.slice(1);
      parts.push(v);
    }
    // Other SSE fields (event:, id:, retry:) are ignored — MCP doesn't
    // use them.
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
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

