// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fixture-mcp-server.ts — strict-assert MCP server fixture for spec-compliance
// testing (ADR-0015, Phase 0; bead cloister-a2b76f).
//
// This fixture exists to drive the compliance contract that Phase 1/2/3
// implementations of cloister's MCP-Proxy-Server role MUST satisfy. It is
// NOT production code; the only design objective is to detect spec
// violations from a client (i.e. cloister) and surface them as recorded
// assertion targets.
//
// ── Design rationale ─────────────────────────────────────────────────
//
// Workerd's vitest-pool-workers environment does not expose `node:http`,
// so the fixture cannot bind to a real TCP port. Instead it exposes a
// `fetcher: typeof fetch` that the system-under-test (HttpForwardToolBackend
// in Phase 0, the renamed McpProxyToolBackend in Phase 1+) consumes via
// its existing fetch-injection seam. This is consistent with the unit-
// test pattern already used in `test/manifest/http-forward-dynamic.test.ts`
// and avoids fighting the runtime.
//
// `fixture.url` returns a stable symbolic origin (https://fixture.test/mcp);
// the SUT writes to that URL via the injected fetcher and the fixture
// records the request before responding.
//
// ── Two protocol modes ───────────────────────────────────────────────
//
// `mode: "current"` — MCP 2025-11-25 lifecycle. Strict enforcement:
//   - `initialize` request must arrive with `protocolVersion`, non-empty
//     `capabilities`, and `clientInfo`.
//   - Response carries `Mcp-Session-Id`.
//   - `notifications/initialized` must arrive before any other RPC.
//   - All subsequent requests must echo `Mcp-Session-Id`.
//
// `mode: "next"` — Post-SEP-2575 + post-SEP-2567 sessionless protocol:
//   - No `initialize`. No `Mcp-Session-Id`.
//   - Every request carries an `MCP-Protocol-Version` header.
//   - `_meta` block carries clientInfo / clientCapabilities /
//     protocolVersion inline.
//   - Capability introspection uses `server/discover` RPC.
//
// Violations are recorded but DO NOT throw inside the fetcher (that would
// produce confusing test failures). Tests inspect `fixture.violations`
// after running the SUT and assert it is empty (or assert specific
// violation kinds, depending on the test's intent).
//
// ── Cross-references ─────────────────────────────────────────────────
//
// - ADR-0015 (this directory's adr/0015-mcp-spec-alignment.md) — the
//   architectural decision that motivated this fixture.
// - SEP-XXXX (this repo's docs/mcp-seps/SEP-XXXX-mcp-proxy-server-formalization.md)
//   — the proposed normative obligations the fixture asserts.
// - MCP Specification Lifecycle:
//   https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
// - MCP Security Best Practices:
//   https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
// - SEP-2575 (Accepted): https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575
// - SEP-2567 (Final):    https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567

export type FixtureMode = "current" | "next";

export interface FixtureToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FixtureServerOptions {
  /** Which protocol the fixture asserts the client speaks. */
  mode: FixtureMode;
  /** Catalog of tools advertised by this fixture. */
  tools?: FixtureToolDescriptor[];
  /**
   * If set, the fixture's `initialize` response returns this version
   * instead of echoing the client's. Used to test version-negotiation
   * behavior (the client should mark the upstream unreachable).
   */
  forceProtocolVersion?: string;
  /**
   * `serverInfo` returned in the `initialize` response.
   */
  serverInfo?: { name: string; version: string };
  /**
   * Capabilities returned in the `initialize` response.
   */
  serverCapabilities?: Record<string, unknown>;
  /**
   * Marker token to detect token passthrough. If the fixture sees this
   * exact value in the `Authorization` header of any inbound request,
   * it records a `tokenPassthrough` violation. Tests set this to a value
   * they handed to cloister's own client; the assertion is that cloister
   * MUST mint its own credential and MUST NOT forward this token.
   */
  passthroughMarker?: string;
  /**
   * Maximum delay (ms) the fixture will wait for `notifications/initialized`
   * after responding to `initialize` before recording a violation. Default
   * 50ms is generous for in-process; production gates would use longer.
   */
  initializedTimeoutMs?: number;
  /**
   * If true, the next call to `tools/list` (or any non-initialize call)
   * will respond with 4xx "Invalid session" to force the client to
   * re-initialize. Test toggles this to exercise session-reset retry.
   */
  expireSessionOnNextCall?: boolean;
}

