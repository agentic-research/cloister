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
  # Per ADR-0026 / cloister-cf7a3b Phase 1a — composable inputs
  # (tools / skills / agent defs / bundles). Operator names the input
  # by `ref = "..."` + `version = "..."`; cloister resolves at compose
  # time. Empty list = no external inputs (back-compat with pre-Phase-1
  # cluster.toml). Resolver lands in Phase 1b (cloister-cf7a3b).
  inputs   @4 :List(InputSpec);
  # ── Routes (Phase 2 of "cloister.capnp as build artifact" arc,
  # cloister-345ad1 / ADR-0031) ──────────────────────────────────────────
  #
  # Route declarations the emitter lifts into the generated `cloister.capnp`
  # (Gateway value). Mirrors the Route struct + per-kind specs from
  # `manifest/cloister.capnp`. The operator authors routes alongside
  # bundles in `cluster.toml`; the emitter then projects the cluster's
  # routes into the Gateway schema at build time. Empty list = no routes
  # declared (back-compat with pre-Phase-2 cluster.toml that left route
  # declarations in hand-edited `cloister.capnp` shells).
  routes   @5 :List(Route);
  # ── Gateway (Phase 4a of "cloister.capnp as build artifact" arc,
  # cloister-c919d7 / ADR-0031) ──────────────────────────────────────────
  #
  # Operator-authored Gateway-level surface (metadata + actor + policy)
  # that the emitter lifts into the generated `cloister.capnp`. Mirrors
  # the `Cloister.Gateway` struct from `manifest/cloister.capnp` (same
  # rationale as `routes` above — cluster.capnp is the self-contained
  # operator schema; cloister.capnp is downstream).
  #
  # Phase 4a closes the gap left by Phase 2: previously the emitter
  # pinned `gateway.metadata` / `actor` / `policy` to ART-default
  # values (the cloister-art template), which made the per-recipe
  # `cloister.capnp` files hand-edited to preserve their distinctive
  # identity (Phase 3 Hybrid Model A). With this field populated, the
  # emitter consumes the TOML values; with it empty (back-compat for
  # pre-Phase-4a cluster.toml), the emitter falls through to the
  # ART-default template + emits a warning to stderr.
  #
  # Append-only ordinal per ADR-0004.
  gateway  @6 :Gateway;
  # ── Edges (Phase A of ADR-0030 multi-workerd substrate,
  # cloister-f289c8 / cloister-0e3004) ──────────────────────────────
  #
  # Cross-tenant edge declarations. Each entry names a `from` → `to`
  # tenant pair and the `app_protocol` label classifying the traffic.
  # Per ADR-0030 §A2 (router-table) + §A4 (app_protocol namespace).
  #
  # Empty list = no cross-tenant edges (single-tenant deployments are
  # the back-compat default; pre-ADR-0030 cluster.toml has no edges).
  #
  # Append-only ordinal per ADR-0004.
  edges    @7 :List(EdgeSpec);
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

  # ── perTenant (ADR-0034 / cloister-cedcf3 Phase 1, foundational) ─────
  #
  # When true, the emit-compose pipeline produces one bundle instance
  # PER tenant declared in the `tenantDispatch` route table, instead of
  # a single cluster-wide bundle. Each tenant gets its own container
  # with tenant-suffixed service name + tenant-scoped storage paths
  # (e.g. `BEADS_DIR=/data/<tenant>/beads` for the rosary bundle).
  #
  # Default: false. A `perTenant=true` bundle WITHOUT a `tenantDispatch`
  # route declared in `routes[]` is a lint error (Inv 7 extension —
  # tracked under cloister-cedcf3 Phase 2).
  #
  # Phase 1 (this field): operator can declare it; emit-compose
  # consumption is deferred to Phase 2. The schema is forward-compatible
  # — recipes can land with the field set, and the runtime ignores it
  # until emit-compose grows the awareness.
  #
  # Append-only ordinal per ADR-0004.
  perTenant @8 :Bool;

  # ── confinement (cloister-a34edc / cloister/confinement/v1) ─────────────
  #
  # This bundle's kernel-confinement declaration, conformant to LLO's
  # cloister/confinement/v1 §5 ConfinementManifest (leyline-schema-spec @
  # v0.7.3, SHA 2491ccd). All four dimensions are fail-closed default-DENY —
  # enforced at build time by lint:bundle-isolation Inv 11. The BLAKE3-256 of
  # the §6-canonical form is the `confinementDigest` committed to the bundle's
  # Interlace identity (lane-2) as cert extension OID 1.3.6.1.4.1.99999.1.7
  # (LLO v0.7.6). cloister parses + length-checks that claim at lease-verify
  # time (cloister-c80953); enforce-time drift-rejection against the enforced
  # manifest is the compute-substrate runner's job (ADR-0044). This facet
  # declares + attests. Omitted = no confinement declared.
  confinement @9 :Confinement;
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

  # Absolute binary path inside the guest rootfs. Host-runtime launch-plan
  # emission refuses to guess this from a bundle name or mutable image tag.
  entryPoint @5 :Text;

  # Enforcement backend requested by the operator. Current values are
  # "microvm" and "process"; the host runtime selects exactly and never
  # substitutes a weaker backend.
  executionMode @6 :Text;
}

