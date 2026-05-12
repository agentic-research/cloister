# cloister.capnp — Recipe: agent-cluster
#
# Identity-on deployment. Bead + mache, plus rosary over leyline-net
# (signed wire to cloister-companion, per ADR-0005), plus notme identity
# proxy and the full set of well-known discovery endpoints.
#
# Preview without codegen:
#   capnp eval -I .. --no-standard-import cloister.capnp gateway -o json

@0xa1c0157e1a1f00bb;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "cloister-agent-cluster", version = "0.1.0"),

  # Pinned placeholder; real deployments override at build time.
  # Master public key bytes are loaded from INTERLACE_MASTER_PUBKEY env.
  actor = (
    fingerprint     = "sha256:placeholder-pinned-at-deploy-time",
    algorithm       = "ed25519",
    pubkeyBinding   = "INTERLACE_MASTER_PUBKEY",
    attestationRepo = "",
    tunnelEndpoint  = "",
  ),

  policy = (
    maxCertLifetimeSeconds = 300,
    requireInterlock       = true,
    minAlgorithm           = "ed25519",
  ),

  routes = [

    # ── /health ────────────────────────────────────────────────────────────
    ( path = "/health", kind = (health = void) ),

    # ── /.well-known/interlace/index.json (ADR-0007) ───────────────────────
    ( path = "/.well-known/interlace/index.json",
      kind = (wellKnownInterlace = void) ),

    # ── /interlace/peers/:fp → disclosure (ADR-0007 §11) ───────────────────
    ( path = "/interlace/peers/:fp", kind = (disclosure = void) ),

    # ── identity bridge → OIDC / WebFinger / Nostr NIP-05 ──────────────────
    ( path = "/.well-known/identity-bridge",
      kind = (wellKnownIdentityBridge = void) ),

    # ── MCP Registry OpenAPI surface (ADR-0016) ────────────────────────────
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

    # ── /mcp → JSON-RPC + SSE, bead + mache + rosary-over-leylineNet ──────
    ( path = "/mcp",
      kind = (mcp = (
        backends = [

          # bead_*  → BEAD_STORE Durable Object.
          ( name          = "bead",
            handlesPrefix = "bead_",
            kind = (durableObject = (
              binding = "BEAD_STORE",
              keyArg  = "repo",
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

          # mache_*  → MCP Streamable HTTP, dynamic tools, served through
          # workerd's `MACHE_MCP` external Service binding when local.
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

          # rsry_*  → leyline-net wire to cloister-companion (ADR-0005).
          # companion routes by `upstreamId` to the actual rosary process.
          ( name          = "rsry",
            handlesPrefix = "rsry_",
            kind = (leylineNet = (
              companionUrlBinding = "COMPANION_URL",
              upstreamId          = "rosary",
              tools               = [],
            )),
          ),

        ],
      )),
    ),

  ],
);
