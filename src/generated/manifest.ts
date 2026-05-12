/**
 * AUTO-GENERATED — do not edit. Regenerate with `task manifest`.
 * Source: cloister.capnp
 * Schema: manifest/cloister.capnp
 * Built:  2026-05-12T19:58:09.780Z
 */
import type { Gateway } from "../manifest/types.js";

export const manifest: Gateway = {
  "metadata": {
    "name": "cloister-art",
    "version": "0.1.0"
  },
  "routes": [
    {
      "path": "/health",
      "kind": {
        "health": null
      }
    },
    {
      "path": "/.well-known/interlace/index.json",
      "kind": {
        "wellKnownInterlace": null
      }
    },
    {
      "path": "/interlace/peers/:fp",
      "kind": {
        "disclosure": null
      }
    },
    {
      "path": "/.well-known/identity-bridge",
      "kind": {
        "wellKnownIdentityBridge": null
      }
    },
    {
      "path": "/v2",
      "kind": {
        "ociRegistry": null
      }
    },
    {
      "path": "/.well-known/mcp-registry",
      "kind": {
        "wellKnownMcpRegistry": null
      }
    },
    {
      "path": "/interlace/ca-bundle",
      "kind": {
        "caBundle": null
      }
    },
    {
      "path": "/identity",
      "kind": {
        "serviceBindingProxy": {
          "binding": "NOTME",
          "upstreamHost": "notme-bot",
          "stripPrefix": "/identity"
        }
      }
    },
    {
      "path": "/mcp",
      "kind": {
        "mcp": {
          "backends": [
            {
              "name": "bead",
              "handlesPrefix": "bead_",
              "kind": {
                "durableObject": {
                  "binding": "BEAD_STORE",
                  "keyArg": "repo",
                  "tools": [
                    {
                      "name": "bead_create",
                      "description": "Create a new bead (work item) in the store for the given repo.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"},\"priority\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":4},\"labels\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"created_by\":{\"type\":\"string\"}},\"required\":[\"repo\",\"title\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "bead_update",
                      "description": "Update fields on an existing bead.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"id\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"},\"state\":{\"type\":\"string\",\"enum\":[\"open\",\"in_progress\",\"done\",\"blocked\"]},\"priority\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":4},\"labels\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"notes\":{\"type\":\"string\"}},\"required\":[\"repo\",\"id\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "bead_search",
                      "description": "Full-text search beads by title/description.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"query\":{\"type\":\"string\"}},\"required\":[\"repo\",\"query\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "bead_list",
                      "description": "List beads, optionally filtered by state.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"state\":{\"type\":\"string\",\"enum\":[\"open\",\"in_progress\",\"done\",\"blocked\"]}},\"required\":[\"repo\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "bead_close",
                      "description": "Mark a bead as done.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"id\":{\"type\":\"string\"}},\"required\":[\"repo\",\"id\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "bead_comment",
                      "description": "Add a comment to a bead.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"repo\":{\"type\":\"string\"},\"id\":{\"type\":\"string\"},\"body\":{\"type\":\"string\"},\"author\":{\"type\":\"string\"}},\"required\":[\"repo\",\"id\",\"body\"],\"additionalProperties\":false}"
                    }
                  ]
                }
              }
            },
            {
              "name": "lsp",
              "handlesPrefix": "lsp_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [
                    {
                      "name": "lsp_hover",
                      "description": "Position-based LSP hover; resolves (file, line, col) to the node and returns hover text.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"line\":{\"type\":\"integer\",\"minimum\":-9007199254740991,\"maximum\":9007199254740991},\"col\":{\"type\":\"integer\",\"minimum\":-9007199254740991,\"maximum\":9007199254740991}},\"required\":[\"file\",\"line\",\"col\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "lsp_defs",
                      "description": "Position-based LSP definitions.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"line\":{\"type\":\"integer\",\"minimum\":-9007199254740991,\"maximum\":9007199254740991},\"col\":{\"type\":\"integer\",\"minimum\":-9007199254740991,\"maximum\":9007199254740991}},\"required\":[\"file\",\"line\",\"col\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "lsp_refs",
                      "description": "Position-based LSP references.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"line\":{\"type\":\"integer\",\"minimum\":-9007199254740991,\"maximum\":9007199254740991},\"col\":{\"type\":\"integer\",\"minimum\":-9007199254740991,\"maximum\":9007199254740991}},\"required\":[\"file\",\"line\",\"col\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "lsp_symbols",
                      "description": "Document symbols for a file.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"}},\"required\":[\"file\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "lsp_diagnostics",
                      "description": "Diagnostics for a file. LLO enriches on demand if the file hasn't been parsed yet.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"}},\"required\":[\"file\"],\"additionalProperties\":false}"
                    }
                  ],
                  "dynamicTools": false,
                  "requiresSession": false,
                  "serviceBinding": "LSP_MCP"
                }
              }
            },
            {
              "name": "leyline-lifecycle",
              "handlesPrefix": "",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [
                    {
                      "name": "reparse",
                      "description": "Re-run tree-sitter parsing over the source tree (or a single file via `source`).",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"source\":{\"type\":\"string\"},\"lang\":{\"type\":\"string\"}},\"additionalProperties\":false}"
                    },
                    {
                      "name": "enrich",
                      "description": "Run an enrichment pass (e.g. `lsp`, `embed`) optionally scoped to specific files.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{\"pass\":{\"type\":\"string\"},\"files\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"pass\"],\"additionalProperties\":false}"
                    },
                    {
                      "name": "status",
                      "description": "Daemon lifecycle status: phase, head_sha, last_reparse_at_ms, per-pass enrichment.",
                      "inputSchemaJson": "{\"type\":\"object\",\"properties\":{},\"additionalProperties\":false}"
                    }
                  ],
                  "dynamicTools": false,
                  "requiresSession": false,
                  "serviceBinding": "LSP_MCP"
                }
              }
            },
            {
              "name": "mache",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "stripPrefix": "mache_",
                  "requiresSession": true,
                  "serviceBinding": "MACHE_MCP"
                }
              }
            }
          ]
        }
      }
    }
  ],
  "actor": {
    "fingerprint": "sha256:placeholder-pinned-at-deploy-time",
    "algorithm": "ed25519",
    "pubkeyBinding": "INTERLACE_MASTER_PUBKEY",
    "attestationRepo": "",
    "tunnelEndpoint": ""
  },
  "policy": {
    "maxCertLifetimeSeconds": 300,
    "requireInterlock": true,
    "minAlgorithm": "ed25519"
  }
} as const;