struct EnvVar {
  name  @0 :Text;
  value @1 :Text;
}

# ── Confinement: cloister/confinement/v1 §5 ConfinementManifest ────────────
#
# The vendor-neutral kernel-confinement contract (LLO leyline-schema-spec
# confinement/v1 @ v0.7.3, SHA 2491ccd). Four orthogonal capability boundaries,
# every one fail-closed default-DENY: anything not explicitly allowed is denied
# at the kernel boundary; there is no "unrestricted" mode. Cloister emits the
# §6-canonical JSON + the BLAKE3-256 `confinementDigest` via cloister-cas — the
# conformance gate is rs/crates/cas/tests/confinement_digest.rs.
struct Confinement {
  fs               @0 :ConfinementFs;
  network          @1 :ConfinementNetwork;
  port             @2 :ConfinementPort;
  # §5 credentialSource: the vault backend URL (e.g. "keychain://…") validated
  # before nono::keystore::load_secret_by_ref. "" = no credential vending.
  credentialSource @3 :Text;
}

# §2 fs.allow — path prefixes at directory boundaries. mode "" = read-only,
# "rw" = read-write. Empty/omitted list = deny all filesystem access.
struct ConfinementFs {
  allow @0 :List(FsAllowEntry);
}
struct FsAllowEntry {
  path @0 :Text;
  mode @1 :Text;   # "" (read-only) | "rw"
}

# §3 network.allowHosts — egress hostname allow-list ("*." wildcard prefix
# permitted; other wildcards rejected). Empty/omitted = no egress at all.
struct ConfinementNetwork {
  allowHosts @0 :List(Text);
}

# §4 port.bind — a single listener port the bundle may bind (1024-65535; 0 = no
# listener) + optional bind address (default 127.0.0.1).
struct ConfinementPort {
  bind    @0 :UInt16;
  address @1 :Text;
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

# ── InputSpec: composable tool / skill / agent-def inputs ────────────────
#
# ADR-0026 + cloister-cf7a3b. Operator declares external inputs by
# logical name (`name`) + addressable reference (`ref`) + accepted
# version range (`version`). Cloister's resolver (Phase 1b — landing
# in a follow-up sub-bead) fetches + verifies + composes.
#
# Phase 1a (this schema add): operators CAN declare inputs in
# cluster.toml without erroring; the resolver is a no-op until Phase 1b
# wires it. This lets operators stage their declarations alongside the
# substrate work that consumes them.
#
# Phase 2 adds registry resolution; Phase 3 adds signature verification.
# See `docs/adr/0026-tool-composition-model.md`.

struct InputSpec {
  # Logical name used as the inputs-block key in cluster.toml. Must be
  # unique within the cluster. e.g. "rosary", "mache", "python-tools".
  name @0 :Text;

  # Addressable reference. Resolver picks the scheme:
  #   - "file:///abs/path" — local filesystem (dev escape hatch)
  #   - "https://host/path" — direct HTTPS fetch (Phase 1b)
  #   - "io.github.org/repo" — registry-resolved (Phase 2)
  ref @1 :Text;

  # Semver range OR exact version (no range = exact match).
  # Empty string = no constraint (resolver picks latest, NOT recommended).
  version @2 :Text;

  # Optional: pre-resolved digest. When present, the resolver MUST
  # verify the fetched bytes match this digest (defense against
  # registry / network tamper). Format: "sha256:<hex>".
  # Empty string = no pin; resolver writes one to cluster.lock.toml.
  digest @3 :Text;

  # Optional: dev-loop override pointing at a local checkout.
  # Format: "file:///abs/path". CI rejects manifests with non-empty
  # `from` (per ADR-0026 §"Why filesystem from = ... is the dev-loop
  # escape only"). Empty string = use `ref` resolution.
  from @4 :Text;


  # ── Lego-blocks capability declarations (ADR-0027 forward-compat) ──
  #
  # The substrate-as-kernel framing (cloister-1b59a2) treats every input
  # as a node in a capability lattice: studs out (provides), anti-studs
  # in (requires). The matchmaker at compose time connects studs ↔
  # anti-studs by capability name + version.
  #
  # Format: reverse-DNS capability identifier with version suffix, e.g.
  # "cloister/mcp-tool/v1", "cloister/credential-isolation/v1",
  # "cloister/skill/v1", "cloister/data-backend/v1".
  #
  # Phase 1a: schema only — fields land, resolver is a no-op, matchmaker
  # is future work. This lets operators DECLARE capability intent ahead
  # of the substrate that consumes the declaration; the contract is
  # forward-compatible with ADR-0027 (when it lands the matchmaker
  # implementation reads these directly without schema change).
  #
  # Empty lists = no capability declarations (current behavior — inputs
  # are typed purely by ref/version, not by what they implement).

