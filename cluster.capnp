# cluster.capnp — Cluster topology for the ART default deployment.
#
# Sibling to cloister.capnp. cloister.capnp declares the routes the
# cloister-router Worker exposes; cluster.capnp declares the BUNDLE
# TOPOLOGY of N processes deployed together (mac dev, docker compose,
# or k8s pod).
#
# Compiled to `src/generated/cluster.ts` by `task cluster:manifest`.
# Consumed by emitters in scripts/emit-*.mjs.

@0xb1b1b1b1b1b1b1b1;
using Cluster = import "/cloister/manifest/cluster.capnp";

const cluster :Cluster.Cluster = (
  metadata = ( name = "art-default", version = "0.1.0" ),

  # ── Bundles: who runs in this cluster ──────────────────────────────────
  bundles = [

    # cloister-router: the gateway + DO state holder. Hypervisor tier
    # by ADR-0011's three-criterion test (mediates between bundles +
    # external; multi-bundle blast; singleton). Also the only TCP
    # listener — external clients hit /mcp + /interlace/peers/{fp} here.
    ( name = "cloister-router",
      description = "Gateway + Durable Object state (BeadStore, TrustStore, BlobStore)",
      tier = hypervisor,
      kind = (external = (
        image     = "cloister:0.1.0",
        ipcSocket = "/run/cloister-uds/router.sock",
        httpPort  = 8787,
        args      = [],
        env       = [],
      )),
    ),

    # notme-identity: cluster's identity authority. Mints Signet
    # ephemeral certs against the master pubkey it holds in its DO.
    # Hypervisor tier — every authenticated request transits through
    # this (lease verification follows the trail it sets up).
    ( name = "notme-identity",
      description = "Identity authority — Signet master CA, lease cert mint",
      tier = hypervisor,
      kind = (external = (
        image     = "notme:0.1.0",
        ipcSocket = "",                       # workerd Worker, HTTP-only
        httpPort  = 8788,
        args      = [],
        env       = [],
      )),
    ),

    # mache: code intelligence (Go binary, FUSE projection over the
    # source tree). Cluster tier — removing it disables `mache_*`
    # tools but doesn't break the cluster.
    ( name = "mache",
      description = "Code intelligence — symbol search, definitions, callgraph",
      tier = cluster,
      kind = (external = (
        image     = "mache:0.8.0",
        ipcSocket = "",
        httpPort  = 7532,                     # Binds localhost (shared net namespace)
        args      = ["serve", "--http", "localhost:7532"],
        env       = [],
      )),
    ),

    # rosary: bead orchestrator (Rust binary, dolt-backed work store).
    # Cluster tier — orchestrates work but removing it doesn't break
    # the gateway.
    ( name = "rosary",
      description = "Bead orchestrator — `rsry_bead_*` MCP tools, agent dispatch",
      tier = cluster,
      kind = (external = (
        image     = "rosary:0.2.0",
        ipcSocket = "/run/cloister-uds/rosary.sock",
        httpPort  = 0,                        # UDS only
        args      = ["mcp", "--ipc-socket", "/run/cloister-uds/rosary.sock"],
        env       = [],
      )),
    ),
  ],

  # ── Wires: who talks to whom ───────────────────────────────────────────
  wires = [
    # cloister-router → mache (for mache_* MCP tools)
    ( from = "cloister-router", to = "mache",
      binding = "MACHE_BUNDLE",
      transport = (uds = void) ),

    # cloister-router → rosary (for rsry_* MCP tools)
    ( from = "cloister-router", to = "rosary",
      binding = "ROSARY_BUNDLE",
      transport = (uds = void) ),

    # cloister-router → notme (for identity verification + /identity/* proxy)
    ( from = "cloister-router", to = "notme-identity",
      binding = "NOTME",
      transport = (uds = void) ),
  ],

  # ── Storage: where DO SQLite lives ─────────────────────────────────────
  storage = (
    doStoragePath = "/data/do"  # MUST match apko.yaml + config.capnp; see manifest/cluster.capnp StoragePolicy doc,
  ),
);
