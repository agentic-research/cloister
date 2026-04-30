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

  routes = [

    # ── /health ────────────────────────────────────────────────────────────
    ( path = "/health", kind = (health = void) ),

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
              tools = [
                ( name        = "bead_create",
                  description = "Create a new bead (work item) in the store for the given repo.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"},\"priority\":{\"type\":\"integer\",\"enum\":[0,1,2,3,4]},\"labels\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"created_by\":{\"type\":\"string\"}},\"required\":[\"repo\",\"title\"]}"
                ),
                ( name        = "bead_update",
                  description = "Update fields on an existing bead.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"id\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"},\"state\":{\"type\":\"string\",\"enum\":[\"open\",\"in_progress\",\"done\",\"blocked\"]},\"priority\":{\"type\":\"integer\",\"enum\":[0,1,2,3,4]},\"labels\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"notes\":{\"type\":\"string\"}},\"required\":[\"repo\",\"id\"]}"
                ),
                ( name        = "bead_search",
                  description = "Full-text search beads by title/description.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"query\":{\"type\":\"string\"}},\"required\":[\"repo\",\"query\"]}"
                ),
                ( name        = "bead_list",
                  description = "List beads, optionally filtered by state.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"state\":{\"type\":\"string\",\"enum\":[\"open\",\"in_progress\",\"done\",\"blocked\"]}},\"required\":[\"repo\"]}"
                ),
                ( name        = "bead_close",
                  description = "Mark a bead as done.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"id\":{\"type\":\"string\"}},\"required\":[\"repo\",\"id\"]}"
                ),
                ( name        = "bead_comment",
                  description = "Add a comment to a bead.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"id\":{\"type\":\"string\"},\"body\":{\"type\":\"string\"},\"author\":{\"type\":\"string\"}},\"required\":[\"repo\",\"id\",\"body\"]}"
                ),
              ],
            )),
          ),

          # lsp_*  → LLO_MCP_URL.
          ( name          = "lsp",
            handlesPrefix = "lsp_",
            kind = (httpForward = (
              urlBinding = "LLO_MCP_URL",
              tools = [
                ( name        = "lsp_hover",
                  description = "Position-based LSP hover; resolves (file, line, col) to the node and returns hover text.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"line\":{\"type\":\"integer\",\"description\":\"Zero-based line.\"},\"col\":{\"type\":\"integer\",\"description\":\"Zero-based column.\"}},\"required\":[\"file\",\"line\",\"col\"]}"
                ),
                ( name        = "lsp_defs",
                  description = "Position-based LSP definitions.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"line\":{\"type\":\"integer\"},\"col\":{\"type\":\"integer\"}},\"required\":[\"file\",\"line\",\"col\"]}"
                ),
                ( name        = "lsp_refs",
                  description = "Position-based LSP references.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"line\":{\"type\":\"integer\"},\"col\":{\"type\":\"integer\"}},\"required\":[\"file\",\"line\",\"col\"]}"
                ),
                ( name        = "lsp_symbols",
                  description = "Document symbols for a file.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"}},\"required\":[\"file\"]}"
                ),
                ( name        = "lsp_diagnostics",
                  description = "Diagnostics for a file. LLO enriches on demand if the file hasn't been parsed yet.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"}},\"required\":[\"file\"]}"
                ),
              ],
            )),
          ),

          # reparse | enrich | status — exact-match (handlesPrefix = "")
          # because the upstream LLO daemon exposes them as bare names, not
          # under a prefix. Routes to the same LLO_MCP_URL as lsp_*.
          ( name          = "leyline-lifecycle",
            handlesPrefix = "",
            kind = (httpForward = (
              urlBinding = "LLO_MCP_URL",
              tools = [
                ( name        = "reparse",
                  description = "Re-run tree-sitter parsing over the source tree (or a single file via `source`).",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"source\":{\"type\":\"string\"},\"lang\":{\"type\":\"string\"}}}"
                ),
                ( name        = "enrich",
                  description = "Run an enrichment pass (e.g. `lsp`, `embed`) optionally scoped to specific files.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{\"pass\":{\"type\":\"string\"},\"files\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"pass\"]}"
                ),
                ( name        = "status",
                  description = "Daemon lifecycle status: phase, head_sha, last_reparse_at_ms, per-pass enrichment.",
                  inputSchemaJson = "{\"type\":\"object\",\"properties\":{}}"
                ),
              ],
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
