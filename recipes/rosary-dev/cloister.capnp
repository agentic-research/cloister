# cloister.capnp — gateway manifest for the ART constellation deployment
# of cloister.
#
# This file is the source of truth for cloister's route table. It is
# compiled to `src/generated/manifest.ts` by `task manifest` and consumed
# by `src/index.ts` at build time. Editing this file replaces the
# previous TS-coded ROUTES array — see ADR-0004.
#
# To preview the resulting JSON without the codegen step:
#   capnp eval -I .. --no-standard-import cloister.capnp gateway -o json

@0xa1c0157e1a1f0001;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "cloister-art", version = "0.1.0"),

  # ── Interlace identity (ADR-0007) ────────────────────────────────────────
  # Empty `fingerprint` would disable .well-known/interlace/. The pinned
  # value below is a placeholder; real deployments override at build time.
  # Master public key bytes are loaded from INTERLACE_MASTER_PUBKEY env.
  actor = (
    fingerprint     = "sha256:placeholder-pinned-at-deploy-time",
    algorithm       = "ed25519",
    pubkeyBinding   = "INTERLACE_MASTER_PUBKEY",
    attestationRepo = "",
    tunnelEndpoint  = "",
  ),

  # ── Interlace policy ─────────────────────────────────────────────────────
  policy = (
    maxCertLifetimeSeconds = 300,
    requireInterlock       = true,
    minAlgorithm           = "ed25519",
  ),

  routes = [

    # ── /health ────────────────────────────────────────────────────────────
    ( path = "/health", kind = (health = void) ),

    # ── /.well-known/interlace/index.json (ADR-0007) ───────────────────────
    # Body synthesized at request time from this manifest's `actor`,
    # `policy`, and the capabilities aggregated across mcp routes.
    ( path = "/.well-known/interlace/index.json",
      kind = (wellKnownInterlace = void) ),

    # ── /interlace/peers/:fp → disclosure (ADR-0007 §11, threat model §9) ──
    # JSONL stream of peer_attestations + pending state for the requested
    # peer fingerprint. Lease-gated when INTERLACE_ROOT_PUBKEY is set
    # (scope `disclosure:<fp>`). HMAC-signed cursors via
    # INTERLACE_DISCLOSURE_HMAC_KEY. Failures are constant-time 404 to
    # avoid peer-existence + cert-validity oracles. cloister-bdef0c.
    ( path = "/interlace/peers/:fp", kind = (disclosure = void) ),

    # ── identity bridge → OIDC / WebFinger / Nostr NIP-05 (cloister-c9922f) ─
    # First non-MCP tenant. One Route declaration covers five concrete
    # paths because they all project the same identity surface
    # (manifest.actor + master pubkey at env[actor.pubkeyBinding]):
    #   GET  /.well-known/openid-configuration  — OIDC discovery
    #   GET  /.well-known/jwks.json             — JWK Set (Ed25519 / EdDSA)
    #   GET  /.well-known/webfinger             — JRD, ?resource=acct:cluster@host
    #   GET  /.well-known/nostr.json            — NIP-05 names + relays
    #   POST /oauth/token                       — client_credentials grant
    # The `path` below is a sentinel — the handler's match() inspects
    # the request URL and dispatches across all five paths internally.
    # See src/routes/well-known-identity.ts.
    ( path = "/.well-known/identity-bridge",
      kind = (wellKnownIdentityBridge = void) ),

    # ── OCI Distribution Spec v1.1 registry (cloister-cabd57) ──────────────
    # Phase 1 read-only pull path. One Route declaration covers every
    # `/v2/*` endpoint because the handler's URLPatterns match them all
    # internally. `path` below is a sentinel — the actual matching is:
    #   GET  /v2/                              — version handshake
    #   GET  /v2/_catalog                      — repo listing
    #   GET  /v2/<name>/tags/list              — tag listing
    #   HEAD /v2/<name>/manifests/<reference>  — existence check
    #   GET  /v2/<name>/manifests/<reference>  — manifest bytes
    #   HEAD /v2/<name>/blobs/<digest>         — existence check
    #   GET  /v2/<name>/blobs/<digest>         — blob bytes
    # Blob bytes flow from BlobStore (ADR-0003 phase 1); tag → manifest
    # mapping lives in TrustStore.registry_tags. Second non-MCP tenant.
    # See src/routes/oci-registry.ts.
    ( path = "/v2",
      kind = (ociRegistry = void) ),

    # ── MCP Registry OpenAPI surface (cloister-a30e40, ADR-0016) ───────────
    # Phase 3 of the MCP spec-alignment arc (ADR-0015). One Route
    # declaration covers the v0.1 server-discovery sub-paths because the
    # handler's URLPatterns match them internally:
    #   GET /.well-known/mcp-registry/v0.1/servers          — list
    #   GET /.well-known/mcp-registry/v0.1/servers/{name}   — detail
    # `path` below is a sentinel. The server catalog is synthesized
    # from this manifest's mcp routes (one server.json per externally-
    # shaped backend; httpForward + leylineNet today). Read-only in
    # this phase. See src/routes/well-known-mcp-registry.ts.
    ( path = "/.well-known/mcp-registry",
      kind = (wellKnownMcpRegistry = void) ),

    # ── /identity/* → notme service binding ────────────────────────────────
    ( path = "/identity",
      kind = (serviceBindingProxy = (
        binding      = "NOTME",
        upstreamHost = "notme-bot",
        stripPrefix  = "/identity",
      )),
    ),

    # ── /mcp → JSON-RPC + SSE, fanned out to ToolBackends ──────────────────
    ( path = "/mcp",
      kind = (mcp = (
        backends = [

          # bead_*  → BEAD_STORE Durable Object, keyed by `repo`.
          ( name          = "bead",
            handlesPrefix = "bead_",
            kind = (durableObject = (
              binding = "BEAD_STORE",
              keyArg  = "repo",
              # Tool input schemas live in src/tool-schemas/ (zod, single
              # source of truth — see cloister-7ca96c). build-manifest.mjs
              # injects them at codegen time; `inputSchemaJson = ""` here
              # is the explicit "use the TS schema" marker. Drift between
              # the two sources is a build error.
              tools = [
                ( name = "bead_create",
                  description     = "Create a new bead (work item) in the store for the given repo.",
                  inputSchemaJson = "" ),
                ( name = "bead_update",
                  description     = "Update fields on an existing bead.",
                  inputSchemaJson = "" ),
                ( name = "bead_search",
                  description     = "Full-text search beads by title/description.",
                  inputSchemaJson = "" ),
                ( name = "bead_list",
                  description     = "List beads, optionally filtered by state.",
                  inputSchemaJson = "" ),
                ( name = "bead_close",
                  description     = "Mark a bead as done.",
                  inputSchemaJson = "" ),
                ( name = "bead_comment",
                  description     = "Add a comment to a bead.",
                  inputSchemaJson = "" ),
              ],
            )),
          ),

          # lsp_*  → LLO_MCP_URL.
          # ADR-0015 Phase 1: migrated from `httpForward` → `mcpProxy`
          # (same shape, spec-aligned name).
          # cloister-b65a20: `serviceBinding = "LSP_MCP"` wins locally
          # (workerd `external` service); `urlBinding` stays populated
          # as the CF-prod fallback.
          ( name          = "lsp",
            handlesPrefix = "lsp_",
            kind = (mcpProxy = (
              urlBinding     = "LLO_MCP_URL",
              serviceBinding = "LSP_MCP",
              # Schemas in src/tool-schemas/lsp.ts; injected at build time.
              tools = [
                ( name = "lsp_hover",
                  description     = "Position-based LSP hover; resolves (file, line, col) to the node and returns hover text.",
                  inputSchemaJson = "" ),
                ( name = "lsp_defs",
                  description     = "Position-based LSP definitions.",
                  inputSchemaJson = "" ),
                ( name = "lsp_refs",
                  description     = "Position-based LSP references.",
                  inputSchemaJson = "" ),
                ( name = "lsp_symbols",
                  description     = "Document symbols for a file.",
                  inputSchemaJson = "" ),
                ( name = "lsp_diagnostics",
                  description     = "Diagnostics for a file. LLO enriches on demand if the file hasn't been parsed yet.",
                  inputSchemaJson = "" ),
              ],
            )),
          ),

          # reparse | enrich | status — exact-match (handlesPrefix = "")
          # because the upstream LLO daemon exposes them as bare names, not
          # under a prefix. Routes to the same LLO_MCP_URL as lsp_*.
          # ADR-0015 Phase 1: migrated from `httpForward` → `mcpProxy`.
          # cloister-b65a20: same Service-binding shape as `lsp` above.
          ( name          = "leyline-lifecycle",
            handlesPrefix = "",
            kind = (mcpProxy = (
              urlBinding     = "LLO_MCP_URL",
              serviceBinding = "LSP_MCP",
              # Schemas in src/tool-schemas/lifecycle.ts; injected at build time.
              tools = [
                ( name = "reparse",
                  description     = "Re-run tree-sitter parsing over the source tree (or a single file via `source`).",
                  inputSchemaJson = "" ),
                ( name = "enrich",
                  description     = "Run an enrichment pass (e.g. `lsp`, `embed`) optionally scoped to specific files.",
                  inputSchemaJson = "" ),
                ( name = "status",
                  description     = "Daemon lifecycle status: phase, head_sha, last_reparse_at_ms, per-pass enrichment.",
                  inputSchemaJson = "" ),
              ],
            )),
          ),


          # mache_*  → MACHE_MCP_URL with dynamicTools=true. mache exposes
          # ~17 MCP tools (get_overview, find_callers, search, …) on a
          # Streamable HTTP server. Cloister advertises them as `mache_*`
          # and strips the prefix on tools/call. Tools list is Derived
          # (ADR-0006) so mache evolving its catalog flows through without
          # manifest edits. Tracked in cloister-827d62.
          # ADR-0015 Phase 1: migrated from `httpForward` → `mcpProxy`
          # — this is the canonical example of an MCP-Proxy-Server upstream.
          # cloister-b65a20: `serviceBinding = "MACHE_MCP"` routes through
          # workerd's ExternalServer named `mache-mcp` in config.capnp,
          # bypassing the `internet` ACL entirely. `urlBinding` stays
          # populated as the CF-prod fallback.
          ( name          = "mache",
            handlesPrefix = "mache_",
            kind = (mcpProxy = (
              urlBinding      = "MACHE_MCP_URL",
              serviceBinding  = "MACHE_MCP",
              tools           = [],
              dynamicTools    = true,
              stripPrefix     = "mache_",
              requiresSession = true,
            )),
          ),

          # rsry_*  → ROSARY_MCP_URL — intentionally not exposed in this manifest.
          # See ADR-0005 (docs/adr/0005-internal-wire-leyline-net.md). The rosary
          # backend will land as `kind = (leylineNet = (...))` once
          # cloister-companion + the leylineNet kind ship; until then rsry tools
          # are reachable directly at ROSARY_MCP_URL, not through cloister.
          # Tracked in cloister-824849 (blocked-by ADR-0005).

        ],
      )),
    ),

  ],
);
