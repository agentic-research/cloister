/**
 * TS mirror of the Cap'n Proto schema in `manifest/cloister.capnp`.
 *
 * The build pipeline (`task manifest`) compiles a consumer's `cloister.capnp`
 * to a typed JSON literal at `src/generated/manifest.ts` and types it as
 * `Gateway`. Schema and TS types are kept in sync by hand — `manifest/cloister.capnp`
 * is the source of truth; this file is a faithful mirror so consumers of the
 * generated module get end-to-end type safety.
 *
 * Schema-evolution rules: see comments in `manifest/cloister.capnp`. The TS
 * union types use object-with-single-key (matching capnp's JSON encoding of
 * unions) — exactly one variant key is present on each value.
 */

// ── Top-level ─────────────────────────────────────────────────────────────

export interface Gateway {
  metadata: Metadata;
  routes:   readonly Route[];
}

export interface Metadata {
  name:    string;
  version: string;
}

// ── Routes ────────────────────────────────────────────────────────────────

export interface Route {
  path: string;
  kind: RouteKind;
}

/**
 * Capnp unions encode as `{ <variant>: <value> }` in JSON — a single key
 * naming the active variant.
 */
export type RouteKind =
  | { health:              null }
  | { mcp:                 McpRouteSpec }
  | { serviceBindingProxy: ServiceBindingProxySpec }
  | { httpProxy:           HttpProxySpec };

export interface McpRouteSpec {
  backends: readonly Backend[];
}

export interface Backend {
  name:          string;
  handlesPrefix: string;
  kind:          BackendKind;
}

export type BackendKind =
  | { durableObject:  DoBackend }
  | { httpForward:    HttpForwardBackend }
  | { serviceBinding: ServiceBindingBackend }
  | { udsForward:     UdsForwardBackend }
  | { leylineNet:     LeylineNetBackend };

// ── Backend kinds ─────────────────────────────────────────────────────────

export interface DoBackend {
  binding: string;
  keyArg:  string;
  tools:   readonly McpToolSpec[];
}

export interface HttpForwardBackend {
  urlBinding:    string;
  tools:         readonly McpToolSpec[];
  /**
   * When true, `tools/list` is fetched from `urlBinding` at request time and
   * cached with a TTL. See ADR-0006. The `tools` field becomes an override
   * set: names present pin to the Asserted schema even when upstream emits
   * the same name; an empty list means "fully Derived from upstream."
   */
  dynamicTools?: boolean;
  /**
   * Prefix removed from tool names before forwarding `tools/call`. Empty or
   * absent ⇒ no stripping (matches today's behavior where upstream and
   * advertised names share a prefix, e.g. `lsp_*`).
   */
  stripPrefix?:  string;
  /**
   * When true, cloister performs the MCP Streamable HTTP `initialize`
   * handshake on first contact and sends the captured `Mcp-Session-Id` on
   * every subsequent request. Required for mark3labs/mcp-go upstreams.
   * Leave false for LLO-style genuinely-stateless servers.
   */
  requiresSession?: boolean;
}

export interface ServiceBindingBackend {
  binding: string;
  tools:   readonly McpToolSpec[];
}

export interface UdsForwardBackend {
  socketPath: string;
  tools:      readonly McpToolSpec[];
}

/**
 * leyline-net backend (ADR-0005). cloister sends signed-capnp wire frames
 * over loopback HTTP to cloister-companion at `companionUrlBinding`;
 * companion routes by `upstreamId` to the actual backend transport
 * (UDS/TCP/capnp-RPC). The wire schema lives at `wire/cloister.capnp`.
 */
export interface LeylineNetBackend {
  companionUrlBinding: string;
  upstreamId:          string;
  tools:               readonly McpToolSpec[];
}

// ── Non-MCP route kinds ───────────────────────────────────────────────────

export interface ServiceBindingProxySpec {
  binding:      string;
  upstreamHost: string;
  stripPrefix:  string;
}

export interface HttpProxySpec {
  urlBinding:  string;
  stripPrefix: string;
}

// ── MCP tool descriptor ───────────────────────────────────────────────────

/**
 * Wire shape from the manifest: input schema is JSON text. The runtime
 * `JSON.parse`s it once into an `McpTool` (defined in `src/types.ts`).
 */
export interface McpToolSpec {
  name:            string;
  description:     string;
  inputSchemaJson: string;
}
