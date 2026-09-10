/**
 * MCP edge route — JSON-RPC over POST /mcp + SSE notifications over GET /mcp.
 *
 * Owns:
 *   - JSON-RPC lifecycle (initialize, ping, tools/list, tools/call)
 *   - Sessionless protocol surface (SEP-2575 + SEP-2567): per-request
 *     `MCP-Protocol-Version` header + `_meta` block, `server/discover`,
 *     `subscriptions/listen`. ADR-0015 Phase 2.
 *   - tools/list aggregation across registered ToolBackends
 *   - tools/call dispatch to the first backend that handles(name)
 *   - SSE keep-alive stream for server-pushed notifications
 *
 * Does NOT own:
 *   - HTTP transport multiplexing (that is the Router's job)
 *   - any specific tool family — backends are passed in
 *
 * Dual-protocol support (ADR-0015 Phase 2 / cloister-a35fdb):
 *   The route detects protocol version per-request from the
 *   `MCP-Protocol-Version` HTTP header. Absent ⇒ legacy 2025-11-25
 *   lifecycle (current path: `initialize` + sessions). Present ⇒
 *   sessionless (SEP-2575): every request carries inline `_meta`
 *   clientInfo / clientCapabilities / protocolVersion, capability
 *   introspection is `server/discover`, no `initialize` is honored
 *   under sessionless mode.
 *
 *   The lease pipeline (ADR-0007) authenticates every request
 *   independently, so removing the `initialize` handshake does NOT
 *   weaken authentication — see docs/security/threat-model.md §6.
 */

import type { EdgeRoute } from "../router.js";
import type { OriginSet } from "../wire/origin.js";
import type { Env, JsonRpcRequest, JsonRpcResponse, McpTool } from "../types.js";
import { okResponse, errResponse } from "../types.js";
import { JsonRpcInvocationError, type ToolBackend } from "../backends.js";
import { pickAllowedOrigin } from "../cors.js";
import {
  canonicalRequestBytes,
  gateAndVerify,
  leaseErrorResponse,
  type VerifiedLease,
} from "./lease-middleware.js";
import {
  attachReceipt,
  buildEmissionContext,
  type ReceiptEmissionContext,
} from "./receipt-emitter.js";
import { runBeadCreateOrchestrator } from "./bead-create-orchestrator.js";
import {
  ANONYMOUS_PEER,
  clearRoots,
  setCapability,
  setRoots,
  type Root,
} from "./roots-state.js";
import { McpProxyToolBackend } from "../manifest/backends/mcp-proxy.js";


/**
 * Sessionless MCP protocol version — SEP-2575 + SEP-2567 path. Returned in
 * `server/discover` responses.
 *
 * This was provisional while SEP-2575 was in flight, alongside a
 * `2026-XX-XX` placeholder that in-flight peers had negotiated before the
 * spec shipped. The revision has now shipped, and LLO v0.13.0 derives all 21
 * method constants from the verified 2026-07-28 bytes (failing compilation on
 * a digest mismatch), so the placeholder no longer names anything real —
 * accepting it would only widen the inbound surface. Removed with its
 * transition test, per the removal condition recorded here.
 */
const SESSIONLESS_PROTOCOL_VERSION = "2026-07-28";

const SERVER_INFO = { name: "cloister", version: "0.1.0" } as const;
const KEEPALIVE_MS = 15_000;

/**
 * HTTP header for per-request protocol-version negotiation (SEP-2575 +
 * SEP-2243 HTTP standardization). Presence flips the dispatch to the
 * sessionless path.
 */
const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

// ── Mcp-Method / Mcp-Name agreement (SEP-2243 / cloister-da49a6) ──────────
//
// MCP 2026-07-28 requires these headers on Streamable HTTP POST so
// intermediaries can route and meter without parsing bodies. Cloister's trust
// decisions derive from the SIGNED body — `canonicalRequestBytes` covers
// method+url+ts+nonce+body, and the headers are not in it — so here they are
// ADVISORY: if present they must agree with the body; disagreement rejects
// with the spec's HeaderMismatchError (-32020, the renumbered code from the
// error-code allocation policy) BEFORE the lease gate does any work. The seam
// this closes: a request ROUTED as one method but SCOPE-CHECKED as another
// (deriveRequestScope reads the body). Absence is tolerated — the headers are
// a client obligation, and rejecting their absence buys no trust because the
// body is what's signed either way.
const MCP_METHOD_HEADER = "mcp-method";
const MCP_NAME_HEADER   = "mcp-name";
export const ERR_HEADER_MISMATCH = -32020;

