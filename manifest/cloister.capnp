# cloister.capnp — Gateway manifest schema (ADR-0004).
#
# A consumer repo declares a `Gateway` value at the root of its repo
# (typically <repo>/cloister.capnp). The cloister build pipeline compiles
# that value into a typed TS module which the runtime imports — no parsing
# at runtime. Schema violations crash the build, not the worker.
#
# This is the *registration format* sibling to /workerd/workerd.capnp's
# *runtime config*. Both files live alongside each other in this repo
# (config.capnp + manifest/cloister.capnp); they share a schema language
# and a parser by design.
#
# ── Schema-evolution rules ────────────────────────────────────────────────
# Capnp's wire-compat rules apply. Quoted from
# capnproto.org/language.html § "Evolving Your Protocol":
#
#   - "New fields, enumerants, and methods may be added to structs, enums,
#     and interfaces, respectively, as long as each new member's number is
#     larger than all previous members." — adding fields and union variants
#     at higher ordinals is safe.
#   - "You cannot change a field, method, or enumerant's number." —
#     renumbering @N tags is NEVER safe. Reassigning a retired ordinal to
#     a new field is equivalent to renumbering and equally forbidden. To
#     retire a field, leave its ordinal in place and stop populating it
#     (the docs don't have a literal "removing is unsafe" sentence; the
#     ordinal-stability rule is what makes deprecate-don't-remove the
#     correct discipline).
#   - "Any symbolic name can be changed, as long as the type ID / ordinal
#     numbers stay the same." — renaming a field is safe; names live in
#     codegen, never on the wire.
#
# When in doubt: add new fields, never reassign ordinals. Treat this file
# as forwards/backwards compatible — consumer manifests built against an
# older cloister must still parse here.

@0xb1d4f67c8c6e3b5a;

# ── Top-level: a complete gateway configuration ───────────────────────────

# One Gateway per workerd instance. A "constellation" deployment imports
# multiple per-repo gateways and concatenates their `routes` lists.
struct Gateway {
  metadata @0 :Metadata;
  routes   @1 :List(Route);

  # Interlace identity + policy (ADR-0007). Optional — leave fields empty
  # (`actor.fingerprint = ""`) to opt out of the .well-known/interlace/
  # discovery doc. The master public key is referenced by env-binding name
  # only; key bytes never appear in the manifest.
  actor    @2 :Actor;
  policy   @3 :InterlacePolicy;

  # Set of MCP protocol versions this gateway advertises support for.
  # Empty list ⇒ runtime default (current-spec "2025-11-25" only). Used by
  # the server-side `/mcp` route both in `initialize` responses (current
  # protocol) and in `server/discover` responses (sessionless / SEP-2575).
  # When sessionless is enabled, declare both the legacy and new version
  # strings here so dual-stack clients can pick.
  # ADR-0015 Phase 2 (cloister-a35fdb).
  supportedProtocolVersions @4 :List(Text);

  # `cloister/credential-isolation/v1` service registry (cloister-8f57f0,
  # ADR-0024). Each entry is a declared (service-name → upstream-base-URL,
  # injection strategy, allow-list, rate limit) tuple consumed by the
  # `vaultProxy` Route at instantiate time. The route's URL parser
  # (`/vault/proxy/<service>/<path>`) keys the lookup; an unknown service
  # collapses to the constant-shape 404 (preserves §9.4.b oracle closure).
  #
  # Empty list ⇒ no services declared; every `/vault/proxy/*` request
  # returns 404 (safe-closed default — same as the in-memory empty-store
  # behavior). Operators populate this in their `cloister.capnp` per the
  # spec at `leyline-schema-spec/credential-isolation/v1/`.
  vaultProxyServices @5 :List(VaultProxyService);
}

# ── cloister/credential-isolation/v1 service config (cloister-8f57f0) ────

struct VaultProxyService {
  # Logical service name — matches the URL path segment in
  # `/vault/proxy/<name>/<rest>`. Must be unique within the gateway's
  # vaultProxyServices list (the runtime asserts this at instantiate
  # time; duplicates are a TypeError).
  name @0 :Text;

  # Upstream base URL — credential is injected into requests against
  # this URL. The `<rest>` path segment from the inbound URL is
  # appended verbatim.
  upstreamBaseUrl @1 :Text;

