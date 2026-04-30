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

  tools      @1 :List(McpTool);
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