/**
 * Reject when Mcp-Method / Mcp-Name disagree with the (signed) body.
 * @returns an error envelope to send, or null when consistent.
 */
export function validateMcpHeaders(
  request: Request,
  req: JsonRpcRequest,
): { body: JsonRpcResponse; status: number } | null {
  const mismatch = (header: string, got: string, bodyValue: string): { body: JsonRpcResponse; status: number } => ({
    status: 400,
    body: {
      jsonrpc: "2.0",
      id:      req.id ?? null,
      error: {
        code:    ERR_HEADER_MISMATCH,
        message: `HeaderMismatchError: ${header} header ${JSON.stringify(got)} disagrees with body ${JSON.stringify(bodyValue)}`,
      },
    },
  });

  const headerMethod = request.headers.get(MCP_METHOD_HEADER);
  if (headerMethod !== null && headerMethod !== req.method) {
    return mismatch("Mcp-Method", headerMethod, req.method);
  }

  const headerName = request.headers.get(MCP_NAME_HEADER);
  if (headerName !== null) {
    const bodyName = (req.params as { name?: unknown } | undefined)?.name;
    if (typeof bodyName === "string" && headerName !== bodyName) {
      return mismatch("Mcp-Name", headerName, bodyName);
    }
  }
  return null;
}

/**
 * Per-request `_meta` key under which sessionless clients declare their
 * own protocol version. Must match the HTTP header. Spec-defined under
 * the `io.modelcontextprotocol` namespace.
 */
const META_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
/** Result-side `_meta` key: server identity on every sessionless result (SEP-2575 SHOULD). */
const META_SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

/**
 * Capabilities cloister-as-server advertises. In sessionless mode these
 * are returned in `server/discover`; in legacy mode they are returned in
 * the `initialize` response. `tools` is the primitive cloister always
 * surfaces; future primitives (resources, prompts) are added here when
 * implemented.
 */
const SERVER_CAPABILITIES = { tools: {} } as const;

/**
 * Sessionless-protocol error data envelope per SEP-2575.
 * `UnsupportedProtocolVersionError` is returned when a client requests a
 * protocol version not in the gateway's `supportedProtocolVersions`
 * advertisement.
 */
interface UnsupportedProtocolVersionData {
  supported: readonly string[];
  requested: string;
}

export class McpEdgeRoute implements EdgeRoute {
  /**
   * Set of protocol versions this gateway accepts on the sessionless
   * surface. Built from the manifest's `supportedProtocolVersions` field
   * (or the runtime default if absent).
   */
  private readonly supportedVersions: readonly string[];

  constructor(
    private readonly backends: readonly ToolBackend[],
    supportedVersions?: readonly string[],
  ) {
    assertNoDuplicateToolNames(backends);
    // Runtime default — manifest is authoritative when set, otherwise the
    // sessionless revision ALONE.
    //
    // cloister-55d31c: `2024-11-05` used to be advertised beside it. SEP-2567
    // deleted sessions and SEP-2575 replaced the handshake, so the session-based
    // lifecycle is legacy, and the decision on this substrate is no legacy
    // posture. Line ~352 validates the declared header against this list, so
    // dropping the entry is what makes a 2024-11-05 request actually rejected
    // rather than merely undocumented.
    //
    // This is a BREAKING change to the served edge, deliberately: a client
    // pinned to 2024-11-05 now gets UnsupportedProtocolVersionError. It is
    // recoverable per-deployment — `supportedVersions` from the manifest wins
    // over this default, so an operator who must serve a pinned client can
    // declare it. Only the default moved.
    //
    // NOT touched: src/manifest/backends/mcp-proxy.ts still sends 2024-11-05 in
    // its `initialize` to UPSTREAMS. That is not legacy posture, it is interop
    // with servers cloister does not control (mache + rosary are
    // mark3labs/mcp-go); removing it there would break the handshake, exactly
    // as with requiresSession.
    this.supportedVersions =
      supportedVersions && supportedVersions.length > 0
        ? supportedVersions
        : [SESSIONLESS_PROTOCOL_VERSION];
  }

