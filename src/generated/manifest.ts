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
                    "enrich",
                    "reparse"
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
                    "sheaf_set_topology"
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