  # Capabilities this input PROVIDES (studs out). The substrate matches
  # these against routes / bindings / other inputs declaring matching
  # `requires`.
  provides @5 :List(Text);

  # Capabilities this input REQUIRES (anti-studs in). Resolver picks
  # other inputs in the cluster that `provides` the matching capability;
  # surfaces an error if no input satisfies a `requires`.
  requires @6 :List(Text);

  # ── Transport binding hints (cloister-05334b, P1 of LLO arc) ─────
  #
  # When this input resolves to an MCP server.json with
  # `_meta.art.cloister/v1.groups[]`, the resolver writes one
  # `[[generated_backends]]` row per group into `cluster.lock.toml`.
  # The downstream manifest emitter (`scripts/build-manifest.mjs`) reads
  # those rows + injects them into the appropriate `McpRouteSpec.backends`.
  #
  # `urlBinding` names the env-var binding that holds the upstream URL
  # (e.g. "LLO_MCP_URL") — used at request time when the runtime can't
  # reach the upstream through a workerd Service binding.
  #
  # `serviceBinding` names a workerd Fetcher binding (e.g. "LSP_MCP")
  # that resolves to an `external` server entry in config.capnp.
  # When set + bound, the runtime calls `env[serviceBinding].fetch(...)`
  # and skips the `internet` ACL entirely. See HttpForwardBackend
  # in manifest/cloister.capnp for the precedence rules.
  #
  # Both fields are optional. Phase 1 keeps existing hand-declared
  # backend shells as the fallback; when both an [[generated_backends]]
  # row AND a hand-shell with the same backend name exist, the emitter
  # warns + prefers the generated row (so operators can stage the
  # migration upstream by upstream).
  urlBinding @7 :Text;
  serviceBinding @8 :Text;

  # ── Tenancy declaration (ADR-0030 §A5, cloister-0e3004) ──────────
  #
  # Composable tenancy on top of ADR-0026 inputs. Per ADR-0030's
  # substrate-as-kernel framing, tenancy is one more composition
  # dimension the matchmaker resolves alongside provides/requires.
  #
  # The input's own server.json `_meta.art.cloister/v1.tenancy`
  # declares the DEFAULT. This field is the OPERATOR OVERRIDE.
  # Empty struct (all fields empty) = inherit server.json defaults.
  #
  # Append-only ordinal per ADR-0004.
  tenancy @9 :TenancySpec;

  # Operator transport override for MCP servers that require the
  # Streamable HTTP initialize/session handshake (for example mcp-go).
  # Threaded into every generated backend derived from this input.
  requiresSession @10 :Bool;

  # How to REACH this input (ADR-0051). Structured components — never a
  # connection string. A `postgres://user:pass@host/db` blob fuses transport,
  # endpoint, credential and options into one opaque, ungovernable value; this
  # keeps them independently governable.
  #
  # UNSET preserves today's behavior exactly: resolve to an `mcpProxy` backend
  # via urlBinding / serviceBinding. So existing manifests parse unchanged
  # (ADR-0004 evolution rules).
  #
  # Append-only ordinal per ADR-0004.
  connection @11 :Connection;

  # WHY a mutable-tag pin is accepted for this input, when the OCI digest
  # cannot be resolved (ADR-0041). Empty = fail closed, which is the default.
  #
  # Resolution normally records `identifier@sha256:…` so an upstream re-push
  # cannot flow through. When the image is unpublished, private without
  # registry creds, or the registry is unreachable, there is no digest — and
  # writing the tag anyway yields a lockfile that LOOKS pinned while it is not.
  # That is the failure this defaults against.
  #
  # A REASON, not a boolean, for the same cause as `HarnessTarget.provenance`:
  # a bare `true` records that someone accepted a supply-chain downgrade but
  # not why, nor what has to become true before it can be removed. The next
  # reader cannot tell a considered exception from a forgotten one. State the
  # condition that lifts it.
  #
  # Append-only ordinal per ADR-0004.
  mutableTagReason @12 :Text;
}

# ── Connection: how an input is reached (ADR-0051) ────────────────────────
#
# Transport, endpoint and credential as separate first-class fields. A future
# data-backend input adds a transport variant and a vaultSlice with no schema
# break and no connection string.
struct Connection {
  # Transport kind. Mirrors the Wire.transport idiom above.
  #
  # `uds` is the point of this ADR: a same-host MCP server needs NO listening
  # TCP port at all, so its exposure is scoped by filesystem permissions rather
  # than by a port reachable to anything that can reach loopback. That is the
  # win — not throughput.
  transport :union {
    unset @0 :Void;   # no connection declared — mcpProxy via urlBinding
    uds   @1 :Void;   # capnp ToolCall over UDS via the companion dial
  }

  # Filesystem path of the socket, when transport is `uds`. Empty otherwise.
  socketPath @2 :Text;

