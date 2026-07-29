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
    # leyline-sign-helper (ADR-0019) — the vault DO calls it via env.KEK_HELPER
    # to resolve keystore-backed KEK schemes (keychain://, op://, secret-tool://).
    # LOCAL-ONLY, like do-storage: the helper is a host binary (127.0.0.1:8786,
    # `task helper:start`); CF prod has no host access + resolves the KEK
    # differently, so this stays out of wrangler.toml. Closes threat-model §13.9.3
    # (ADR-0039 Phase 1) — keystore KEK schemes now reach the helper on serve:local.
    ( name = "kek-helper",
      external = ( address = "127.0.0.1:8786", http = () ),
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

    # CredentialVault KEK URL — picks where the vault DO resolves its
    # KEK from. MUST be a non-empty URL spec per ADR-0014 v2
    # (amendment 2026-05-12, cloister-125199). Empty throws at vault-DO
    # construction time with an actionable error pointing at
    # `task dev:bootstrap` (cloister-12e706).
    #
    # Supported schemes:
    #   - keychain://name             (macOS, via trust-anchor-helper)
    #   - secret-tool://name          (Linux libsecret, via helper)
    #   - file:///path/to/file        (CI, ephemeral file)
    #   - env://VAR?recipient=<URL>   (age-encrypted carrier; recipient
    #                                  resolved via another scheme —
    #                                  never plaintext)
    #   - http(s)://helper/...        (any HTTP-reachable secret service)
    #
    # The legacy `env://VAR=<plaintext>` carrier is gone. Plaintext key
    # material is not representable in committed config. The
    # VAULT_KEK_SECRET text binding from v1 has been deleted.
    ( name = "VAULT_KEK_SOURCE",
      text = "",
    ),

    # ── Trust-surface bindings (cloister-9aeb3f) ────────────────────────
    #
    # Declared with empty text for the same reason VAULT_KEK_SOURCE is:
    # plaintext key material is not representable in committed config, but
    # the BINDING must exist on this path or code reading it gets undefined
    # where the CF path gets a value. They were present in wrangler.toml and
    # absent here, which meant the lease gate, disclosure HMAC and receipt
    # signing could not be exercised under `serve:local` or `task smoke` at
    # all — a testability gap on exactly the surface the threat model treats
    # as the contract.
    #
    # Empty is NOT a posture change: resolveLeaseGate tests
    # `!!env.INTERLACE_ROOT_PUBKEY`, so "" reads as absent exactly as before
    # (ADR-0053 — no authority still enforces, then fails closed at
    # resolveCABundle). An operator supplies real values by overriding these
    # bindings, which is now possible where before it was not.
    ( name = "INTERLACE_ROOT_PUBKEY",
      text = "",
    ),
    ( name = "INTERLACE_MASTER_PUBKEY",
      text = "",
    ),
    ( name = "INTERLACE_DISCLOSURE_HMAC_KEY",
      text = "",
    ),
    ( name = "RECEIPT_SIGNING_KEY",
      text = "",
    ),
    ( name = "RECEIPT_EPOCH",
      text = "",
    ),
    ( name = "CANONICAL_HOURS_MCP_URL",
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
    # Vault DO → leyline-sign-helper for keystore-backed KEK resolution
    # (ADR-0019 / threat-model §13.9.3, ADR-0039 Phase 1). Local-only;
    # env.KEK_HELPER is typed `Fetcher | undefined`, so CF prod (no
    # binding, resolves KEK differently) is handled.
    ( name = "KEK_HELPER",
      service = "kek-helper",
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
