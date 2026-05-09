# config.capnp — cloister local workerd deployment
#
# Same bundle as Cloudflare, runs locally via workerd.
# No CF account needed.
#
# Usage:
#   pnpm run build:local        # bundle src/ → dist/index.js
#   npx workerd serve config.capnp --experimental
#   # → http://localhost:8787
#
# Or via apko image:
#   docker run -p 8787:8787 ghcr.io/agentic-research/cloister:latest

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "cloister",
      worker = .cloisterWorker,
    ),

    # Internet access — for proxying to rosary (ROSARY_MCP_URL), ley-line-open
    # (LLO_MCP_URL — usually via notme-proxy in prod), and signet.
    ( name = "internet",
      network = (
        allow = ["public"],
      ),
    ),

    # Local disk for DO SQLite storage (one DB file per BeadStore instance)
    ( name = "do-storage",
      disk = (
        path = "/data/do",
        writable = true,
      ),
    ),

    # notme identity authority — service binding for /identity/* proxy.
    # Start notme separately: wrangler dev in ../notme/worker --port 8788
    # Remove this service entry if running cloister standalone (identity/ will 503).
    ( name = "notme-bot",
      network = (
        allow = ["localhost:8788"],
      ),
    ),
  ],

  sockets = [
    ( name = "http",
      address = "*:8787",
      http = (),
      service = "cloister",
    ),
  ],
);

const cloisterWorker :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  compatibilityFlags = ["nodejs_compat"],

  modules = [
    ( name = "worker",
      esModule = embed "dist/index.js",
    ),
  ],

  bindings = [
    # BeadStore DO — bundle-layer, per-repo SQLite bead storage.
    ( name = "BEAD_STORE",
      durableObjectNamespace = "BeadStore",
    ),

    # TrustStore DO — hypervisor-layer, singleton per cluster. Holds
    # peer_lease_counters today; peer_attestations + vault planned per
    # ADR-0010 / ADR-0011. Added 2026-05-09 after the adversarial review
    # of the BeadStore/TrustStore split.
    ( name = "TRUST_STORE",
      durableObjectNamespace = "TrustStore",
    ),

    # notme-bot service binding — /identity/* proxy
    ( name = "NOTME",
      service = "notme-bot",
    ),

    # Non-workerd backends — HTTP URL vars
    ( name = "ROSARY_MCP_URL",
      text = "http://localhost:8383/mcp",
    ),
    # ley-line-open daemon HTTP MCP port — see ADR-0002. In prod this points
    # at notme-proxy which forwards over UDS to the daemon; in dev it's the
    # daemon directly. Empty disables LspToolBackend + LeylineLifecycleBackend.
    ( name = "LLO_MCP_URL",
      text = "http://localhost:8384/mcp",
    ),
    ( name = "SIGNET_URL",
      text = "",
    ),
    # cloister-companion endpoint (ADR-0005). Empty disables LeylineNet
    # backends; for local dev `task companion:stub` listens on :8385.
    ( name = "COMPANION_URL",
      text = "http://localhost:8385/mcp",
    ),
    # mache MCP HTTP endpoint (`mache serve --http :7532`). Used by the
    # mache_* backend with dynamicTools=true (ADR-0006). Empty disables it.
    ( name = "MACHE_MCP_URL",
      text = "http://localhost:7532/mcp",
    ),
  ],

  durableObjectNamespaces = [
    ( className = "BeadStore",
      uniqueKey = "cloister-beads-v1",
      enableSql = true,
    ),
    ( className = "TrustStore",
      uniqueKey = "cloister-trust-v1",
      enableSql = true,
    ),
  ],

  durableObjectStorage = (localDisk = "do-storage"),
  globalOutbound = "internet",
);