  # Credential for this connection, ALWAYS a vault slice reference, NEVER an
  # inline secret (ADR-0010). Empty = no credential needed, which is the
  # same-host UDS case: filesystem permissions are the boundary.
  vaultSlice @3 :Text;
}

# ── TenancySpec (ADR-0030 §A5 / cloister-0e3004) ─────────────────────────
#
# Composable tenancy declaration for an InputSpec. Operator-set fields
# override the input's server.json `_meta.art.cloister/v1.tenancy`
# defaults; empty fields inherit those defaults.
#
# Per ADR-0030's hybrid model: not every input gets its own workerd.
# Operators declare per-input which workerd hosts it, and the resolver
# composes those declarations into the workerd-config emitter.

struct TenancySpec {
  # Tenancy mode under ADR-0030's composition model:
  #
  #   "co-located"  — input shares a workerd process with sibling
  #                   inputs declaring the same workerdId. OSS-launch
  #                   default; matches today's single-workerd shape.
  #   "external"    — input runs in its own process / container,
  #                   reached over an inter-process wire (UDS /
  #                   loopback HTTP / CF tunnel). Current behavior
  #                   for Go-native / non-V8 inputs (e.g. mache).
  #   "per-tenant"  — input gets its own workerd process per declared
  #                   tenant; strongest isolation under ADR-0030 §D1.
  #   ""            — empty defaults to the input's server.json
  #                   `_meta.art.cloister/v1.tenancy.default_mode`
  #                   (or "co-located" if absent). Validated at
  #                   resolve time, not compile time.
  mode @0 :Text;

  # Workerd process name. When mode = "co-located", multiple inputs
  # sharing this value collapse into one workerd in the emitted
  # compose YAML. Empty string = emitter assigns a default based on
  # the input's `name`.
  workerdId @1 :Text;

  # Trusted-tier hint. True = input may carry hypervisor-layer
  # bindings (e.g. notme, TrustStore) and co-locate with the cloister-
  # router workerd. False = tool-bundle Worker subject to ADR-0013
  # substrate-property lint (cloister-ac30e7).
  #
  # Empty cluster.toml override OR explicit false = NOT trusted tier.
  # The substrate fails closed: only explicit true grants the tier.
  trustedTier @2 :Bool;

  # Explicit co-tenancy edges. Non-empty list asserts these inputs
  # are deployed in the same workerd as this one (resolver enforces).
  # Empty = no explicit co-tenancy constraint beyond `workerdId`.
  sharesWorkerdWith @3 :List(Text);
}

# ── EdgeSpec (ADR-0030 §A2 + §A4 / cloister-0e3004) ──────────────────────
#
# Cross-tenant edge declaration. The substrate uses these for routing
# (§A2) and observability/policy classification via app_protocol (§A4);
# the underlying transport is operator-wired (substrate is intentionally
# transport-agnostic — see ADR-0030 §A4 "raptorq is out of scope").

struct EdgeSpec {
  # Source tenant. References either a TenancySpec.workerdId or the
  # name of an InputSpec whose resolved tenancy.workerdId matches.
  from @0 :Text;

  # Destination tenant. Same resolution rules as `from`.
  to @1 :Text;

  # ADR-0030 §A4 hybrid namespace label:
  #   - "art.*"    : substrate-blessed canonical handling
  #   - "x-<v>-*"  : operator-extensible opaque pass-through
  #   - other      : rejected by lint-app-protocol (cloister-0fa3d7)
  appProtocol @2 :Text;

  # Operator-specified transport hint (e.g. "loopback-http", "uds:/path",
  # "cf-tunnel"). The substrate doesn't enforce semantics — this is
  # observability + audit context. Empty string = emitter default
  # (typically loopback HTTP within the compose).
  transport @3 :Text;
}

# ── Route + per-kind specs (Phase 2 of "cloister.capnp as build artifact"
# arc, cloister-345ad1 / ADR-0031) ────────────────────────────────────────
#
# Mirrors the Route struct + per-kind specs from `manifest/cloister.capnp`.
# The cluster manifest pipeline (`scripts/build-manifest.mjs` emitter
# extension in Phase 2) lifts these Route declarations into the generated
# `cloister.capnp` Gateway value at build time.
#
# Why mirror instead of import the cloister.capnp definitions?
#
#   - cluster.capnp is the operator surface; it should be self-contained.
#     A consumer manifest depends on ONE schema file, not two.
#   - The cloister.capnp schema (Gateway) is a build artifact post-Phase-2;
#     it shouldn't be a dependency of cluster.capnp going forward.
#   - The two schemas evolve at different cadences. Mirroring lets each
#     extend its own ordinals without coupling the other's evolution.
#
# Append-only ordinals per ADR-0004. New variants land at higher ordinal
# tags; never renumber existing tags. When in doubt re-read the schema-
# evolution rules at the top of this file.

struct Route {
  # Path prefix. The router does first-match-wins over the routes list.
  path @0 :Text;