  # Glob list of `peerFp` values authorized to use this service. Empty
  # list = deny-all (preserves the safe-closed default; operators
  # declare allowedSubs to opt callers in). Glob semantics match
  # `vault/src/vault.ts:checkAccess` — same matcher the vault DO uses.
  defaultAllowedSubs @2 :List(Text);

  # Per-(peerFp, service) bucket capacity in calls/minute. 0 = unlimited
  # (NOT recommended; documented as such in the vault-proxy handler).
  rateLimitPerMinute @3 :UInt32;

  # Where + how the credential is injected into the upstream request.
  # Discriminated union — the route handler dispatches on `kind`.
  # Closed-by-design in v1; adding a strategy requires a spec extension.
  injection :union {
    # `Authorization: Bearer <credential>` (OpenAI, Anthropic, ...)
    authorizationBearer @4 :Void;

    # `Authorization: Basic base64(<username>:<credential>)` —
    # `username` defaults to the service `name` when not supplied via
    # the credential-store seam.
    authorizationBasic  @5 :Void;

    # Arbitrary named header carrying the raw credential value (e.g.
    # `x-api-key: <credential>`).
    headerNamed         @6 :HeaderNamedSpec;

    # Query parameter carrying the URL-encoded credential.
    queryParam          @7 :QueryParamSpec;

    # JSON body field at a dotted path (e.g. `auth.client_secret`).
    # Buffers the request body to merge the credential at the named
    # path; incompatible with streaming bodies (handler-side tradeoff).
    bodyField           @8 :BodyFieldSpec;

    # Audit passthrough (ADR-0040 amendment): inject NOTHING. Forward the
    # caller's own request + auth headers to the upstream and emit the
    # receipt. For OAuth-subscription harnesses (Claude Code Max) where
    # there is no key to vault — cloister provides audit (receipts), not
    # custody. The credential-required 404 is skipped for this kind.
    passthrough         @9 :Void;
  }
}

struct HeaderNamedSpec { name @0 :Text; }
struct QueryParamSpec  { name @0 :Text; }
struct BodyFieldSpec   { path @0 :Text; }

# Interlace actor identity (ADR-0007). Pinned at build time; the
# corresponding master public key bytes are loaded from the env binding
# named by `pubkeyBinding`. Empty `fingerprint` disables Interlace discovery.
struct Actor {
  # SHA-256 fingerprint of the master public key, formatted as
  # "sha256:<hex>". Empty string ⇒ Interlace discovery disabled.
  fingerprint     @0 :Text;

  # Master-key signature algorithm: "ed25519" or "ml-dsa-44".
  algorithm       @1 :Text;

  # Name of the env-var binding holding the master public key in
  # SPKI / raw-bytes form (e.g. "INTERLACE_MASTER_PUBKEY"). Cloister's
  # discovery doc resolves this at runtime to publish the pubkey;
  # the key bytes themselves never appear in the manifest.
  pubkeyBinding   @2 :Text;

  # Where this actor publishes its bilateral attestation chains. Empty
  # string ⇒ in-DO storage (the BeadStore `peer_attestations` table per
  # ADR-0007). A URL points at an external git repo, IPFS pin, etc.
  attestationRepo @3 :Text;

  # Optional CF Tunnel hostname or other off-platform endpoint. Empty
  # string ⇒ the actor is reachable only via the standard public face
  # (its workerd Worker hostname).
  tunnelEndpoint  @4 :Text;
}

# Interlace policy declared in the .well-known/interlace/index.json
# doc — peers learn the actor's requirements before initiating.
struct InterlacePolicy {
  # Maximum lifetime (seconds) for ephemeral certs the actor will accept.
  # Defaults to 300 (5 min) per the spec; lower values tighten the
  # blast radius of cert compromise.
  maxCertLifetimeSeconds @0 :UInt32;

  # Whether peer interactions must carry interlock peer-refs (Interlace §6.2).
  # True ⇒ first-class bilateral chain; false ⇒ leases-only relationship.
  requireInterlock       @1 :Bool;

  # Minimum signature algorithm the actor will accept on incoming certs.
  # Stricter than the actor's own `algorithm` is allowed (e.g. actor
  # signs with ed25519 but only accepts ml-dsa-44 from peers).
  minAlgorithm           @2 :Text;
}