export interface FixtureViolation {
  kind:
    | "missingInitialize"
    | "missingNotificationsInitialized"
    | "missingMcpSessionId"
    | "missingProtocolVersionHeader"
    | "missingMetaClientInfo"
    | "missingCapabilities"
    | "emptyCapabilities"
    | "tokenPassthrough"
    | "versionMismatch"
    | "wrongMethodForMode"
    | "unexpectedSessionIdInNextMode";
  detail: string;
  /** The request that triggered the violation, JSON-stringified. */
  request: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  ts: number;
}

/**
 * In-process MCP fixture server.
 *
 * Usage:
 *
 *   const fixture = new FixtureMcpServer({ mode: "current", tools: [...] });
 *   await fixture.start();
 *   try {
 *     const backend = new HttpForwardToolBackend(spec, "fixture_", fixture.fetcher);
 *     await backend.refreshTools({ FIXTURE_URL: fixture.url } as Env);
 *     expect(fixture.violations).toEqual([]);
 *   } finally {
 *     await fixture.stop();
 *   }
 */
export class FixtureMcpServer {
  private opts: Required<Omit<FixtureServerOptions, "passthroughMarker" | "forceProtocolVersion">> &
    Pick<FixtureServerOptions, "passthroughMarker" | "forceProtocolVersion">;

  private running = false;

  private sessionId: string | null = null;

  private initializeSeen = false;

  private notificationsInitializedSeen = false;

  /** Pending timer that flips `missingNotificationsInitialized` if no notify arrives. */
  private initializedTimer: ReturnType<typeof setTimeout> | null = null;

  /** All requests the fixture observed, in arrival order. */
  readonly requests: RecordedRequest[] = [];

  /** Recorded violations. Tests inspect this. */
  readonly violations: FixtureViolation[] = [];

  constructor(options: FixtureServerOptions) {
    this.opts = {
      mode:                  options.mode,
      tools:                 options.tools                  ?? [],
      serverInfo:            options.serverInfo             ?? { name: "fixture", version: "0.0.1" },
      serverCapabilities:    options.serverCapabilities     ?? { tools: {} },
      initializedTimeoutMs:  options.initializedTimeoutMs   ?? 50,
      expireSessionOnNextCall: options.expireSessionOnNextCall ?? false,
      passthroughMarker:     options.passthroughMarker,
      forceProtocolVersion:  options.forceProtocolVersion,
    };
  }