  kind :union {
    # GET <path> → liveness + backend snapshot.
    health              @1 :Void;

    # GET|POST <path> → MCP edge (JSON-RPC + SSE), aggregating ToolBackends.
    mcp                 @2 :McpRouteSpec;

    # <path>/* → service binding (Fetcher), with optional prefix strip.
    serviceBindingProxy @3 :ServiceBindingProxySpec;

    # <path>/* → HTTP forward to a URL (read from env var binding).
    httpProxy           @4 :HttpProxySpec;

    # GET <path> → Interlace `.well-known` discovery doc, body synthesized
    # at request time from the Gateway's actor + policy fields and the
    # capabilities aggregated across the manifest's mcp routes.
    wellKnownInterlace  @5 :Void;

    # GET <path>/:fp → Selective disclosure of peer_attestations rows.
    # Lease-gated when INTERLACE_ROOT_PUBKEY is set.
    disclosure          @6 :Void;

    # Multi-format identity discovery bridge — surfaces the cluster's
    # native Interlace identity under the OIDC, WebFinger, and Nostr
    # NIP-05 well-known paths, plus a minimal `client_credentials` token
    # endpoint. Sentinel `path`; handler dispatches by URL internally.
    wellKnownIdentityBridge @7 :Void;

    # OCI Distribution Spec (v1.1) registry. Sentinel `path`; URLPatterns
    # inside the handler match `/v2/*` endpoints.
    ociRegistry             @8 :Void;

    # MCP Registry OpenAPI surface — cloister as a private MCP Registry.
    # Sentinel `path`; URLPatterns inside the handler match the v0.1
    # server-discovery sub-paths.
    wellKnownMcpRegistry    @9 :Void;

    # Interlace 0.2.0 archival CA bundle endpoint. Sentinel `path`;
    # URLPatterns inside the handler match `/interlace/ca-bundle` +
    # `/interlace/ca-bundle/<epoch>`.
    caBundle                @10 :Void;

    # `cloister/credential-isolation/v1` route. Sentinel `path`; handler
    # matches `/vault/proxy/<service>/<rest...>` internally.
    vaultProxy              @11 :VaultProxySpec;

    # Per-tenant dispatch route (ADR-0030 §A2 / cloister-0f144c).
    # Mirrors manifest/cloister.capnp's TenantDispatchSpec; see that
    # file for the operator-facing semantics.
    tenantDispatch          @12 :TenantDispatchSpec;
  }
}

# ── VaultProxySpec: per-route config for `vaultProxy` Route.kind ──────────
struct VaultProxySpec {
  # Logical bundle name passed to `env.VAULT_STORE.idFromName(...)`.
  # Empty → defaults to "router".
  bundleIdName @0 :Text;
}

# ── TenantDispatchSpec (ADR-0030 §A2 / cloister-0f144c) ──────────────────
# Mirrors manifest/cloister.capnp's TenantDispatchSpec verbatim — the
# cluster manifest carries the same routing-table shape so the emitter
# can lift it into the generated cloister.capnp.
struct TenantDispatchSpec {
  tenants @0 :List(TenantDispatchRow);
}

struct TenantDispatchRow {
  name       @0 :Text;
  mode       @1 :Text;
  matchValue @2 :Text;
  binding    @3 :Text;
}

# ── McpRouteSpec: ToolBackend dispatch layer ──────────────────────────────
struct McpRouteSpec {
  backends @0 :List(Backend);
}

struct Backend {
  # Human-friendly id, must be unique within the McpRouteSpec.
  name          @0 :Text;

  # Tool-name prefix. Two backends sharing a prefix is a build error.
  handlesPrefix @1 :Text;

  kind :union {
    # bead_*-style: stub.fetch keyed by an arg (typically `repo`).
    durableObject  @2 :DoBackend;

    # workerd Fetcher service binding (notme-bot, future internal Workers).
    serviceBinding @3 :ServiceBindingBackend;

    # Unix-domain-socket forward — placeholder; reserves the kind.
    udsForward     @4 :UdsForwardBackend;

    # leyline-net wire to cloister-companion (ADR-0005).
    leylineNet     @5 :LeylineNetBackend;

    # MCP Proxy Server upstream (ADR-0015 Phase 1).
    mcpProxy       @6 :HttpForwardBackend;
  }
}

# ── Backend kinds ─────────────────────────────────────────────────────────

struct DoBackend {
  # Name of the DurableObjectNamespace binding (e.g. "BEAD_STORE").
  binding @0 :Text;

  # Argument key whose value names the DO instance (e.g. "repo").
  keyArg  @1 :Text;

  # Tools this backend advertises in tools/list.
  tools   @2 :List(McpTool);
}

struct HttpForwardBackend {
  # Name of the text-var binding holding the URL (e.g. "LLO_MCP_URL").
  urlBinding @0 :Text;

  # Asserted catalog. With `dynamicTools = false` (default) this is the
  # full tools/list. With `dynamicTools = true` this is an override set.
  tools      @1 :List(McpTool);

  # When true, cloister fetches `tools/list` from the upstream at request
  # time and caches with a TTL.
  dynamicTools @2 :Bool;

  # Prefix to remove from tool names before forwarding `tools/call`.
  stripPrefix @3 :Text;

  # When true, cloister speaks MCP Streamable HTTP per spec (initialize +
  # captured `Mcp-Session-Id` on every subsequent request).
  requiresSession @4 :Bool;