struct Metadata {
  # Logical name — "cloister-art", "cloister-mache", "cloister-constellation".
  # Distinct from cloister itself's version; this is the manifest's.
  name    @0 :Text;

  # Semver of this manifest. Bumped by the consumer when their slice changes.
  version @1 :Text;

  # The `_meta` extension namespace this deployment publishes under, e.g.
  # "art.cloister/v1". Projected from cluster.toml's [gateway.metadata].
  # Consumed by the MCP Registry route so the key is read rather than
  # hardcoded. Empty ⇒ runtime default.
  #
  # Append-only ordinal per ADR-0004.
  metaNamespace @2 :Text;
}

# ── Routes: the outer HTTP/SSE multiplexing layer (ADR-0002 §"EdgeRoute") ─

struct Route {
  # Path prefix. The router does first-match-wins over the routes list.
  path @0 :Text;

  kind :union {
    # GET <path> → liveness + backend snapshot (cf. src/routes/health.ts).
    health              @1 :Void;

    # GET|POST <path> → MCP edge (JSON-RPC + SSE), aggregating ToolBackends.
    mcp                 @2 :McpRouteSpec;

    # <path>/* → service binding (Fetcher), with optional prefix strip.
    serviceBindingProxy @3 :ServiceBindingProxySpec;

    # <path>/* → HTTP forward to a URL (read from env var binding).
    httpProxy           @4 :HttpProxySpec;

    # GET <path> → Interlace `.well-known` discovery doc, body synthesized
    # at request time from the Gateway's actor + policy fields and the
    # capabilities aggregated across the manifest's mcp routes.
    # See ADR-0007.
    wellKnownInterlace  @5 :Void;

    # GET <path>/:fp → Selective disclosure of peer_attestations rows
    # (cloister-bdef0c). Lease-gated when INTERLACE_ROOT_PUBKEY is set.
    # See ADR-0007 §11 + threat model §9.
    disclosure          @6 :Void;

    # Multi-format identity discovery bridge — surfaces the cluster's
    # native Interlace identity (actor.pubkey + capabilities) under the
    # OIDC, WebFinger, and Nostr NIP-05 well-known paths, plus a minimal
    # `client_credentials` token endpoint. First non-MCP tenant of the
    # router (per ADR-0002). One route entry covers five concrete paths
    # because they all derive from the same identity surface — adding a
    # path-per-format would multiply manifest entries with no semantic
    # gain. The handler internally dispatches by URL pathname; the
    # `path` on this Route is a sentinel marker (the actual paths are
    # `/.well-known/openid-configuration`, `/.well-known/jwks.json`,
    # `/.well-known/webfinger`, `/.well-known/nostr.json`,
    # `/oauth/token`). cloister-c9922f.
    wellKnownIdentityBridge @7 :Void;

    # OCI Distribution Spec (v1.1) registry — Phase 1 read-only pull
    # path (cloister-cabd57). The handler serves all v2/* endpoints
    # under one route declaration; `path` here is a sentinel marker.
    # URLPatterns inside the handler match `/v2/`, `/v2/_catalog`,
    # `/v2/<name>/tags/list`, `/v2/<name>/manifests/<ref>`, and
    # `/v2/<name>/blobs/<digest>`. Blob bytes flow from BlobStore;
    # the tag → manifest mapping lives in `TrustStore.registry_tags`.
    # Second non-MCP tenant after `wellKnownIdentityBridge` — together
    # they form the load-bearing demonstration that ADR-0002's
    # protocol-agnostic seam holds. Auth posture is anonymous pulls
    # in Phase 1; Phase 2 will add an `oci:push:<repo>` scope for writes.
    ociRegistry             @8 :Void;

    # MCP Registry OpenAPI surface — cloister as a private MCP Registry
    # (ADR-0016, cloister-a30e40). The handler serves all v0.1 server
    # discovery endpoints under one route declaration; `path` here is a
    # sentinel marker. URLPatterns inside the handler match:
    #
    #   - `GET /.well-known/mcp-registry/v0.1/servers`        (list)
    #   - `GET /.well-known/mcp-registry/v0.1/servers/{name}` (detail)
    #
    # The server catalog is synthesized from the manifest's mcp routes —
    # one server.json per externally-shaped backend (httpForward and
    # leylineNet today; DO-backed BeadStore is intra-cluster, omitted).
    # Read-only in this phase; write endpoints (`/publish`) are deferred.
    # See ADR-0016 + docs/integration/mcp-client.md §"Registry discovery".
    wellKnownMcpRegistry    @9 :Void;

    # Interlace 0.2.0 archival CA bundle endpoint (RECEIPTS.md §2.3, §2.7).
    # Serves GET /interlace/ca-bundle (list) and
    # GET /interlace/ca-bundle/<epoch> (per-epoch bundle).
    # V-archival verifiers fetch retired-epoch pubkeys + compromise notices
    # via this surface to replay receipts after key rotation.
    # Backed by TrustStore.actor_ca_bundle table (cloister-ae713f).
    caBundle                @10 :Void;

    # `cloister/credential-isolation/v1` route — ADR-0024, cloister-8f57f0.
    # Handler matches `/vault/proxy/<service>/<rest...>` internally; the
    # route's `path` is a sentinel marker. Lease-gated when
    # `INTERLACE_ROOT_PUBKEY` is set (deployment-binding granularity, same
    # contract as the MCP edge route).
    #
    # The five injection strategies (Bearer / Basic / named header /
    # queryParam / bodyField) + per-(peerFp, service) rate limit + audit
    # receipts + no-plaintext-leak invariants are all wired through the
    # handler in `src/routes/vault-proxy.ts` (29 baseline tests green per
    # PRs #29-#32). Credential-store seam in `src/routes/vault-proxy-
    # credential-store.ts` (PR #33).
    #
    # Carries a `VaultProxySpec` rather than Void so the operator can name
    # the `bundleIdName` the route uses to address its vault DO
    # (`env.VAULT_STORE.idFromName(bundleIdName)`). Per ADR-0021, each
    # bundle in the cluster gets its own DO instance via a distinct
    # `idFromName(...)` namespace. Pre-X-3 the literal `"router"` was
    # hardcoded in the route handler, so any second `vaultProxy` route
    # would collapse to the same DO + inherit the same MAX_INFLIGHT cap
    # (Bundle F4 + DoS F2 from the 2026-05-18 adversarial cycle).
    # Post-X-3 the manifest names the binding seam. Empty string
    # defaults to `"router"` for back-compat with single-bundle deploys.
    # Per cloister-6f06cc / X-3 cluster.
    vaultProxy              @11 :VaultProxySpec;

    # Per-tenant dispatch route (ADR-0030 §A2 / cloister-0f144c).
    # Routes inbound requests to the matching per-tenant workerd via a
    # service-binding Fetcher declared in config.capnp. Two match
    # modes (SNI + path-prefix) — operator picks per tenant in the
    # routing table.
    #
    # The route is the entry-point for multi-tenant deployments; lease
    # verification still happens BEFORE dispatch (the per-tenant scope
    # is part of lease verification per ADR-0007). Unknown tenant
    # collapses into a constant-time 404 per threat-model §13.7.1 (no
    # peer-existence oracle across tenants).
    tenantDispatch          @12 :TenantDispatchSpec;
  }
}