  /** Symbolic origin the SUT writes to. The fetcher matches any URL starting with this. */
  get url(): string {
    return "https://fixture.test/mcp";
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.initializedTimer) {
      clearTimeout(this.initializedTimer);
      this.initializedTimer = null;
    }
    // Final lifecycle check: if `initialize` came in but no
    // `notifications/initialized` ever arrived, that's a violation we
    // surface only at stop() time (the timer flushed earlier, but the
    // test may stop the fixture before the timer fires).
    if (
      this.opts.mode === "current"
      && this.initializeSeen
      && !this.notificationsInitializedSeen
      && !this.violations.some(v => v.kind === "missingNotificationsInitialized")
    ) {
      this.violations.push({
        kind:    "missingNotificationsInitialized",
        detail:  "fixture stopped without receiving notifications/initialized",
        request: "<n/a>",
      });
    }
  }

  /** The fetch implementation the SUT consumes. Always returns a Response. */
  readonly fetcher: typeof fetch = async (input, init) => {
    if (!this.running) {
      return new Response("fixture not started", { status: 503 });
    }
    return this.handle(input, init);
  };

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url    = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headerRecord: Record<string, string> = {};
    const rawHeaders = init?.headers ?? {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => { headerRecord[k.toLowerCase()] = v; });
    } else if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headerRecord[k.toLowerCase()] = String(v);
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) headerRecord[k.toLowerCase()] = String(v);
    }

    let parsedBody: unknown = null;
    if (init?.body !== undefined && init.body !== null) {
      try { parsedBody = JSON.parse(String(init.body)); } catch { parsedBody = String(init.body); }
    }

    const recorded: RecordedRequest = { method, url, headers: headerRecord, body: parsedBody, ts: Date.now() };
    this.requests.push(recorded);

    // ── Token-passthrough check (applies in both modes) ─────────────
    if (this.opts.passthroughMarker !== undefined) {
      const auth = headerRecord["authorization"];
      if (auth !== undefined && auth.includes(this.opts.passthroughMarker)) {
        this.violations.push({
          kind:    "tokenPassthrough",
          detail:  `Authorization header contains marker token "${this.opts.passthroughMarker}" — the client (cloister) MUST NOT forward client-issued credentials to upstreams (SEP §3 Obligation 3, Security Best Practices token-passthrough prohibition)`,
          request: JSON.stringify(recorded),
        });
      }
    }

    if (method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    // The MCP body is either a single request object or an array (batch).
    // For this fixture, single-request bodies are sufficient.
    const req = parsedBody as { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };
    if (!req || typeof req !== "object" || typeof req.method !== "string") {
      return jsonRpc(null, { code: -32600, message: "invalid request" });
    }

    if (this.opts.mode === "current") {
      return this.handleCurrent(req, headerRecord, recorded);
    }
    return this.handleNext(req, headerRecord, recorded);
  }

  // ── current-protocol path (MCP 2025-11-25 lifecycle) ───────────────
  private async handleCurrent(
    req: { id?: number | string; method?: string; params?: unknown },
    headers: Record<string, string>,
    recorded: RecordedRequest,
  ): Promise<Response> {
    if (req.method === "initialize") {
      this.initializeSeen = true;
      const params = (req.params ?? {}) as Record<string, unknown>;

      // Capability declaration check (Obligation 5 / fixture capability §3).
      if (!("capabilities" in params)) {
        this.violations.push({
          kind:    "missingCapabilities",
          detail:  "initialize request omitted `capabilities` block (MCP Lifecycle §3.1)",
          request: JSON.stringify(recorded),
        });
      } else {
        const caps = params.capabilities as Record<string, unknown>;
        if (!caps || typeof caps !== "object" || Object.keys(caps).length === 0) {
          this.violations.push({
            kind:    "emptyCapabilities",
            detail:  "initialize request declared empty `capabilities` — a spec-compliant client MUST advertise which client primitives (sampling/roots/elicitation/etc.) it supports",
            request: JSON.stringify(recorded),
          });
        }
      }

      // Session lifecycle: issue a session id.
      this.sessionId = `fixture-session-${Math.random().toString(36).slice(2, 10)}`;

      // Start the `notifications/initialized` window. If nothing comes in
      // within `initializedTimeoutMs`, record a violation.
      if (this.initializedTimer) clearTimeout(this.initializedTimer);
      this.initializedTimer = setTimeout(() => {
        if (!this.notificationsInitializedSeen) {
          this.violations.push({
            kind:    "missingNotificationsInitialized",
            detail:  `client did not send notifications/initialized within ${this.opts.initializedTimeoutMs}ms of initialize response — MCP Lifecycle §3.1 step 3`,
            request: JSON.stringify(recorded),
          });
        }
        this.initializedTimer = null;
      }, this.opts.initializedTimeoutMs);

      const result = {
        protocolVersion: this.opts.forceProtocolVersion ?? (params.protocolVersion as string) ?? "2025-11-25",
        capabilities:    this.opts.serverCapabilities,
        serverInfo:      this.opts.serverInfo,
      };
      return jsonRpcOk(req.id ?? 0, result, { "Mcp-Session-Id": this.sessionId });
    }

    if (req.method === "notifications/initialized") {
      this.notificationsInitializedSeen = true;
      if (this.initializedTimer) {
        clearTimeout(this.initializedTimer);
        this.initializedTimer = null;
      }
      return new Response(null, { status: 202 });
    }

    // Any non-initialize/notification call MUST carry Mcp-Session-Id.
    const sid = headers["mcp-session-id"];
    if (!sid) {
      this.violations.push({
        kind:    "missingMcpSessionId",
        detail:  `request method=${req.method} did not include Mcp-Session-Id header (MCP Transport §Session)`,
        request: JSON.stringify(recorded),
      });
    } else if (sid !== this.sessionId) {
      // Stale or unknown session.
      return jsonRpcErr(req.id ?? 0, -32000, "Invalid session ID", 400);
    }

    if (this.opts.expireSessionOnNextCall) {
      this.opts.expireSessionOnNextCall = false;
      this.sessionId = null;
      this.initializeSeen = false;
      this.notificationsInitializedSeen = false;
      return jsonRpcErr(req.id ?? 0, -32000, "Session expired", 400);
    }

    if (!this.initializeSeen) {
      this.violations.push({
        kind:    "missingInitialize",
        detail:  `request method=${req.method} arrived before initialize`,
        request: JSON.stringify(recorded),
      });
    }

    return this.handleRpc(req);
  }

  // ── next-protocol path (SEP-2575 + SEP-2567 sessionless) ───────────
  private async handleNext(
    req: { id?: number | string; method?: string; params?: unknown },
    headers: Record<string, string>,
    recorded: RecordedRequest,
  ): Promise<Response> {
    // No initialize handshake in next mode.
    if (req.method === "initialize") {
      this.violations.push({
        kind:    "wrongMethodForMode",
        detail:  "next-protocol mode received an `initialize` request; SEP-2575 removed it. Use per-request _meta + MCP-Protocol-Version header.",
        request: JSON.stringify(recorded),
      });
      return jsonRpcErr(req.id ?? 0, -32601, "Method not found: initialize (sessionless)", 404);
    }

    // Per-request MCP-Protocol-Version header is REQUIRED in next mode.
    if (!headers["mcp-protocol-version"]) {
      this.violations.push({
        kind:    "missingProtocolVersionHeader",
        detail:  "next-protocol mode requires MCP-Protocol-Version header on every request (SEP-2575)",
        request: JSON.stringify(recorded),
      });
    }

    // Session IDs MUST NOT appear in next mode (SEP-2567 removed sessions).
    if (headers["mcp-session-id"]) {
      this.violations.push({
        kind:    "unexpectedSessionIdInNextMode",
        detail:  "next-protocol mode received Mcp-Session-Id header; SEP-2567 removed server-side sessions",
        request: JSON.stringify(recorded),
      });
    }

    // _meta block carries clientInfo / clientCapabilities / protocolVersion.
    const params = (req.params ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? params["_meta"]) as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== "object") {
      this.violations.push({
        kind:    "missingMetaClientInfo",
        detail:  "next-protocol mode requires `_meta` with clientInfo / clientCapabilities / protocolVersion on every request (SEP-2575)",
        request: JSON.stringify(recorded),
      });
    }

    if (req.method === "server/discover") {
      const result = {
        protocolVersion: this.opts.forceProtocolVersion ?? "2026-XX-XX",
        capabilities:    this.opts.serverCapabilities,
        serverInfo:      this.opts.serverInfo,
      };
      return jsonRpcOk(req.id ?? 0, result);
    }

    return this.handleRpc(req);
  }

  // ── shared RPC body (tools/list, tools/call) ───────────────────────
  private handleRpc(req: { id?: number | string; method?: string; params?: unknown }): Response {
    if (req.method === "tools/list") {
      return jsonRpcOk(req.id ?? 0, {
        tools: this.opts.tools.map(t => ({
          name:        t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {}, required: [] },
        })),
      });
    }

    if (req.method === "tools/call") {
      const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
      const tool   = this.opts.tools.find(t => t.name === params.name);
      if (!tool) {
        return jsonRpcErr(req.id ?? 0, -32602, `unknown tool: ${params.name}`, 200);
      }
      return jsonRpcOk(req.id ?? 0, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, tool: tool.name }) }],
      });
    }

    return jsonRpcErr(req.id ?? 0, -32601, `method not found: ${req.method}`, 404);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function jsonRpcOk(
  id: number | string,
  result: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status:  200,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function jsonRpcErr(
  id: number | string,
  code: number,
  message: string,
  httpStatus = 200,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status:  httpStatus,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpc(
  id: number | string | null,
  error: { code: number; message: string },
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
    status:  200,
    headers: { "Content-Type": "application/json" },
  });
}