  # Per-upstream protocol mode (ADR-0015 Phase 2):
  #   - "" / "current": legacy MCP 2025-11-25 lifecycle
  #   - "next": sessionless
  #   - "auto": try sessionless first, fall back to legacy on
  #     UnsupportedProtocolVersionError
  protocolMode @5 :Text;

  # Name of a workerd Service binding (Fetcher) that resolves to this
  # backend (e.g. "MACHE_MCP"). When non-empty + bound, the runtime
  # calls `env[serviceBinding].fetch(...)` instead of routing through
  # `fetch(env[urlBinding] + path)`.
  serviceBinding @6 :Text;

  # Explicit list of upstream tool names this backend handles. When
  # non-empty, filters the derived catalog to just these names + advertises
  # them verbatim (no prefix-add).
  claims @7 :List(Text);
}

struct ServiceBindingBackend {
  # Name of the Fetcher binding.
  binding @0 :Text;

  tools   @1 :List(McpTool);
}

struct UdsForwardBackend {
  # Path to the UDS socket the upstream listens on.
  socketPath @0 :Text;

  tools      @1 :List(McpTool);
}

struct LeylineNetBackend {
  # Name of the text-var binding holding cloister-companion's HTTP URL.
  companionUrlBinding @0 :Text;

  # Logical id the companion uses to route to the actual upstream.
  upstreamId          @1 :Text;

  tools               @2 :List(McpTool);
}

# ── Non-MCP routes ────────────────────────────────────────────────────────

struct ServiceBindingProxySpec {
  # Name of the Fetcher binding (e.g. "NOTME").
  binding      @0 :Text;

  # Hostname to use when constructing the upstream URL ("notme-bot").
  upstreamHost @1 :Text;

  # Prefix to strip from the request path before forwarding ("/identity").
  stripPrefix  @2 :Text;
}

struct HttpProxySpec {
  # Name of the text-var binding holding the upstream URL.
  urlBinding  @0 :Text;

  # Prefix to strip before forwarding (or empty).
  stripPrefix @1 :Text;
}

# ── MCP tool descriptor ───────────────────────────────────────────────────

struct McpTool {
  name            @0 :Text;
  description     @1 :Text;

  # JSON Schema for the tool's input. Stored as raw JSON text to round-trip
  # without losing fidelity.
  inputSchemaJson @2 :Text;
}

# ── Gateway-level surface (Phase 4a of "cloister.capnp as build artifact"
# arc, cloister-c919d7 / ADR-0031) ────────────────────────────────────────
#
# Mirrors `Cloister.Gateway` from `manifest/cloister.capnp` — operator-
# authored manifest identity (metadata), Interlace identity (actor),
# Interlace policy, and credential-isolation service declarations. Same
# rationale as Route above: cluster.capnp is the self-contained operator
# schema; cloister.capnp is the downstream generated artifact. Mirroring
# keeps the two schemas independently evolvable + decouples cluster.capnp
# consumers from the cloister.capnp schema dependency.
#
# Append-only ordinals per ADR-0004. New optional fields land at higher
# ordinals; never renumber. An all-empty Gateway value (the back-compat
# default for pre-Phase-4a cluster.toml) signals the emitter to fall
# through to the ART-default template + emit a warning to stderr; see
# scripts/emit-cloister-capnp.mjs for the fall-through rule.

struct Gateway {
  # Logical manifest name + version. Distinct from `cluster.metadata`:
  # cluster.metadata.name is the deployment identity ("art-default",
  # surfaced in container labels); gateway.metadata.name is the manifest
  # identity ("cloister-art", "cloister-agent-cluster", surfaced inside
  # the workerd Worker's gateway). Per ADR-0004 + ADR-0009.
  metadata @0 :GatewayMetadata;

  # Interlace actor identity (ADR-0007). Empty `fingerprint` ⇒ Interlace
  # discovery disabled (the recipe that ships without `.well-known/
  # interlace/` — e.g. oss-launch-minimal).
  actor    @1 :Actor;

  # Interlace policy (ADR-0007) — peers learn the actor's requirements
  # before initiating. Cert lifetime + interlock + min-algorithm.
  policy   @2 :InterlacePolicy;

  # `cloister/credential-isolation/v1` service registry (ADR-0024).
  # The emitter projects this list into `Cloister.Gateway.vaultProxyServices`
  # so `cluster.toml` remains the operator source of truth for both the
  # vaultProxy route and its upstream service declarations. Empty list =
  # no services declared; `/vault/proxy/*` stays safe-closed.
  #
  # Append-only ordinal per ADR-0004.
  vaultProxyServices @3 :List(VaultProxyService);