# ── TenantDispatchSpec (ADR-0030 §A2 / cloister-0f144c) ──────────────────
#
# Per-tenant dispatch table for the multi-tenant router. Each entry
# names a tenant + match mode + match value + service binding to
# forward to. The router does O(1) SNI hash-table lookup + first-match
# path-prefix scan; mixed mode is permitted (different tenants may use
# different modes within the same table).
#
# Operator declares the table in cluster.toml / cluster.capnp; the
# corresponding service bindings are declared in config.capnp /
# wrangler.toml (the standard cloister convention for Fetcher bindings
# to sibling Workers).

struct TenantDispatchSpec {
  # Table rows. First-match-wins (matters for path-prefix; SNI uniqueness
  # is asserted at instantiation).
  tenants @0 :List(TenantDispatchRow);
}

struct TenantDispatchRow {
  # Tenant identifier — must satisfy the kek-scope.ts tenantName
  # validator (a-z / 0-9 / hyphen / dot) so it can serve as the HKDF
  # info segment in cluster-tier KEK derivation (ADR-0030 §A3).
  name @0 :Text;

  # Match mode. Empty / unknown rejected at instantiation.
  #   "sni"         — exact host-header match against `matchValue`
  #   "path-prefix" — pathname starts-with match against `matchValue`;
  #                   the prefix is STRIPPED before forwarding so the
  #                   tenant sees the inner path
  mode @1 :Text;

