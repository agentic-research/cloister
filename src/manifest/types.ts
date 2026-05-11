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
  /**
   * Interlace identity (ADR-0007). Empty `actor.fingerprint` opts out of
   * the `/.well-known/interlace/` discovery doc.
   */
  actor:    Actor;
  /** Interlace policy advertised in the `.well-known/interlace/` doc. */
  policy:   InterlacePolicy;
  /**
   * MCP protocol versions this gateway advertises (ADR-0015 Phase 2 /
   * cloister-a35fdb / SEP-2575). Empty ⇒ runtime default of just the
   * current-spec version. Declare both the legacy ("2025-11-25") and
   * sessionless ("2026-XX-XX") version strings here for dual-stack
   * deployments.
   */
  supportedProtocolVersions?: readonly string[];
}

export interface Metadata {
  name:    string;
  version: string;
}

// ── Interlace identity + policy (ADR-0007) ────────────────────────────────

export interface Actor {
  /** "sha256:<hex>" — empty string disables Interlace discovery. */
  fingerprint:     string;
  /** "ed25519" | "ml-dsa-44" */
  algorithm:       string;
  /** Env-var binding name holding the master public key (SPKI/raw bytes). */
  pubkeyBinding:   string;
  /** URL to attestation chain repo, or empty for in-DO storage. */
  attestationRepo: string;
  /** Off-platform endpoint (CF Tunnel hostname, etc.), or empty. */
  tunnelEndpoint:  string;
}

export interface InterlacePolicy {
  /** Max ephemeral-cert lifetime (seconds). Spec default 300. */
  maxCertLifetimeSeconds: number;
  /** Peer interactions must carry interlock peer-refs (§6.2). */
  requireInterlock:       boolean;
  /** Minimum cert algorithm accepted from peers. */
  minAlgorithm:           string;
}

// ── Routes ────────────────────────────────────────────────────────────────

export interface Route {
  path: string;
  kind: RouteKind;
}

/**
 * Capnp unions encode in JSON as a single sibling field whose name is
 * the active variant's name and whose value is the variant's payload —
 * which TypeScript matches with the object-with-single-key shape below.
 *
 * This is the default `capnp eval -o json` behavior when the schema does
 * NOT use the `$jsonDiscriminator` / `$jsonFlatten` annotations from
 * `capnp/compat/json.capnp`. cloister's manifest schema uses neither,
 * so we can rely on the single-key form. capnproto.org doesn't document
 * the default in prose; the json.capnp annotation file is the
 * authoritative source for opt-in alternatives, and the absence of
 * those annotations on this schema implies the single-key default.
 */
export type RouteKind =
  | { health:                  null }
  | { mcp:                     McpRouteSpec }
  | { serviceBindingProxy:     ServiceBindingProxySpec }
  | { httpProxy:               HttpProxySpec }
  | { wellKnownInterlace:      null }
  | { disclosure:              null }
  /**
   * Multi-format identity discovery bridge (cloister-c9922f). First non-MCP
   * tenant. Handler internally serves five concrete paths derived from
   * the same identity surface:
   *
   *   - `/.well-known/openid-configuration`  (OIDC discovery, RFC 8414)
   *   - `/.well-known/jwks.json`             (RFC 7517 + RFC 8037 EdDSA)
   *   - `/.well-known/webfinger`             (JRD, RFC 7033)
   *   - `/.well-known/nostr.json`            (NIP-05)
   *   - `/oauth/token`                       (client_credentials grant)
   *
   * The route's `path` field is a sentinel marker — the handler matches
   * on the actual paths above via its own `match()`. See
   * `src/routes/well-known-identity.ts`.
   */
  | { wellKnownIdentityBridge: null }
  /**
   * OCI Distribution Spec (v1.1) registry, Phase 1 read-only pull path
   * (cloister-cabd57). Handler serves all `v2/*` endpoints under one
   * route declaration; the route's `path` is a sentinel marker. The
   * inner URLPatterns match:
   *
   *   - `GET  /v2/`                              (version handshake)
   *   - `GET  /v2/_catalog`                      (repo listing)
   *   - `GET  /v2/<name>/tags/list`              (tag listing)
   *   - `HEAD /v2/<name>/manifests/<reference>`  (existence check)
   *   - `GET  /v2/<name>/manifests/<reference>`  (manifest bytes)
   *   - `HEAD /v2/<name>/blobs/<digest>`         (existence check)
   *   - `GET  /v2/<name>/blobs/<digest>`         (blob bytes)
   *
   * Blob bytes flow from `BlobStore`; the tag → manifest mapping lives
   * in `TrustStore.registry_tags`. See `src/routes/oci-registry.ts`.
   */
  | { ociRegistry:             null }
  /**
   * MCP Registry OpenAPI surface — cloister as a private MCP Registry
   * (ADR-0016, cloister-a30e40). One Route declaration covers all the
   * v0.1 server-discovery sub-paths because the handler's URLPatterns
   * match them internally:
   *
   *   - `GET /.well-known/mcp-registry/v0.1/servers`         (list)
   *   - `GET /.well-known/mcp-registry/v0.1/servers/{name}`  (detail)
   *
   * The route's `path` is a sentinel marker — actual matching happens
   * inside the handler. The server catalog is synthesized from the
   * manifest's mcp routes (one server.json per externally-shaped
   * backend; httpForward + leylineNet today). Read-only in this phase.
   *
   * See `src/routes/well-known-mcp-registry.ts`.
   */
  | { wellKnownMcpRegistry:    null };

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
  /**
   * Per-upstream protocol mode (ADR-0015 Phase 2 / cloister-a35fdb /
   * SEP-2575 + SEP-2567):
   *
   *   - `"current"` (default; empty string treated identically): legacy
   *     MCP 2025-11-25 lifecycle. `initialize` + optional sessions.
   *   - `"next"`: sessionless. Each outbound request carries an
   *     `MCP-Protocol-Version` HTTP header and a `_meta` block with
   *     `clientInfo` / `clientCapabilities` / `protocolVersion`.
   *     Catalog introspection uses `server/discover`. No
   *     `Mcp-Session-Id`. No `notifications/initialized`.
   *   - `"auto"`: try sessionless first; on a 400
   *     `UnsupportedProtocolVersionError` response from the upstream,
   *     cache that fact and fall back to current-spec for the lifetime
   *     of the binding.
   */
  protocolMode?: string;
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
