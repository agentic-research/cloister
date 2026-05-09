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
# Capnp's wire-compat rules apply. Specifically:
#
#   - Adding a new field at the end of a struct is safe.
#   - Adding a new variant to a union is safe IFF you bump union ordinals
#     contiguously and never reuse a retired one.
#   - Removing a field is NOT safe — mark it deprecated and stop populating it.
#   - Renumbering @N tags is NEVER safe — capnp identifies fields by ordinal,
#     not name.
#   - Renaming a field is safe (capnp uses ordinals); name is just for codegen.
#
# When in doubt: add new fields, never remove or renumber. Treat this file
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
    # signed-capnp frames over loopback HTTP; companion decodes, forwards
    # to the upstream by `upstreamId`, and returns a capnp ToolResult.
    # Backend kind is reserved here; runtime impl currently throws
    # "not yet implemented" (Phase 2D-skel) — see cloister-5183bc.
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
  # Path to the UDS socket. Placeholder — workerd's outbound is HTTP-only,
  # so this kind is realized by an external bridge (e.g. notme-proxy)
  # exposed as either a serviceBinding or httpForward at the cloister face.
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
