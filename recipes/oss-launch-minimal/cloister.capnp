# cloister.capnp — Recipe: oss-launch-minimal
#
# Smallest viable cloister deployment. Demonstrates the
# substrate-as-MCP-proxy pattern with just enough surface to be useful:
#
#   - bead_*  — DO-backed BeadStore (intra-cluster)
#   - mache_* — code intelligence via mcpProxy (dynamic tools)
#
# Identity (notme), companion / leyline-net wires, OCI registry,
# disclosure endpoint, and identity-bridge are intentionally OUT.
# Add them back by upgrading to `agent-cluster` or `rosary-dev`.
#
# Preview without codegen:
#   capnp eval -I .. --no-standard-import cloister.capnp gateway -o json

@0xa1c0157e1a1f00aa;
using Cloister = import "/cloister/manifest/cloister.capnp";

const gateway :Cloister.Gateway = (
  metadata = (name = "cloister-oss-minimal", version = "0.1.0"),

  # Interlace identity disabled in the minimal recipe — no master pubkey,
  # no .well-known/interlace/ discovery doc. Set `fingerprint` and
  # populate `pubkeyBinding` to enable.
  actor = (
    fingerprint     = "",
    algorithm       = "ed25519",
    pubkeyBinding   = "",
    attestationRepo = "",
    tunnelEndpoint  = "",
  ),

  policy = (
    maxCertLifetimeSeconds = 300,
    requireInterlock       = false,
    minAlgorithm           = "ed25519",
  ),

  routes = [

    # ── /health ────────────────────────────────────────────────────────────
    ( path = "/health", kind = (health = void) ),

    # ── /mcp → JSON-RPC + SSE, two backends ────────────────────────────────
    ( path = "/mcp",
      kind = (mcp = (
        backends = [

          # bead_*  → BEAD_STORE Durable Object, keyed by `repo`.
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

          # mache_*  → MACHE_MCP_URL — code intelligence (Streamable HTTP).
          # Dynamic tools: cloister fetches `tools/list` upstream at request
          # time and namespaces every entry with `mache_`. ADR-0006.
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

        ],
      )),
    ),

  ],
);