  match(request: Request): boolean {
    return new URL(request.url).pathname === "/mcp";
  }

  async handle(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET")  return handleSse(request, env);
    if (request.method === "POST") return this.handlePost(request, env);
    return new Response("method not allowed", { status: 405 });
  }

  private async handlePost(request: Request, env: Env): Promise<Response> {
    const allowOrigin = pickAllowedOrigin(request, env.ALLOWED_ORIGINS);
    const nowMs = Date.now();

    // Read the body ONCE so we can both verify-against-canonical-bytes
    // and pass it as parsed JSON to dispatch. JSON-RPC §5: when the
    // request can't be parsed, id MUST be null.
    const bodyText = await request.text();
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(bodyText) as JsonRpcRequest;
    } catch {
      return Response.json(errResponse(null, -32700, "parse error"), {
        status: 400,
        headers: { "Access-Control-Allow-Origin": allowOrigin },
      });
    }

    // ── Header/body agreement (SEP-2243 / cloister-da49a6) ───────────────
    //
    // Before the sessionless check and BEFORE the lease gate: a request whose
    // routing headers lie about its body must not cause any gate work, scope
    // derivation, or counter writes. Threat model §13.11.
    const headerCheck = validateMcpHeaders(request, req);
    if (headerCheck) {
      return Response.json(headerCheck.body, {
        status:  headerCheck.status,
        headers: { "Access-Control-Allow-Origin": allowOrigin },
      });
    }

    // ── Sessionless protocol detection (SEP-2575) ─────────────────────────
    //
    // The `MCP-Protocol-Version` HTTP header marks a sessionless client.
    // If absent the request rides the legacy `initialize` lifecycle. If
    // present we validate (a) the requested version is supported, and
    // (b) that the optional inline `_meta.io.modelcontextprotocol/protocolVersion`
    // matches the header (SEP-2243: header/payload must agree).
    const headerVersion = request.headers.get(PROTOCOL_VERSION_HEADER);
    if (headerVersion !== null) {
      const validation = this.validateSessionlessRequest(req, headerVersion);
      if (validation) {
        return Response.json(validation.body, {
          status:  validation.status,
          headers: { "Access-Control-Allow-Origin": allowOrigin },
        });
      }
    }

    // Lease verification — ADR-0007 always-on auth. Skipped entirely
    // when `INTERLACE_ROOT_PUBKEY` is unset (dev/test deployments;
    // production MUST have it set per ADR-0007 and the threat model).
    // The skip is at deployment-binding granularity, NOT per-request,
    // so this is not the `INTERLACE_DEV_BYPASS` the audit removed.
    //
    // When the gate is active, the verified `VerifiedLease` carries
    // cert+sig+scope+peerFp through to the dispatch path so the cross-DO
    // bead_create orchestrator (cloister-492c08) can write an attestation
    // row referencing the same cert that authorized the call.
    //
    // Sessionless protocol note (cloister-a35fdb / SEP-2575): the lease
    // pipeline is per-request and version-agnostic, so removing the
    // `initialize` handshake does NOT change the auth posture. See
    // docs/security/threat-model.md §"Sessionless protocol".
    // ADR-0053 (cloister-220c9d): one flow owns gate → verify → verdict. When
    // the gate is off (explicit dev opt-out) the request passes through with no
    // lease; a reject (auth failure, or prod fail-closed on an empty anchor)
    // returns here; a pass threads the verified lease into dispatch.
    const verdict = await gateAndVerify(env, nowMs, {
      req: request, body: bodyText, id: req.id, method: req.method, params: req.params,
    });
    if (verdict.kind === "reject") {
      return withCors(leaseErrorResponse(req.id, verdict.code, verdict.message), allowOrigin);
    }
    const lease: VerifiedLease | undefined = verdict.kind === "pass" ? verdict.lease : undefined;

    const sessionless = headerVersion !== null;
    const out = await this.dispatch(req, env, lease, nowMs, sessionless);

