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
}

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
  }
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

    # HTTP forward via env-var-named URL (rosary, ley-line, mache).
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