  # Match value — interpretation depends on `mode`.
  #   For "sni":         the hostname (e.g. "alice.cluster.example.com")
  #   For "path-prefix": the path prefix (e.g. "/t/alice")
  matchValue @2 :Text;

  # Service binding name (Fetcher) to forward the request to. Must be
  # declared in config.capnp / wrangler.toml. The runtime calls
  # `env[binding].fetch(request)` after stripping the prefix (path-prefix
  # mode) or as-is (sni mode).
  binding @3 :Text;
}

# ── VaultProxySpec: per-route config for `vaultProxy` Route.kind ──────────
#
# Carries the per-bundle isolation seam (ADR-0021): the `bundleIdName`
# the route passes to `env.VAULT_STORE.idFromName(...)`. Each distinct
# `bundleIdName` yields a distinct vault DO instance with independent
# SQLite storage + independent rate buckets + independent inflight cap.
#
# Empty `bundleIdName` defaults to `"router"` (back-compat with
# single-bundle deploys that shipped before X-3 / cloister-6f06cc).
# A future schema-bridge / lint rule (lint:vault-proxy-bundle-id-name)
# asserts no two `vaultProxy` routes resolve to the same effective
# `bundleIdName` — would defeat the per-bundle isolation invariant.

struct VaultProxySpec {
  # Logical bundle name passed to `env.VAULT_STORE.idFromName(...)`.
  # Empty → defaults to "router". Each distinct value yields an
  # independent vault DO instance per ADR-0021.
  bundleIdName @0 :Text;
}

# ── McpRoute: the inner ToolBackend dispatch layer ────────────────────────

struct McpRouteSpec {
  backends @0 :List(Backend);
}

struct Backend {
  # Human-friendly id, must be unique within the McpRouteSpec.
  # Surfaced in error messages — keep stable across minor reconfigs.
  name          @0 :Text;

  # Tool-name prefix. Two backends sharing a prefix is a build error.
  # Used by ToolBackend.handles(toolName) for dispatch.
  handlesPrefix @1 :Text;

  kind :union {
    # bead_*-style: stub.fetch keyed by an arg (typically `repo`).
    durableObject  @2 :DoBackend;

    # OBSOLETE — ordinal @3 permanently reserved.
    #
    # Was the original `httpForward` MCP-Proxy-Server lifecycle binding
    # before ADR-0015 Phase 1 renamed it to `mcpProxy` at ordinal @7.
    # Capnp's wire-evolution rule forbids ordinal reuse, so this slot is
    # permanently held (the symbolic name is allowed to change but the
    # ordinal isn't). The runtime no longer dispatches this variant and
    # the TS BackendKind no longer accepts it — a manifest declaring
    # `httpForward = (...)` fails at the TS compilation step, not
    # silently at runtime.
    #
    # DO NOT REUSE @3 for any other field. DO NOT remove this declaration
    # without leaving an equivalent reserved-marker — capnp clients would
    # treat the slot as available otherwise.
    httpForward    @3 :HttpForwardBackend;

    # workerd Fetcher service binding (notme-bot, future internal Workers).
    serviceBinding @4 :ServiceBindingBackend;

    # Unix-domain-socket forward — placeholder; reserves the kind.
    udsForward     @5 :UdsForwardBackend;

    # leyline-net wire to cloister-companion (ADR-0005). cloister sends
    # capnp ToolCall frames over loopback HTTP; companion decodes, forwards
    # to the upstream by `upstreamId`, and returns a capnp ToolResult.
    # cloister-5183bc / cloister-46fc1a — backend wired.
    leylineNet     @6 :LeylineNetBackend;

    # MCP Proxy Server upstream (ADR-0015 Phase 1, SEP-XXXX).
    #
    # This is the spec-aligned form of the legacy `httpForward` variant.
    # The shape of `HttpForwardBackend` is unchanged; only the name and
    # the doc framing differ. Naming the kind `mcpProxy` makes the
    # implementor's mental model (and code-review attention) align with
    # the MCP Specification's Lifecycle and Security Best Practices
    # documents — see ADR-0015 for the rationale.
    #
    # New manifests should use this variant. The `httpForward` field
    # at ordinal @3 stays for one release as a deprecation alias.
    mcpProxy       @7 :HttpForwardBackend;
  }
}

