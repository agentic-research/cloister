# cluster.capnp — Cluster manifest schema (ADR-0009 Phase 1).
#
# Sibling to manifest/cloister.capnp. cloister.capnp declares the ROUTE
# TABLE of a single workerd Worker; cluster.capnp declares the BUNDLE
# TOPOLOGY of N processes deployed together as "the cluster."
#
# A consumer repo declares a `Cluster` value at the root (typically
# <repo>/cluster.capnp). The cloister build pipeline compiles that value
# into a typed TS module which the deployment emitters consume — no
# runtime parsing.
#
# This is the "Helm chart" of a cloister deployment: bundles + wires +
# storage policy. Three emitters consume it:
#
#   scripts/emit-compose.mjs  → docker-compose.yaml (nerdctl/podman/compose)
#   scripts/emit-pod.mjs      → k8s Pod manifest (multi-container, shared netns)
#   scripts/emit-dev.mjs      → task dev:all launcher (mac native, no containers)
#
# Per cloister-be0607 / ADR-0009 amendment 2026-05-10. The other ADR-0009
# substrate targets (Firecracker, WASI, unikernel) are NOT covered by
# this schema; Phase 1 ships workerd-on-OCI only.
#
# ── Schema-evolution rules (per ADR-0004) ─────────────────────────────────
# Capnp's wire-compat rules apply. New fields/variants append at higher
# ordinals; never renumber existing tags. Treat this file as
# forwards/backwards compatible — consumer manifests built against an
# older cloister must still parse here.

@0x801fbcc157921d1a;

# ── Top-level Cluster value ───────────────────────────────────────────────
#
# A consumer manifest declares one `Cluster` value. The cluster's name +
# version are mostly informational; bundles are the substantive payload.
struct Cluster {
  metadata @0 :ClusterMetadata;
  bundles  @1 :List(Bundle);
  wires    @2 :List(Wire);
  storage  @3 :StoragePolicy;
}

struct ClusterMetadata {
  name    @0 :Text;   # e.g. "art-default" — visible in container labels
  version @1 :Text;   # e.g. "0.1.0" — pinned at deploy time
}

# ── Bundle: a process within the cluster ──────────────────────────────────
#
# Each bundle is ONE unit of deployment. The `kind` union picks the
# substrate.
#
# Two bundle kinds in Phase 1:
#
#   workerd  — in-process v8 isolate inside cloister-router's workerd.
#              Useful for TS/JS tool bundles that should share the
#              router's request loop. The bundle becomes a service
#              binding inside workerd's config.capnp (no separate
#              process or container).
#
#   external — subprocess container running its own OCI image. Useful
#              for Go/Rust binaries (mache, rosary) that can't compile
#              to v8 isolates. Wire is capnp-over-UDS to a socket
#              mounted in a shared volume.
struct Bundle {
  name        @0 :Text;            # e.g. "cloister-router", "mache", "rosary"
  description @1 :Text;            # one-line; surfaces in container labels

  kind :union {
    workerd  @2 :WorkerdBundle;    # in-process v8 isolate
    external @3 :ExternalBundle;   # subprocess container
  }

  # Tier classification per ADR-0011's three-criterion test. Hypervisor-
  # tier bundles mediate between other bundles or to the outside; they
  # cannot be removed without breaking the cluster. Cluster-tier bundles
  # are user-deployable; removing one disables a feature but leaves the
  # cluster otherwise functional.
  #
  # The emitters treat both tiers identically at the runtime layer — the
  # classification is documentation + audit, not a runtime gate.
  tier @4 :Tier;

  # Credential bindings this bundle is allowed to hold. Each entry is a
  # workerd binding NAME (e.g. "VAULT_KEK_SOURCE", "VAULT_STORE",
  # "MASTER_SK_SOURCE") declared on the matching workerd Worker in
  # config.capnp. The bundle-isolation lint reads its credential allow-
  # list from this field — NOT from a hand-edited JS table. A binding
  # that grants credential material MUST appear here or the lint
  # rejects it.
  #
  # Per math-friend review of ADR-0018 (gap 2): the closed-world
  # CREDENTIAL_BINDINGS map in the lint script could silently de-protect
  # the master key when a new credential binding name lands. Sourcing
  # the allow-list from the manifest makes the trust boundary one
  # cluster.capnp edit, not one lint-script edit, and renames the
  # decision moment to "manifest review" instead of "lint review."
  #
  # Empty list (the common case) means this bundle holds no credentials.
  # Hypervisor-tier bundles that DO hold credentials list them here;
  # cluster-tier bundles MUST leave it empty (the lint enforces both).
  holdsCredential @5 :List(Text);

  # Workerd service name — the `services[].name` in config.capnp that
  # corresponds to this bundle. Used by the bundle-isolation lint as
  # the canonical join key between workerd-service-name (which has its
  # own naming conventions like "cloister") and cluster-bundle-name
  # (which has its own like "cloister-router"). The names usually
  # differ; without this field the lint relied on a hand-maintained
  # alias map (`{ cloister: "cloister-router" }`) that silently
  # mis-classified bundles on rename collisions.
  #
  # Per math-friend review of ADR-0018 (gap 3). If a bundle has no
  # corresponding workerd service (external-only bundle like mache or
  # rosary that doesn't run inside cloister-router's workerd), leave
  # this empty; the lint won't try to match it.
  workerdServiceName @6 :Text;

