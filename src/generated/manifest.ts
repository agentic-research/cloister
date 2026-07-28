/**
 * AUTO-GENERATED — do not edit. Regenerate with `task manifest`.
 * Source: cloister.capnp
 * Schema: manifest/cloister.capnp
 */
import type { Gateway } from "../manifest/types.js";

export const manifest: Gateway = {
  "metadata": {
    "name": "cloister-art",
    "version": "0.1.0",
    "metaNamespace": "art.cloister/v1"
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
      "path": "/vault/proxy",
      "kind": {
        "vaultProxy": {
          "bundleIdName": "cloister-router"
        }
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
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "LSP_MCP",
                  "requiresSession": true,
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
                  "requiresSession": true,
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
                  "requiresSession": true,
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
                  "requiresSession": true,
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
                  "requiresSession": true,
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
                  "requiresSession": true,
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
                  "requiresSession": true,
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
                  "requiresSession": true,
                  "claims": [
                    "list_directory",
                    "read_file",
                    "get_overview",
                    "get_architecture",
                    "get_diagram",
                    "get_communities"
                  ],
                  "stripPrefix": "mache_"
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
                  "requiresSession": true,
                  "claims": [
                    "find_callers",
                    "find_callees",
                    "find_definition",
                    "get_impact",
                    "search",
                    "resolve_ref"
                  ],
                  "stripPrefix": "mache_"
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
                  "requiresSession": true,
                  "claims": [
                    "get_type_info",
                    "get_diagnostics",
                    "semantic_search"
                  ],
                  "stripPrefix": "mache_"
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
                  "requiresSession": true,
                  "claims": [
                    "get_sheaf_status"
                  ],
                  "stripPrefix": "mache_"
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
                  "requiresSession": true,
                  "claims": [
                    "find_smells"
                  ],
                  "stripPrefix": "mache_"
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
                  "requiresSession": true,
                  "claims": [
                    "write_file"
                  ],
                  "stripPrefix": "mache_"
                }
              }
            },
            {
              "name": "rosary",
              "handlesPrefix": "rsry_",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "ROSARY_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "serviceBinding": "ROSARY_BUNDLE",
                  "requiresSession": true,
                  "claims": [
                    "rsry_bead_create",
                    "rsry_bead_update",
                    "rsry_bead_search",
                    "rsry_bead_close",
                    "rsry_bead_link",
                    "rsry_bead_import",
                    "rsry_bead_history",
                    "rsry_bead_comment",
                    "rsry_bead_comment_list",
                    "rsry_bead_comment_update",
                    "rsry_bead_comment_delete",
                    "rsry_status",
                    "rsry_list_beads",
                    "rsry_scan",
                    "rsry_active",
                    "rsry_ticket_load",
                    "rsry_review",
                    "rsry_expand_ref",
                    "rsry_dispatch",
                    "rsry_run_once",
                    "rsry_decompose",
                    "rsry_pipeline_upsert",
                    "rsry_pipeline_query",
                    "rsry_dispatch_record",
                    "rsry_dispatch_history",
                    "rsry_agent_run_event_record",
                    "rsry_agent_run_events",
                    "rsry_agent_session_addresses",
                    "rsry_agent_session_message_record",
                    "rsry_workspace_create",
                    "rsry_workspace_checkpoint",
                    "rsry_workspace_cleanup",
                    "rsry_workspace_merge",
                    "rsry_decade_create",
                    "rsry_decade_list",
                    "rsry_thread_create",
                    "rsry_thread_list",
                    "rsry_thread_assign",
                    "rsry_thread_reparent",
                    "rsry_repo_register",
                    "rsry_repo_list"
                  ]
                }
              }
            },
            {
              "name": "canonical-hours",
              "handlesPrefix": "",
              "kind": {
                "mcpProxy": {
                  "urlBinding": "CANONICAL_HOURS_MCP_URL",
                  "tools": [],
                  "dynamicTools": true,
                  "requiresSession": true,
                  "claims": [
                    "get_board",
                    "trigger_tick",
                    "resolve_addressed_review_threads",
                    "dismiss_stale_bot_reviews"
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
    "fingerprint": "",
    "algorithm": "ed25519",
    "pubkeyBinding": "INTERLACE_MASTER_PUBKEY",
    "attestationRepo": "",
    "tunnelEndpoint": ""
  },
  "policy": {
    "maxCertLifetimeSeconds": 300,
    "requireInterlock": true,
    "minAlgorithm": "ed25519"
  },
  "vaultProxyServices": [
    {
      "name": "anthropic",
      "upstreamBaseUrl": "https://api.anthropic.com",
      "defaultAllowedSubs": [],
      "rateLimitPerMinute": 120,
      "injection": {
        "headerNamed": {
          "name": "x-api-key"
        }
      }
    },
    {
      "name": "openai",
      "upstreamBaseUrl": "https://api.openai.com",
      "defaultAllowedSubs": [],
      "rateLimitPerMinute": 120,
      "injection": {
        "authorizationBearer": null
      }
    }
  ]
} as const;