  # Harness profiles (cloister-742e19, ADR-0057). A harness is a lattice
  # PARTICIPANT, not a target the substrate special-cases: Claude Code and
  # Codex are two rows here, and adding a third is an operator writing TOML,
  # never an edit to `scripts/harness-dev.mjs`.
  #
  # Declared here rather than in a script for the same reason as
  # vaultProxyServices above — `cluster.toml` is the operator source of truth.
  # Each entry's `service` MUST name a vaultProxyServices entry; the two halves
  # now live in one file, so the agreement is checkable by the manifest
  # pipeline rather than reconciled at runtime. Empty list = no harness
  # declared; `task harness:dev` fails closed naming the empty set.
  #
  # Append-only ordinal per ADR-0004.
  harnessTargets @4 :List(HarnessTarget);
}

struct HarnessTarget {
  # Selector for `task harness:dev -- --target <name>`.
  name @0 :Text;

  # Vault service this harness authenticates through. MUST match a
  # `VaultProxyService.name`; the injection strategy and upstream come from
  # THAT declaration, so they are never restated here and cannot disagree.
  service @1 :Text;

  # Absolute path to the harness executable — the SAME concept as
  # `BundleExternal.entryPoint`, not a bare command name. Confined execution
  # execs by path with no `$PATH` lookup inside the sandbox, so a bare name
  # would have to be resolved at runtime (that resolution is where
  # `claude: command not found` came from). Empty ⇒ resolve `name` on `$PATH`
  # at launch, which is the convenience path and NOT available under
  # confinement.
  entryPoint @2 :Text;

  # Env var the operator sets to supply an API key (custody mode). The key is
  # written to the vault seed and injected inside the vault DO; it never enters
  # the harness environment.
  apiKeyEnv @3 :Text;

  # Env var the harness reads to find the vault proxy.
  baseUrlEnv @4 :Text;

  # Credential env vars scrubbed before exec, so a confined harness cannot see
  # a key even if the operator exported one — which would otherwise let it
  # bypass the proxy by calling the provider directly. Should include
  # `apiKeyEnv`.
  stripEnv @5 :List(Text);

  # Env var overriding the harness state directory.
  stateDirEnv @6 :Text;

  # State directory relative to $HOME; granted rw under confinement.
  stateDir @7 :Text;

  # Supported auth modes. "custody" vaults an API key and injects it. "audit"
  # forwards the harness's own OAuth and receipts the call — only meaningful
  # where the provider sells a subscription that vaulting a key would silently
  # bypass. Declaring the supported set makes an unsupported `--audit` a named
  # refusal rather than a quiet downgrade that moves billing.
  authModes @8 :List(Text);

  # WHO OWNS these facts — the URL of the project that decides them.
  # Required, and always a concrete owner. Examples:
  #
  #   "https://github.com/openai/codex"              third-party: cloister is
  #                                                  TRANSCRIBING, and this row
  #                                                  goes stale when codex
  #                                                  changes.
  #   "https://github.com/agentic-research/cloister" cloister's own decision.
  #   "https://github.com/agentic-research/mache"    a first-party project that
  #                                                  publishes its own
  #                                                  server.json — prefer
  #                                                  DERIVING over copying.
  #
  # Deliberately NOT a category label ("first-party" / "vendored") and
  # deliberately NOT empty-means-something. Both are silent buckets: a category
  # word tells you which bin a row is in but not who to ask, and an empty
  # string is indistinguishable from a row nobody filled in — absence carrying
  # meaning is the exact defect that let a `sha256:` prefix sit on BLAKE3 bytes
  # and let thirteen files cite a schema path that never existed. Naming the
  # owner answers "who do I ask when this is wrong?" directly, and whether it
  # is first- or third-party is then readable from the org rather than asserted
  # separately (two statements of one fact, which is the other defect).
  #
  # Why this matters here specifically: every other declaration in this file is
  # a fact cloister legitimately owns — topology, bindings, pins, tiers. A
  # harness row is not. `codex` reads OPENAI_API_KEY and keeps state in
  # ~/.codex because CODEX says so, and it will never publish an
  # `art.cloister/v1` block saying so. A reader must be able to tell a decision
  # from a transcription. (ADR-0057 property A, third open question.)
  #
  # Append-only ordinal per ADR-0004.
  provenance @9 :Text;
}

struct VaultProxyService {
  # Logical service name — matches `/vault/proxy/<name>/<rest>`.
  name @0 :Text;

  # Upstream base URL; the route appends `<rest>` from the inbound path.
  upstreamBaseUrl @1 :Text;

  # Glob list of `peerFp` values authorized to use this service.
  # Empty list = deny-all.
  defaultAllowedSubs @2 :List(Text);

  # Per-(peerFp, service) bucket capacity in calls/minute. 0 = unlimited.
  rateLimitPerMinute @3 :UInt32;