# ── Backend kinds ─────────────────────────────────────────────────────────

struct DoBackend {
  # Name of the DurableObjectNamespace binding (e.g. "BEAD_STORE").
  binding @0 :Text;

  # Argument key whose value names the DO instance (e.g. "repo").
  # The runtime calls `ns.idFromName(args[keyArg])`.
  keyArg  @1 :Text;

  # Tools this backend advertises in tools/list. Aggregated across all
  # backends in this McpRouteSpec; duplicate names = build error.
  tools   @2 :List(McpTool);
}

struct HttpForwardBackend {
  # Name of the text-var binding holding the URL (e.g. "LLO_MCP_URL").
  #
  # Precedence: when `serviceBinding` (ordinal @6) is non-empty AND the
  # corresponding env binding is a workerd Fetcher (i.e. resolves via the
  # ServiceBinding-as-syscall path declared in config.capnp), the runtime
  # uses `env[serviceBinding].fetch(...)` and ignores `urlBinding`.
  # Otherwise it falls back to `fetch(env[urlBinding] + path)`. Both
  # fields are populated in the standard ART manifest so the same shape
  # works locally (Service binding → external server) and on CF prod
  # (URL var → public-internet fetch).
  urlBinding @0 :Text;

  # Asserted catalog. With `dynamicTools = false` (default) this is the full
  # tools/list cloister advertises for this backend. With `dynamicTools = true`
  # this is an *override* set: any name present here pins to the Asserted
  # schema even when the upstream Derived catalog includes the same name.
  # Empty list + dynamicTools=true means "fully Derived from upstream."
  tools      @1 :List(McpTool);

  # When true, cloister fetches `tools/list` from `urlBinding` at request
  # time and caches the result with a TTL (default 60s). Each upstream tool
  # is advertised as `${handlesPrefix}${upstream_name}`. See ADR-0006.
  dynamicTools @2 :Bool;

  # Prefix to remove from tool names before forwarding `tools/call`. For an
  # upstream that uses bare names (mache: `get_overview`) and is being
  # namespaced behind cloister (advertised as `mache_get_overview`), set
  # this to the namespace prefix (`"mache_"`). For an upstream that already
  # prefixes its tools (LLO: `lsp_hover`), leave empty — no stripping.
  stripPrefix @3 :Text;

  # When true, cloister speaks MCP Streamable HTTP per spec: POST `initialize`
  # first, capture the `Mcp-Session-Id` response header, send it on every
  # subsequent `tools/list` and `tools/call`. Required for mark3labs/mcp-go
  # servers (mache, rsry) which reject requests without a well-formed session
  # ID. Leave false for genuinely stateless upstreams (LLO daemon).
  requiresSession @4 :Bool;

  # Per-upstream protocol mode (ADR-0015 Phase 2 / SEP-2575 / SEP-2567):
  #   - "current" (default, empty string treated as same): legacy MCP
  #     2025-11-25 lifecycle. `initialize` + (optional) sessions.
  #   - "next":    sessionless. Every request carries the
  #     `MCP-Protocol-Version` HTTP header and a `_meta` block with
  #     `clientInfo`, `clientCapabilities`, `protocolVersion`. Catalog
  #     introspection goes through `server/discover` instead of
  #     `initialize`. No `Mcp-Session-Id` header. No
  #     `notifications/initialized` notification.
  #   - "auto":    try sessionless first; on a 400
  #     `UnsupportedProtocolVersionError` from the upstream, cache that
  #     fact and fall back to the legacy lifecycle. The cache lives for
  #     the lifetime of the binding (i.e. until cloister restarts).
  # Field is optional/append-only for back-compat with manifests built
  # against older schemas; absent ⇒ "current".
  protocolMode @5 :Text;