  # Free-form text rationale that explains WHY this bundle is hypervisor-
  # tier (per ADR-0011's three-criterion test: mediates trust, multi-
  # bundle blast, singleton). MUST be non-empty when `tier == "hypervisor"`
  # — the lint refuses unjustified tier promotion.
  #
  # Per math-friend review of ADR-0018 (gap 1): without this gate,
  # tier=hypervisor inherits all the lint's carve-outs (Inv 1 / Inv 2 /
  # Inv 4 exemptions) and the only safeguard is human code review of
  # the manifest. Surfacing the rationale in cluster.capnp forces the
  # promotion to be reviewed as a separate decision, not buried in a
  # one-line `tier = hypervisor` field change.
  #
  # Cluster-tier bundles may leave this empty; the field is required
  # only on the promotion path.
  hypervisorRationale @7 :Text;
}

enum Tier {
  hypervisor @0;   # cloister-router, BeadStore DO, TrustStore DO, BlobStore DO, notme
  cluster    @1;   # mache, rosary, crumb, llo, future tool bundles
}

# ── WorkerdBundle: in-process v8 isolate ──────────────────────────────────
#
# Reserved for TS/JS bundles that live INSIDE cloister-router's workerd.
# Phase 1 doesn't ship any of these (cloister-router IS itself the only
# workerd bundle and it's described by cloister.capnp, not here). Future
# tool bundles written in TS go here.
#
# The schema is present so the emitters can already account for them.
struct WorkerdBundle {
  # Path to the bundle's entry point, relative to the cloister source
  # tree. Compiled into the cloister-router workerd image.
  entryPoint @0 :Text;     # e.g. "src/bundles/my-tool/index.ts"
}

# ── ExternalBundle: subprocess container ──────────────────────────────────
#
# Most bundles in Phase 1 are external: cloister-router, mache, rosary,
# notme. Each ships as its own OCI image, runs as its own container.
struct ExternalBundle {
  # OCI image reference, e.g. "cloister:0.1.0" or
  # "ghcr.io/agentic-research/mache:0.8.0". Resolved by the runtime's
  # image pull; not validated at compile time.
  image @0 :Text;

  # UDS socket path the bundle listens on for capnp ToolCall traffic.
  # Bundles MUST share a volume mount that includes this path so wires
  # can reach across container boundaries. Convention: /run/cloister-uds/.
  ipcSocket @1 :Text;      # e.g. "/run/cloister-uds/mache.sock"

  # Optional TCP port — for bundles that ALSO want to be reachable over
  # HTTP (e.g. cloister-router itself exposes /mcp on a TCP port for
  # external clients). Bundles that are UDS-only set this to "" / 0.
  httpPort @2 :UInt16;     # 0 = no TCP listener

  # Container-startup command-line args. Emitters splice these into the
  # entrypoint. Most bundles need at minimum the `--ipc-socket <path>`
  # flag; declaring it here keeps the manifest self-describing.
  args @3 :List(Text);

  # Environment variables to set inside the container. KV pairs.
  env @4 :List(EnvVar);
}

struct EnvVar {
  name  @0 :Text;
  value @1 :Text;
}

# ── Wire: service-binding relationship between bundles ────────────────────
#
# A wire declares "bundle A talks to bundle B via env var BINDING". The
# emitters use this to:
#   - inject env var BINDING into A's container, set to B's ipcSocket
#     path (for external bundles) or workerd service-binding name (for
#     workerd bundles)
#   - ensure A and B share the volume mount holding the UDS file
#   - validate the wire at compile time: `from`/`to` must reference
#     declared bundles
#
# Wires are directional. Bidirectional comms = two wires.
struct Wire {
  from    @0 :Text;        # source bundle name
  to      @1 :Text;        # target bundle name
  binding @2 :Text;        # env var name on `from`'s container

  # Transport kind. Intra-cluster is plain capnp over UDS (per ADR-0005
  # amendment 2026-04-30: no AEAD inside the trust boundary). The
  # leylineNet variant is reserved for cross-cluster wires that need
  # signed-capnp + AEAD; not used in Phase 1 cluster-in-a-pod.
  transport :union {
    uds        @3 :Void;   # capnp ToolCall over UDS (default, intra-cluster)
    leylineNet @4 :Void;   # signed capnp + AEAD (cross-cluster; future)
  }
}

# ── StoragePolicy: durable state mounts ───────────────────────────────────
#
# Durable Object SQLite files need a writable volume that survives
# container restarts. Phase 1 ships one volume mount; future revisions
# may split into per-DO volumes for finer-grained backup policy.
#
# IMPORTANT — drift coupling:
#   - apko.yaml creates `/data` + `/data/do` (uid 65532) at image build
#   - config.capnp's `do-storage` service points workerd at `/data/do`
#   - this field MUST agree with both. Lint pending under cloister-7c12cc.
#
# Don't change the path without updating apko.yaml + config.capnp in
# the same commit.
struct StoragePolicy {
  # Host path where DO storage is mounted. Default `/data/do` matches
  # the apko image's pre-created directory + workerd's localDisk service.
  # Operators MAY override per deployment (e.g. k8s PVC mounted elsewhere)
  # but the override has to match all three places.
  doStoragePath @0 :Text;
}
