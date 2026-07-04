/**
 * AUTO-GENERATED — do not edit. Regenerate with `task manifest`.
 * Source: cloister.capnp
 * Schema: manifest/cloister.capnp
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
              "name": "rsry",
              "handlesPrefix": "rsry_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "ROSARY_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "stripPrefix": "",
                  "requiresSession": true,
                  "serviceBinding": "ROSARY_BUNDLE",
                  "claims": [
                    "rsry_bead_create",
                    "rsry_bead_search",
                    "rsry_bead_close",
                    "rsry_bead_update",
                    "rsry_bead_comment",
                    "rsry_bead_comment_list",
                    "rsry_bead_comment_update",
                    "rsry_bead_comment_delete",
                    "rsry_bead_link",
                    "rsry_bead_import",
                    "rsry_list_beads",
                    "rsry_status",
                    "rsry_active",
                    "rsry_dispatch",
                    "rsry_dispatch_record",
                    "rsry_dispatch_history",
                    "rsry_scan",
                    "rsry_review",
                    "rsry_run_once",
                    "rsry_decompose",
                    "rsry_decade_list",
                    "rsry_decade_create",
                    "rsry_thread_list",
                    "rsry_thread_create",
                    "rsry_thread_assign",
                    "rsry_thread_reparent",
                    "rsry_workspace_create",
                    "rsry_workspace_checkpoint",
                    "rsry_workspace_cleanup",
                    "rsry_workspace_merge",
                    "rsry_repo_list",
                    "rsry_repo_register",
                    "rsry_pipeline_query",
                    "rsry_pipeline_upsert",
                    "rsry_ticket_load"
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
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "lsp_hover",
                    "lsp_defs",
                    "lsp_refs",
                    "lsp_symbols",
                    "lsp_diagnostics"
                  ]
                }
              }
            },
            {
              "name": "lifecycle",
              "handlesPrefix": "",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "status",
                    "snapshot",
                    "reparse",
                    "enrich"
                  ]
                }
              }
            },
            {
              "name": "sheaf",
              "handlesPrefix": "sheaf_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "sheaf_set_topology",
                    "sheaf_invalidate",
                    "sheaf_defect",
                    "sheaf_stalks",
                    "sheaf_status",
                    "sheaf_learned_weights"
                  ]
                }
              }
            },
            {
              "name": "query",
              "handlesPrefix": "",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "query",
                    "list_children",
                    "read_content",
                    "find_callers",
                    "find_defs",
                    "find_callees",
                    "get_refs_map",
                    "get_defs_map",
                    "get_schema",
                    "get_db_path",
                    "get_node",
                    "inspect_symbol",
                    "at_position",
                    "inspect_neighborhood",
                    "search_symbols",
                    "agreement"
                  ]
                }
              }
            },
            {
              "name": "wire",
              "handlesPrefix": "",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "leyline_version"
                  ]
                }
              }
            },
            {
              "name": "validate",
              "handlesPrefix": "",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "validate"
                  ]
                }
              }
            },
            {
              "name": "hdc",
              "handlesPrefix": "hdc_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "LLO_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "claims": [
                    "hdc_search",
                    "hdc_calibrate",
                    "hdc_density"
                  ]
                }
              }
            },
            {
              "name": "navigation",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "MACHE_MCP",
                  "claims": [
                    "list_directory",
                    "read_file",
                    "get_overview",
                    "get_architecture",
                    "get_diagram",
                    "get_communities"
                  ]
                }
              }
            },
            {
              "name": "callgraph",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "MACHE_MCP",
                  "claims": [
                    "find_callers",
                    "find_callees",
                    "find_definition",
                    "get_impact",
                    "search",
                    "resolve_ref"
                  ]
                }
              }
            },
            {
              "name": "mache/lsp",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "MACHE_MCP",
                  "claims": [
                    "get_type_info",
                    "get_diagnostics",
                    "semantic_search"
                  ]
                }
              }
            },
            {
              "name": "mache/lifecycle",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "MACHE_MCP",
                  "claims": [
                    "get_sheaf_status"
                  ]
                }
              }
            },
            {
              "name": "linter",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "MACHE_MCP",
                  "claims": [
                    "find_smells"
                  ]
                }
              }
            },
            {
              "name": "mutate",
              "handlesPrefix": "mache_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "MACHE_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "MACHE_MCP",
                  "claims": [
                    "write_file"
                  ]
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