  # Name of a workerd Service binding (Fetcher) that resolves to this
  # backend (e.g. "MACHE_MCP"). When non-empty, the runtime calls
  # `env[serviceBinding].fetch(req)` instead of `fetch(env[urlBinding] + path)`.
  # This is the workerd-native shape: config.capnp declares an
  # `external = (address = "...", http = ())` service entry, and a Worker
  # `service` binding that points at it; the upstream traffic flows
  # through that named service rather than through the catch-all
  # `internet` egress (which would otherwise need to allow loopback or
  # private CIDRs to reach in-cluster bundles).
  #
  # When empty or unset, the runtime falls back to the legacy
  # `urlBinding`-based `fetch()`. Both fields are populated by the
  # standard ART manifest — the workerd-local config picks the Service
  # binding path; CF-prod (which can't declare `external` services)
  # picks the URL-var path. Append-only ordinal; introduced by
  # cloister-b65a20 alongside `external` service entries in
  # config.capnp.
  serviceBinding @6 :Text;

  # Explicit list of upstream tool names this backend handles. When
  # non-empty, the backend filters its derived (upstream `tools/list`)
  # output to just these names and advertises them verbatim (no
  # prefix-add). When empty (default), legacy behavior: filter the
  # derived set by `handlesPrefix` when non-empty, or claim everything
  # when both are empty (single-backend-per-upstream shape).
  #
  # Operators rarely write this by hand; the resolver (P3) populates
  # it from a server.json `_meta.art.cloister/v1.groups[].upstreamNames`
  # block so a single upstream MCP server can be split across N
  # backend declarations in the generated manifest. Per cloister-8ede3f.
  claims @7 :List(Text);
}

struct ServiceBindingBackend {
  # Name of the Fetcher binding.
  binding @0 :Text;

  tools   @1 :List(McpTool);
}

struct UdsForwardBackend {
  # Path to the UDS socket the upstream listens on (e.g.
  # "/run/cloister-uds/mache.sock"). workerd can't dial AF_UNIX from JS,
  # so the runtime POSTs a capnp ToolCall to cloister-companion (the
  # COMPANION_URL endpoint) with two HTTP headers:
  #   X-Cloister-Transport: uds
  #   X-Cloister-Socket-Path: <socketPath>
  # Companion then dials the socket and proxies the bytes. See
  # ADR-0005 amendment 2026-05-10 (cloister-46fc1a).
  socketPath @0 :Text;

  tools      @1 :List(McpTool);
}

# leyline-net backend (ADR-0005). cloister-companion endpoint named by
# `companionUrlBinding`; the companion routes by `upstreamId` to the
# actual backend (rsry/mache/notme/llo). Wire schema lives at
# wire/cloister.capnp; runtime is Phase 2D-codec / 2D-wire (cloister-5183bc).
struct LeylineNetBackend {
  # Name of the text-var binding holding cloister-companion's HTTP URL
  # (e.g. "COMPANION_URL", typically loopback like "http://127.0.0.1:9091").
  companionUrlBinding @0 :Text;

  # Logical id the companion uses to route to the actual upstream.
  # Companion-side configuration maps this to a transport (UDS / TCP / capnp-RPC).
  upstreamId          @1 :Text;

  tools               @2 :List(McpTool);
}

# ── Non-MCP routes ────────────────────────────────────────────────────────

struct ServiceBindingProxySpec {
  # Name of the Fetcher binding (e.g. "NOTME").
  binding      @0 :Text;

  # Hostname to use when constructing the upstream URL ("notme-bot").
  upstreamHost @1 :Text;

  # Prefix to strip from the request path before forwarding ("/identity").
  # Empty string = no strip.
  stripPrefix  @2 :Text;
}

struct HttpProxySpec {
  # Name of the text-var binding holding the upstream URL.
  urlBinding  @0 :Text;

  # Prefix to strip before forwarding (or empty).
  stripPrefix @1 :Text;
}

# ── MCP tool descriptor ───────────────────────────────────────────────────

struct McpTool {
  name            @0 :Text;
  description     @1 :Text;

  # JSON Schema for the tool's input. Stored as raw JSON text to round-trip
  # without losing fidelity — capnp doesn't model JSON Schema natively, and
  # the MCP wire format wants the JSON back verbatim. The runtime
  # `JSON.parse`s this once at startup.
  inputSchemaJson @2 :Text;
}
