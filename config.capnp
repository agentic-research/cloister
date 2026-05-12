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

    # Internet egress — used by Workers as `globalOutbound` for any
    # outbound fetch() that does NOT route through a named service
    # binding. Per ADR-0013, cluster-tier bundles MUST NOT have
    # unrestricted egress; this entry stays public-only (the workerd
    # SSRF default) so the only way to reach an in-cluster upstream is
    # through an explicit ExternalServer + Service binding declared
    # below. Loopback / private-network egress is intentionally absent
    # — earlier shared-netns deployments needed `127.0.0.0/8` here to
    # reach localhost upstreams; cloister-b65a20 replaced that with
    # named-service routing so the ACL can stay tight.
    ( name = "internet",
      network = (
        allow = ["public"],
      ),
    ),

    # ── External upstreams (workerd-native, ExternalServer) ────────────────
    # Each entry routes a Service binding (below, on cloisterWorker) to a
    # specific back-end on the shared loopback network. workerd dispatches
    # `env[BINDING].fetch(req)` directly to `address`, ignoring `internet`
    # egress entirely — so the `internet` ACL can stay tight (`["public"]`)
    # without breaking in-cluster MCP traffic. Per ADR-0013 (the
    # service-binding-as-syscall enforcement model) and cloister-b65a20
    # (the refactor that adopted this shape).
    #
    # Addresses match cluster.compose.yaml's `network_mode:
    # service:cloister-router` topology — every cluster-tier bundle binds
    # to `localhost` on its declared port. To repoint at a different
    # transport (a private CIDR, a UDS path), change only the `address`
    # field on the relevant entry; the Worker-side binding stays
    # unchanged. The `http = ()` form selects unencrypted HTTP/1.1; use
    # `https = (...)` for TLS upstreams. See node_modules/workerd's
    # `workerd.capnp` ExternalServer struct.
    ( name = "mache-mcp",
      external = ( address = "127.0.0.1:7532", http = () ),
    ),
    ( name = "llo-mcp",
      external = ( address = "127.0.0.1:8384", http = () ),
    ),
    ( name = "rosary-mcp",
      external = ( address = "127.0.0.1:8383", http = () ),
    ),
    ( name = "companion-mcp",
      external = ( address = "127.0.0.1:8385", http = () ),
    ),

    # Local disk for DO SQLite storage (one DB file per BeadStore instance)
    ( name = "do-storage",
      disk = (
        path = "/data/do",
        writable = true,
      ),
    ),

    # notme identity authority — service binding for /identity/* proxy.
    # Start notme separately: wrangler dev in ../notme/worker --port 8788.
    # Remove this service entry if running cloister standalone (identity/
    # will 503).
    # Note: workerd's `network.allow` takes CIDR or the magic tokens
    # `public` / `private` — not host:port. The actual reachable
    # endpoint is configured via the NOTME service binding's URL
    # (env binding NOTME_URL, or wrangler.toml [[services]] entry).
    ( name = "notme-bot",
      network = (
        allow = ["public"],
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

    # BlobStore DO — hypervisor-layer, singleton per cluster. Content-
    # addressed substrate per ADR-0003 phase 1. Cross-DO bead_create
    # handoff (ADR-0012) relies on idempotent put. Added 2026-05-09
    # (cloister-960f68).
    ( name = "BLOB_STORE",
      durableObjectNamespace = "BlobStore",
    ),

    # CredentialVault DO — hypervisor-layer singleton vault. Per ADR-0010 +
    # ADR-0013. Envelope-encrypted (HKDF + AES-256-GCM); plaintext stays
    # in the DO. Library code lifted from notme/vault (cloister-9ad9eb).
    # Identity propagation from in-cluster bundles is unresolved until
    # the first workerd-bundle Worker lands.
    ( name = "VAULT_STORE",
      durableObjectNamespace = "CredentialVault",
    ),

    # CredentialVault KEK secret — derives the AES-GCM key wrapping each
    # credential's DEK. Local-dev placeholder; production sets via a
    # workerd secret-binding mechanism. Empty disables vault writes
    # (constructor throws on first putCredential when secret is unset).
    #
    # Legacy binding: when `VAULT_KEK_SOURCE` is unset the vault DO
    # behaves as if `VAULT_KEK_SOURCE=env://VAULT_KEK_SECRET`. Per
    # ADR-0014 (pluggable KEK source), the self-host story uses
    # `VAULT_KEK_SOURCE` with a `keychain://` / `file://` URL plus
    # the kek-helper sidecar instead — see GETTING-STARTED §9.
    ( name = "VAULT_KEK_SECRET",
      text = "local-dev-only-CHANGE-IN-PRODUCTION",
    ),

    # CredentialVault KEK URL — picks where the vault DO resolves its
    # KEK from. Empty (the default) → legacy env:// path. Set to
    # `keychain://com.cloister/kek` (with `KEK_HELPER` bound to the
    # kek-helper sidecar) for macOS self-host. Per ADR-0014.
    ( name = "VAULT_KEK_SOURCE",
      text = "",
    ),

    # notme-bot service binding — /identity/* proxy
    ( name = "NOTME",
      service = "notme-bot",
    ),

    # ── MCP upstream Service bindings (workerd-native) ─────────────────────
    # Each of these targets an ExternalServer declared above. The
    # HttpForwardBackend runtime prefers these over the matching `*_URL`
    # text var when both are set — config.capnp wins locally
    # (workerd-native shape), wrangler.toml's URL vars win on CF prod
    # (which can't declare external services). Per cloister-b65a20.
    ( name = "MACHE_MCP",
      service = "mache-mcp",
    ),
    ( name = "LSP_MCP",
      service = "llo-mcp",
    ),
    ( name = "ROSARY_MCP",
      service = "rosary-mcp",
    ),
    ( name = "COMPANION_MCP",
      service = "companion-mcp",
    ),

    # Non-workerd backends — HTTP URL vars. These remain populated as the
    # CF-prod fallback: on Cloudflare Workers, `external` services do not
    # exist, so the manifest's `urlBinding` path takes over (see
    # `wrangler.toml` for the prod story). Local workerd uses the Service
    # bindings above and ignores these for `mcpProxy` backends; they're
    # also still read by `httpProxy` outer-layer routes (which haven't
    # been migrated to the Service-binding shape yet).
    # TODO(b65a20-phase2): unify prod + dev under one binding shape.
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
    ( className = "BlobStore",
      uniqueKey = "cloister-blobs-v1",
      enableSql = true,
    ),
    ( className = "CredentialVault",
      uniqueKey = "cloister-vault-v1",
      enableSql = true,
    ),
  ],

  durableObjectStorage = (localDisk = "do-storage"),
  globalOutbound = "internet",
);