    // ── 2026-07-28 result shape (cloister-c8e3bd) ─────────────────────────
    //
    // Every RESULT on the sessionless surface carries the required
    // `resultType` ("complete" — cloister has no MRTR interim results yet,
    // cloister-db14c3) and the SHOULD-level `_meta` serverInfo. Done at this
    // single choke point so beads.ts and every future backend inherit it.
    // Deliberately sessionless-only: legacy 2025-11-25 responses stay
    // byte-shaped as before — that revision has no resultType. Errors are
    // untouched: resultType is a field of results, not error objects.
    if (sessionless && out.result !== undefined && out.result !== null
        && typeof out.result === "object" && !Array.isArray(out.result)) {
      const result = out.result as Record<string, unknown>;
      if (result.resultType === undefined) result.resultType = "complete";
      const meta = (result._meta ?? {}) as Record<string, unknown>;
      if (meta[META_SERVER_INFO_KEY] === undefined) meta[META_SERVER_INFO_KEY] = SERVER_INFO;
      result._meta = meta;
    }

    // ── Receipt emission (cloister-ae713f / RECEIPTS.md §2.1, §2.6) ───────
    //
    // Emit Interlace-Receipt on 2xx authenticated responses. The
    // emission context is built per-request from env material (master
    // signing key, actor fingerprint, epoch). When the env binding is
    // unset (Phase 1 dev/test deployments per §8.2), buildEmissionContext
    // returns null and the response passes through unchanged.
    //
    // Per §2.6 the emit is only owed when admission happened — here that
    // means the lease was verified (otherwise we returned a 401/403
    // response above). Unauthenticated mode (no INTERLACE_ROOT_PUBKEY)
    // also skips emission: no peer fingerprint, no §13.2 stake.
    const baseResponse = Response.json(out, {
      headers: { "Access-Control-Allow-Origin": allowOrigin },
    });
    if (lease !== undefined) {
      try {
        const ctx = await buildReceiptContext(env, nowMs, request, bodyText, lease);
        if (ctx !== null) {
          return await attachReceipt(baseResponse, {
            ...ctx,
            origins: this.originsForRequest(bodyText, env),
          });
        }
      } catch {
        // Receipt emission failure is logged-but-not-fatal in Phase 1.
        // When the migration hits Phase 2 (peers enforce), this should
        // become a hard fail (return 500) — but that's a deploy-time
        // policy decision tracked in the spec's migration timeline (§8).
      }
    }
    return baseResponse;
  }

  /**
   * Sessionless request validation (SEP-2575 + SEP-2243).
   *
   * Returns `null` when the request is acceptable. Returns an HTTP-400
   * JSON-RPC error body when:
   *   - the header version isn't in `supportedVersions`
   *     (`UnsupportedProtocolVersionError`)
   *   - `_meta.io.modelcontextprotocol/protocolVersion` is present but
   *     disagrees with the header (SEP-2243 § "Header/payload agreement")
   *
   * Absence of `_meta` is NOT an error at the route level — individual
   * RPCs may still want to interpret it. Per SEP-2575 the spec says
   * clients SHOULD send `_meta`; we don't reject in its absence to keep
   * backward-compat with implementations that only send the header.
   */
  private validateSessionlessRequest(
    req: JsonRpcRequest,
    headerVersion: string,
  ): { body: JsonRpcResponse; status: number } | null {
    if (!this.supportedVersions.includes(headerVersion)) {
      const data: UnsupportedProtocolVersionData = {
        supported: this.supportedVersions,
        requested: headerVersion,
      };
      const err: JsonRpcResponse = {
        jsonrpc: "2.0",
        id:      req.id ?? null,
        error: {
          code:    -32600,
          message: "UnsupportedProtocolVersionError",
          data,
        },
      };
      return { body: err, status: 400 };
    }
    const meta = extractMeta(req.params);
    if (meta) {
      const metaVersion = meta[META_PROTOCOL_VERSION_KEY];
      if (typeof metaVersion === "string" && metaVersion !== headerVersion) {
        const err: JsonRpcResponse = {
          jsonrpc: "2.0",
          id:      req.id ?? null,
          error: {
            code:    -32600,
            message:
              `protocol version mismatch: header=${headerVersion} ` +
              `_meta.${META_PROTOCOL_VERSION_KEY}=${metaVersion}`,
          },
        };
        return { body: err, status: 400 };
      }
    }
    return null;
  }


  private async dispatch(
    req:         JsonRpcRequest,
    env:         Env,
    lease:       VerifiedLease | undefined,
    nowMs:       number,
    sessionless: boolean,
  ): Promise<JsonRpcResponse> {
    const peerFp = lease?.peerFp ?? ANONYMOUS_PEER;
    switch (req.method) {
      case "initialize":
        // Per SEP-2575 sessionless clients MUST NOT call `initialize`.
        // Return -32601 to a sessionless caller; legacy clients get the
        // standard handshake response.
        if (sessionless) {
          return errResponse(req.id, -32601, "method not found: initialize (sessionless protocol)");
        }
        // ADR-0015 Phase 1: version negotiation. If the client requests
        // a protocolVersion outside our advertised set, return an error
        // rather than silently echoing back our own version (which is
        // what the pre-Phase-1 code did). The negotiated version is the
        // client's request when supported, falling back to our legacy
        // version when the client omits the field.
        {
          const params = (req.params ?? {}) as {
            protocolVersion?: string;
            capabilities?:    { roots?: { listChanged?: boolean } };
            roots?:           unknown;
          };
          const requested = params.protocolVersion;
          if (
            typeof requested === "string"
            && requested !== ""
            && !this.supportedVersions.includes(requested)
          ) {
            return errResponse(
              req.id,
              -32600,
              `UnsupportedProtocolVersionError: requested=${requested} supported=${this.supportedVersions.join(",")}`,
            );
          }
          // ── MCP roots primitive (spec 2025-06-18) capture ───────────
          //
          // External clients declare `capabilities.roots` on initialize.
          // Some clients also include an inline `roots: [...]` array on
          // the initialize params (others wait for an upstream-initiated
          // `roots/list` request). We capture both; either path leaves
          // the per-peer cache populated for the reverse-RPC answerer
          // in mcp-proxy.ts.
          this.captureRootsFromInitialize(peerFp, params.capabilities?.roots, params.roots);
          return okResponse(req.id, {
            protocolVersion: requested ?? SESSIONLESS_PROTOCOL_VERSION,
            capabilities:    SERVER_CAPABILITIES,
            serverInfo:      SERVER_INFO,
          });
        }

      // MCP Lifecycle §3.1 step 3 — the client signals that it has
      // received the initialize response and is ready for normal RPCs.
      // We accept-and-ack; cloister-as-server doesn't need to do
      // anything special on this signal today. Returning ok with an
      // empty result keeps the lifecycle clean for strict clients.
      // ADR-0015 Phase 1.
      //
      // JSON-RPC notifications carry no `id` (§4.1.5) and MUST NOT
      // receive a response. If the client mistakenly sent this as a
      // request (with an `id`), we still respond — keeping
      // backward-compat with implementations that don't distinguish
      // request vs. notification.
      case "notifications/initialized":
        if (req.id === undefined || req.id === null) {
          // True notification — no response permitted. The handler
          // signature requires a JsonRpcResponse return, so we emit a
          // synthetic OK that the caller (handlePost) will encode but
          // the response status code is still 200; clients ignore
          // unmatched response bodies. A future refinement could short-
          // circuit higher up the stack to return 202 No Content; this
          // is enough for spec compliance today.
          return okResponse(req.id ?? null, {});
        }
        return okResponse(req.id, {});

      // MCP roots primitive (spec 2025-06-18 §Client Features → Roots):
      // the external client signals that its filesystem-roots set has
      // changed. Invalidate the per-peer cache so the next upstream
      // `roots/list` reverse-RPC re-reads it, and fan the notification
      // out to upstreams that subscribed (advertised roots listChanged
      // on cloister's outgoing `initialize`). Fire-and-forget per the
      // JSON-RPC notification semantics; cloister returns its synthetic
      // OK envelope so the dispatch shape stays uniform.
      case "notifications/roots/list_changed":
        clearRoots(peerFp);
        this.fanOutRootsListChanged(env);
        return okResponse(req.id ?? null, {});

      // SEP-2575 capability-introspection RPC. Replaces the negotiation
      // bits of the legacy `initialize` handshake. Sessionless-only —
      // legacy clients are expected to use `initialize`.
      case "server/discover":
        if (!sessionless) {
          return errResponse(req.id, -32601, "method not found: server/discover (requires MCP-Protocol-Version header)");
        }
        return okResponse(req.id, {
          protocolVersion:    SESSIONLESS_PROTOCOL_VERSION,
          supportedVersions:  this.supportedVersions,
          capabilities:       SERVER_CAPABILITIES,
          serverInfo:         SERVER_INFO,
          instructions:       "cloister MCP gateway — see /.well-known/mcp-registry for the upstream catalog.",
        });

      // SEP-2575 sessionless equivalent of GET-for-SSE. Stub-and-ack —
      // cloister has no primitives that emit change-notifications today.
      // Phase 2 obligation: register the RPC so clients don't get -32601.
      // Future work: actually emit notifications when cloister grows
      // change-bearing primitives (tools/list_changed, etc.).
      case "subscriptions/listen":
        if (!sessionless) {
          return errResponse(req.id, -32601, "method not found: subscriptions/listen (requires MCP-Protocol-Version header)");
        }
        return okResponse(req.id, {
          acknowledged: true,
          subscriptions: extractSubscriptions(req.params),
          // No notifications stream is emitted today — the call is
          // idempotent and the client can poll instead. When cloister
          // grows change-bearing primitives this becomes a real stream.
          implementationStatus: "stub",
        });

      case "tools/list": {
        await Promise.all(this.backends.map(b => b.refreshTools?.(env)));
        const tools = this.allTools();
        if (!sessionless) return okResponse(req.id, { tools });
        // CacheableResult (SEP-2549, required on the 2026-07-28 surface).
        // ttlMs: MINIMUM across backends that report one — the aggregate
        // must not outlive any contributor's declared freshness; none
        // reporting ⇒ 0 (always revalidate). cacheScope: "private"
        // unconditionally — this response was authorized by a specific cert
        // (ADR-0016), and an upstream's "public" must never widen that.
        const ttls = this.backends
          .map(b => b.cacheMeta?.()?.ttlMs)
          .filter((t): t is number => typeof t === "number");
        return okResponse(req.id, {
          tools,
          ttlMs:      ttls.length > 0 ? Math.min(...ttls) : 0,
          cacheScope: "private",
        });
      }
      case "tools/call":
        return this.callTool(req, env, lease, nowMs);
      case "ping":
        // REMOVED in 2026-07-28 (with logging/setLevel and roots notify) —
        // not deprecated, removed. Legacy clients keep it for the 2025-11-25
        // lifecycle; the sessionless surface answers as it would any unknown
        // method, so its absence is not a version oracle.
        if (sessionless) {
          return errResponse(req.id, -32601, "method not found: ping");
        }
        return okResponse(req.id, {});
      default:
        return errResponse(req.id, -32601, `method not found: ${req.method}`);
    }
  }

  /**
   * Aggregate tools across backends. First-registered wins on name collision,
   * which lets Derived (dynamic) tools coexist with Asserted ones (ADR-0006):
   * the manifest order pins the precedence.
   */
  private allTools(): McpTool[] {
    const seen = new Set<string>();
    const out: McpTool[] = [];
    for (const b of this.backends) {
      for (const t of b.tools()) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    // Deterministic order (2026-07-28 SHOULD): sorted by name, so client
    // caches and LLM prompt caches see a stable listing regardless of
    // backend registration order or upstream response order.
    out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return out;
  }

  /**
   * Content origins for the response to this request (ADR-0065 phase 2b).
   *
   * Recomputed from the request body rather than stashed during `callTool`,
   * deliberately: the route instance is shared across concurrent requests, so a
   * field set by one call and read by the receipt path of another would attach
   * the wrong provenance to a signed commitment. Re-resolving the backend is a
   * cheap `handles()` scan and cannot race.
   *
   * Only `tools/call` has content ingress — `tools/list`, `initialize` and the
   * rest are cloister answering about itself, and an empty set is the true
   * statement for them rather than an omission.
   */
  private originsForRequest(bodyText: string, env: Env): OriginSet {
    try {
      const parsed = JSON.parse(bodyText) as { method?: unknown; params?: unknown };
      if (parsed.method !== "tools/call") return [];
      const params = (parsed.params ?? {}) as { name?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "") return [];
      const backend = this.backends.find((b) => b.handles(name));
      return backend?.contentOrigin?.(env) ?? [];
    } catch {
      // lint-allow-silent: a body that does not parse here already failed the
      // JSON-RPC parse upstream and produced an error response; the receipt for
      // it correctly claims no origins. Surfacing would turn a well-handled
      // client error into a receipt-emission failure.
      return [];
    }
  }

  private async callTool(
    req:   JsonRpcRequest,
    env:   Env,
    lease: VerifiedLease | undefined,
    nowMs: number,
  ): Promise<JsonRpcResponse> {
    const params = req.params as { name: string; arguments?: Record<string, unknown> };
    const name = params.name;
    const args = params.arguments ?? {};

    // ── bead_create interceptor (cloister-492c08) ──────────────────────────
    //
    // `bead_create` is the §13.4 cross-DO state-boundary write. ADR-0012
    // requires the BlobStore → BeadStore → TrustStore handoff; the
    // orchestrator runs that pipeline as a single tool call.
    //
    // Active only when the lease gate is ON (i.e. `lease` is defined).
    // In dev mode (INTERLACE_ROOT_PUBKEY unset), there is no cert/sig
    // material to write an attestation against, so we fall through to
    // the existing generic backend path — which still does the intra-DO
    // INSERT, just without the attestation row. This is the same
    // deployment-binding-presence pattern the rest of the lease surface
    // uses; it is NOT a per-request bypass.
    if (name === "bead_create" && lease !== undefined) {
      try {
        const result = await runBeadCreateOrchestrator({
          toolArgs: args,
          env,
          context: {
            peerFp:  lease.peerFp,
            scope:   lease.scope,
            certDer: lease.certDer,
            sig:     lease.sig,
          },
          nowMs,
        });
        return okResponse(req.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        if (e instanceof JsonRpcInvocationError) return errResponse(req.id, e.code, e.message);
        return errResponse(req.id, -32603, e instanceof Error ? e.message : String(e));
      }
    }

    const backend = this.backends.find(b => b.handles(name));
    if (!backend) return errResponse(req.id, -32601, `unknown tool: ${name}`);
    // Pass the calling peer's fingerprint so HttpForward backends can
    // answer upstream `roots/list` reverse-RPCs from the per-peer cache
    // (cloister-65a30f). Anonymous-mode tests get the sentinel key.
    const peerFp = lease?.peerFp ?? ANONYMOUS_PEER;
    try {
      const result = await backend.invoke(name, args, env, peerFp);
      return okResponse(req.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      if (e instanceof JsonRpcInvocationError) return errResponse(req.id, e.code, e.message);
      return errResponse(req.id, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Pull the optional roots-capability declaration + optional inline
   * roots list out of an `initialize` request and update the per-peer
   * cache. No-op when neither is present; `setRoots` with an empty
   * list is intentionally a no-op too so we don't clobber a previously
   * populated cache with the absence of inline data.
   */
  private captureRootsFromInitialize(
    peerFp: string,
    rootsCapability: { listChanged?: boolean } | undefined,
    inlineRoots: unknown,
  ): void {
    if (rootsCapability && typeof rootsCapability === "object") {
      setCapability(peerFp, rootsCapability.listChanged === true);
    }
    const parsed = parseRootsArray(inlineRoots);
    if (parsed !== null) {
      setRoots(peerFp, parsed);
    }
  }

  /**
   * Fire `notifications/roots/list_changed` at every HttpForward
   * (mcp-proxy) backend in the gateway. Non-mcp-proxy backends (e.g.
   * durable-object beads) are skipped — they don't speak the proxy
   * wire. Fire-and-forget: notifications carry no `id` and we do not
   * await the result before returning to the caller. We use the
   * inflight Promise via `waitUntil` if available (not exposed on Env
   * today), otherwise the call simply runs in the background.
   */
  private fanOutRootsListChanged(env: Env): void {
    for (const b of this.backends) {
      if (b instanceof McpProxyToolBackend) {
        // Fire-and-forget. Errors inside `notifyRootsChanged` are
        // already swallowed at the backend boundary.
        void b.notifyRootsChanged(env);
      }
    }
  }
}

// ── Receipt-context builder (cloister-ae713f) ──────────────────────────────
//
// Reconstructs the canonical request bytes (the same input the lease
// middleware verified) so the emitter can hash them into `request_hash`.
// `nonce` is already on the `VerifiedLease`.
async function buildReceiptContext(
  env:      Env,
  nowMs:    number,
  request:  Request,
  bodyText: string,
  lease:    VerifiedLease,
): Promise<ReceiptEmissionContext | null> {
  // Re-derive `request_canon` exactly as the lease middleware did:
  // method + url + ts (server clock at verify time) + nonce + body.
  // The lease's `serverTs` is the same `nowMs` we snapshotted at the
  // start of `handlePost`, so this hash matches the receipt's
  // `request_hash` field invariant (§2.1).
  const requestCanon = canonicalRequestBytes(
    request.method,
    request.url,
    lease.serverTs,
    lease.nonce,
    bodyText,
  );
  return buildEmissionContext({
    env,
    nowMs,
    requestCanon,
    nonce: lease.nonce,
  });
}

// ── SSE handler ────────────────────────────────────────────────────────────

function handleSse(request: Request, env: Env): Response {
  const allowOrigin = pickAllowedOrigin(request, env.ALLOWED_ORIGINS);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const init: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: 0,
        result: { protocolVersion: SESSIONLESS_PROTOCOL_VERSION, capabilities: SERVER_CAPABILITIES },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(init)}\n\n`));
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); }
        catch { clearInterval(keepAlive); }
      }, KEEPALIVE_MS);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
    },
  });
}

// ── CORS helper for lease-error responses ─────────────────────────────────

function withCors(res: Response, allowOrigin: string): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  return new Response(res.body, { status: res.status, headers });
}

// ── Sessionless helpers ────────────────────────────────────────────────────

/**
 * Extract the `_meta` block from a JSON-RPC params payload. SEP-2575
 * places the per-request metadata (clientInfo, clientCapabilities,
 * protocolVersion) here; the key is conventionally `_meta` on the
 * params object.
 */
function extractMeta(params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const meta = p._meta ?? p["_meta"];
  if (!meta || typeof meta !== "object") return null;
  return meta as Record<string, unknown>;
}

/**
 * Best-effort extraction of the `subscriptions` field passed to
 * `subscriptions/listen`. Returned verbatim in the ack response so
 * clients can verify the request reached us; we do not currently emit
 * any notifications, so the field is informational.
 */
function extractSubscriptions(params: unknown): unknown {
  if (!params || typeof params !== "object") return [];
  const p = params as Record<string, unknown>;
  return p.subscriptions ?? [];
}

// ── Validation ────────────────────────────────────────────────────────────

function assertNoDuplicateToolNames(backends: readonly ToolBackend[]): void {
  const seen = new Set<string>();
  for (const b of backends) {
    for (const t of b.tools()) {
      if (seen.has(t.name)) {
        throw new Error(`duplicate tool name across backends: ${t.name}`);
      }
      seen.add(t.name);
    }
  }
}

/**
 * Best-effort parse of the optional inline `roots` field on an
 * external `initialize` request. Returns the parsed list (possibly
 * empty) if the input is an array of `{ uri: "file://..." }` objects;
 * returns `null` if the field is missing or malformed enough that we
 * cannot trust it. Entries with non-string `uri` are skipped; entries
 * whose `uri` doesn't start with `file://` are also skipped — the MCP
 * 2025-06-18 spec restricts roots to filesystem URIs at this time, and
 * silently storing other schemes would mask client bugs.
 */
function parseRootsArray(value: unknown): Root[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out: Root[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { uri?: unknown; name?: unknown };
    if (typeof obj.uri !== "string") continue;
    if (!obj.uri.startsWith("file://")) continue;
    const root: Root = { uri: obj.uri };
    if (typeof obj.name === "string") root.name = obj.name;
    out.push(root);
  }
  return out;
}