  injection :union {
    authorizationBearer @4 :Void;
    authorizationBasic  @5 :Void;
    headerNamed         @6 :HeaderNamedSpec;
    queryParam          @7 :QueryParamSpec;
    bodyField           @8 :BodyFieldSpec;
    # NOTE (ADR-0040 amendment): `passthrough @9` exists in the CONSUMER
    # schema (manifest/cloister.capnp) + runtime, and is reachable in dev via
    # the DEV_PASSTHROUGH_SERVICES overlay. Declaring it here — so operators
    # can set `injection = "passthrough"` in cluster.toml for a production
    # Max/audit deployment — is a follow-up (needs the zod/Go schema-bridge
    # regen). Keep the ordinal reserved as @9 when it lands.
  }
}

struct HeaderNamedSpec { name @0 :Text; }
struct QueryParamSpec  { name @0 :Text; }
struct BodyFieldSpec   { path @0 :Text; }

struct GatewayMetadata {
  # e.g. "cloister-art", "cloister-agent-cluster". Distinct from
  # cluster.metadata.name (the deployment identity). Empty string ⇒
  # the emitter falls through to the ART-default template.
  name    @0 :Text;
  # Semver of the manifest, bumped by the consumer when their slice
  # changes. Empty string ⇒ fall-through (same rule as `name`).
  version @1 :Text;

  # The `_meta` extension namespace this deployment publishes under —
  # e.g. "art.cloister/v1". Declared here so consumers do not carry it as a
  # constant.
  #
  # It already appears in three places that must agree: the key cloister emits
  # into its MCP Registry `_meta` envelope, the key downstream projects write in
  # their own server.json `_meta` (canonical-hours, mache), and the key external
  # readers match on. A cross-repo graph generator currently hardcodes
  # "art.cloister/v1 -> cloister" precisely because nothing machine-readable
  # states it — an asserted edge resting on a constant in the reader.
  #
  # Empty ⇒ the runtime default. Per ADR-0057: the fact is authored once, at the
  # deployment that owns it, and read everywhere else.
  #
  # Append-only ordinal per ADR-0004.
  metaNamespace @2 :Text;
}

struct Actor {
  # SHA-256 fingerprint of the master public key, formatted as
  # "sha256:<hex>". Empty string ⇒ Interlace discovery disabled.
  fingerprint     @0 :Text;
  # Master-key signature algorithm: "ed25519" or "ml-dsa-44".
  algorithm       @1 :Text;
  # Name of the env-var binding holding the master public key (e.g.
  # "INTERLACE_MASTER_PUBKEY"). Key bytes never appear in the manifest.
  pubkeyBinding   @2 :Text;
  # Where this actor publishes its bilateral attestation chains. Empty
  # ⇒ in-DO storage (the BeadStore `peer_attestations` table per
  # ADR-0007).
  attestationRepo @3 :Text;
  # Optional CF Tunnel hostname or other off-platform endpoint.
  tunnelEndpoint  @4 :Text;
}

struct InterlacePolicy {
  # Maximum lifetime (seconds) for ephemeral certs the actor will accept.
  # Defaults to 300 (5 min) per the spec; lower values tighten the
  # blast radius of cert compromise.
  maxCertLifetimeSeconds @0 :UInt32;
  # Whether peer interactions must carry interlock peer-refs
  # (Interlace §6.2). True ⇒ first-class bilateral chain; false ⇒
  # leases-only relationship.
  requireInterlock       @1 :Bool;
  # Minimum signature algorithm the actor will accept on incoming certs.
  minAlgorithm           @2 :Text;
}

# ── GeneratedBackend: one [[generated_backends]] row in cluster.lock.toml ──
#
# Declared here so the row shape is DERIVED rather than hand-maintained
# (cloister-71a9f4 / cloister-11cd61). schema-bridge emits a strict
# `GeneratedBackendSchema` for this struct, and build-manifest.mjs validates
# against it — so an unknown key or a wrong-typed value fails the build
# without anyone maintaining a parallel field table in JavaScript.
#
# The history this replaces: every field was read as
# `typeof x === "string" ? x : ""`, which cannot distinguish absent from
# wrong-typed from deliberately-empty — `stripPrefix = ""` is a real value in
# all 15 shipped rows. A typo'd key produced output byte-identical to a
# legitimate empty one, and the build exited 0 with a backend matching
# nothing.
#
# This struct is NOT reachable from `Cluster`: the lockfile is a separate
# artifact (resolve-inputs.mjs writes it; build-manifest.mjs reads it).
# schema-bridge emits a schema per struct regardless of reachability, which
# is what makes a standalone declaration work.
#
# `dynamicTools` defaults TRUE. That default now lives in the schema rather
# than in a JS `?? true`, so the two cannot disagree.
struct GeneratedBackend {
  # Backend name. Required — a row without one is a build failure.
  name            @0 :Text;
  # Which [inputs.*] produced this row. Read by build-manifest.mjs to report
  # cross-input name collisions and to build the qualified name.
  input           @1 :Text;
  # Advertised tool-name prefix this backend handles.
  handlesPrefix   @2 :Text;
  # Prefix stripped before matching against `claims` (cloister-2d987e).
  stripPrefix     @3 :Text;
  # Env binding carrying the upstream MCP URL.
  urlBinding      @4 :Text;
  # Service binding, when the backend is wired in-process.
  serviceBinding  @5 :Text;
  # Whether the backend advertises tools dynamically.
  dynamicTools    @6 :Bool = true;
  # Whether the upstream requires a session id on each call.
  requiresSession @7 :Bool;
  # Bare upstream tool names this backend claims.
  claims          @8 :List(Text);
}
