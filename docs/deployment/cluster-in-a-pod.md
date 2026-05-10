# Cluster-in-a-pod deployment

Operator-facing guide for the [`cluster.capnp`](../../cluster.capnp)
deployment shape that lands [ADR-0009](../adr/0009-compute-substrate-portability.md)
Phase 1 (via [cloister-be0607](../../.beads/)). The result: **one
declarative file → three deployment targets (mac dev, Linux container,
k8s pod) — same source of truth.**

## What this gets you

A single `cluster.capnp` describes a deployable cloister cluster:

- **cloister-router** — the gateway + DO state holder (workerd)
- **notme-identity** — cluster's identity authority (workerd)
- **mache** — code intelligence (Go, capnp-over-UDS)
- **rosary** — bead orchestrator (Rust, capnp-over-UDS)

`task cluster:emit` compiles `cluster.capnp` into a
`cluster.compose.yaml` (OCI compose spec, no docker-specific
directives). `task cluster:up` invokes whatever compose-capable
runtime you have (`nerdctl`, `podman`, or `docker compose`) — it
auto-detects, you don't pick.

## Three deployment targets

### Mac dev — native binaries, no containers

```sh
task cluster:dev   # spawns each bundle as a native process
                   # UDS sockets land in /tmp/cloister-dev/run/
                   # DO storage in $HOME/.cache/cloister-dev/do/
```

No container layer — same `cluster.capnp`, parsed by
[`scripts/cluster-dev.mjs`](../../scripts/cluster-dev.mjs) and
spawned as subprocesses with the wire bindings injected as env vars.
Fast iteration; survives Ctrl-C cleanly (SIGTERM each child, SIGKILL
stragglers after 5s). DO state persists in `$HOME/.cache/cloister-dev/`
across runs.

**Missing binaries are surfaced, not fatal.** If `mache` isn't on
PATH or `../notme/worker/wrangler.toml` doesn't exist, that bundle is
skipped with a clear hint; the rest of the cluster still boots. This
lets you dev cloister-router without first building all sibling repos.

Useful env vars:

| Var | Effect |
|---|---|
| `CLUSTER_DEV_DRY_RUN=1` | Print the launch plan, don't spawn |
| `CLUSTER_DEV_BIN_<NAME>=/path` | Override the binary lookup for bundle NAME (upper-cased, hyphens → underscores) |
| `CLUSTER_DEV_DIR_NOTME_IDENTITY=/path` | Override the notme worker dir (default `../notme/worker`) |
| `CLUSTER_DEV_RUN_DIR=/path` | UDS dir (default `/tmp/cloister-dev/run`) |
| `CLUSTER_DEV_DO_DIR=/path` | DO storage dir (default `$HOME/.cache/cloister-dev/do`) |

If `cloister-router` or `notme-identity` (the hypervisor-tier bundles)
exits, the launcher tears the whole cluster down — those are the
load-bearing pieces and a partial cluster is more confusing than a
dead one.

### Linux self-host — containerd via nerdctl/podman/docker

```sh
task cluster:emit  # → cluster.compose.yaml
task cluster:up    # runs `nerdctl compose up` (or podman/docker)
```

The compose file is OCI-spec; works with **containerd directly** (no
docker daemon required), podman (daemonless), or docker if you have
it. The auto-detector tries them in that order.

### K8s — deferred

A k8s Pod-manifest emitter was scoped for be0607c but deferred —
mac-dev + compose cover the operator paths we care about today, and
k8s adds operational weight (kubelet, etcd, networking) that most
self-hosters don't want. The schema permits adding `scripts/emit-pod.mjs`
later without touching anything else; file a follow-up bead if you
need it.

## Schema anatomy

The full schema is in [`manifest/cluster.capnp`](../../manifest/cluster.capnp).
A consumer manifest declares one `Cluster` value:

```capnp
const cluster :Cluster.Cluster = (
  metadata = ( name = "art-default", version = "0.1.0" ),
  bundles = [ ... ],   # 4 bundles in the default config
  wires = [ ... ],     # service-binding relationships
  storage = ( doStoragePath = "/var/lib/cloister/do" ),
);
```

### Bundle kinds

Two `Bundle.kind` variants:

| Kind | Use for | Phase 1 shipping? |
|---|---|---|
| `workerd` | TS/JS bundles that live INSIDE cloister-router's workerd as v8 isolates | Schema-reserved; no users yet |
| `external` | Subprocess containers — Go/Rust binaries, or their own workerd | All four default bundles |

cloister-router itself is `external` even though it IS a workerd — it
runs in its OWN container, not inside another workerd. The `workerd`
kind is reserved for *additional* TS bundles that should share
cloister-router's request loop.

### Tier classification

Per [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md)'s
three-criterion test:

- `hypervisor` — mediates between bundles + the outside; multi-bundle
  blast radius; singleton per cluster. Default config: `cloister-router`
  and `notme-identity`.
- `cluster` — user-deployable; removing one disables a feature but
  leaves the cluster otherwise functional. Default config: `mache`,
  `rosary`.

The tier is documentation + audit, not a runtime gate.

### Wires

Each `Wire` declares "bundle A reaches bundle B via env var BINDING".
The emitters:
1. Inject env var `BINDING` into A's container, set to B's `ipcSocket`
   path (UDS) or `httpPort` URL.
2. Ensure A and B both mount the volume containing the UDS file.
3. Validate at compile time that `from`/`to` reference declared bundles
   (no dangling wires).

Wires are directional. Bidirectional comms = two wires.

The default `transport` is `uds` — capnp ToolCall over a Unix Domain
Socket, plain (no AEAD, per [ADR-0005](../adr/0005-internal-wire-leyline-net.md)
amendment 2026-04-30). The `leylineNet` variant is reserved for
cross-cluster reach (signed capnp + AEAD); not used intra-pod.

**How a workerd bundle (cloister-router) actually reaches a UDS sibling:**
workerd can't dial `AF_UNIX` from JS. cloister-router's
`UdsForwardToolBackend` POSTs the capnp ToolCall to **cloister-companion**
(a Rust sidecar; ADR-0005) with two transport-indicator headers:

```
X-Cloister-Transport: uds
X-Cloister-Socket-Path: /run/cloister-uds/<bundle>.sock
```

Companion connects to the named socket, proxies the bytes, returns
the ToolResult. The companion bundle therefore MUST mount the same
`cloister-uds` volume as the sibling bundles whose sockets it dials.
Once Phase 2B lands the Rust companion as a separate bundle in
`cluster.capnp` (currently TBD), its `volumes:` entry will be
`cloister-uds:/run/cloister-uds`, matching the existing
cloister-router / mache / rosary mounts.

## Bootstrap path (cold-start)

When a fresh container comes up:

1. **cloister-router** starts first. The volume mount at
   `/var/lib/cloister/do` is empty if this is the first boot.
2. **notme-identity** mints a fresh `SigningAuthority` master if its
   DO storage is empty; otherwise reuses the persisted master.
3. **cloister-router** fetches the CA bundle from `env.NOTME` (UDS
   if intra-pod, HTTP if cross-pod) and caches it for 4 min.
4. **mache** + **rosary** open their UDS sockets and wait for capnp
   ToolCall traffic from cloister-router.
5. cloister-router opens HTTP on its `httpPort` (default 8787) for
   external clients.

A new cluster mints a fresh master by default. To **import** a master
from a sealed secret (rather than mint), set the
`INTERLACE_ROOT_PUBKEY` + `INTERLACE_MASTER_PRIV_SEED` env vars on
the notme-identity bundle before `cluster:up`. (Not yet documented
end-to-end; track as a follow-up bead.)

## Persistence

The `cloister-do` volume mounts at `/data/do` inside the
cloister-router container. It holds:

- BeadStore SQLite (per-repo bead state)
- TrustStore SQLite (singleton, lease counters + attestations + pending)
- BlobStore SQLite (singleton, content-addressed blobs)

### Why `/data/do` specifically

The path `/data/do` is hard-coded today across THREE files:

- [`apko.yaml`](../../apko.yaml) — creates the dir at image build (uid 65532)
- [`config.capnp`](../../config.capnp) — workerd `do-storage` service points here
- [`cluster.capnp`](../../cluster.capnp) — `storage.doStoragePath = "/data/do"`

Drift between these three is silently broken. A path lint is filed
under `cloister-7c12cc`. Until that lands, **don't change `/data/do`
in any one file without updating all three in the same commit.**

A more dangerous class of drift — timing/security constants — is
tracked under `cloister-7ea4c4`: cert TTL ↔ bundle refresh ↔ seen_nonces
eviction ↔ pending-attestation alarms must satisfy specific invariants
or the cluster is silently insecure.

### SIGTERM behavior

Workerd handles `SIGTERM` (and `SIGINT`) by:

1. Stopping accept on the listening socket — no new requests admitted.
2. Draining in-flight requests up to a deadline (default ~30s).
3. Flushing DO storage. Each Durable Object commits any pending writes
   to its SQLite file before exit; the volume mount survives.

`task cluster:down` sends `SIGTERM` to each container in stop-order
(reverse of `compose up` order). cloister-router stops last so
sibling bundles don't lose connectivity mid-shutdown.

### Persistence smoke test (manual)

```sh
task cluster:up &              # backgrounds the cluster
sleep 5
# Create a bead via the cluster
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"bead_create",
                 "arguments":{"repo":"/test","title":"persistence-test"}}}'

task cluster:down              # SIGTERM → drain → exit; volume preserved
task cluster:up &              # fresh container start
sleep 5
# Verify the bead is still there
curl -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"bead_search",
                 "arguments":{"repo":"/test","query":"persistence-test"}}}'
# Should return the bead created earlier.
```

Run this with `task cluster:down` AND `task cluster:down DESTROY=1`
followed by `cluster:up` — the second case starts fresh (volume
removed); the bead does NOT come back. That's expected and confirms
the volume is the persistence boundary.

### Backup strategy

`nerdctl volume inspect cloister-do` (or `podman volume inspect`) shows
the host path. The SQLite files are workerd-managed; they're safe to
copy when no writes are in flight. For online backup:

1. `task cluster:down` (graceful drain) → SIGTERM → workerd flushes
2. `cp -a $(nerdctl volume inspect -f '{{.Mountpoint}}' cloister-do) /backup/`
3. `task cluster:up` to resume

Online (no-downtime) checkpoint isn't supported today — workerd doesn't
expose a `flush-now` signal. Filed as a follow-up bead when self-hosters
need it operationally.

## Troubleshooting

### "no compose-capable runtime found"

Install one:

```sh
# Mac
brew install nerdctl          # or: brew install podman

# Linux (debian)
apt install nerdctl           # or: apt install podman
```

You do NOT need to install docker. `task cluster:up` auto-detects.

### Bundle can't reach another bundle's UDS

Check the volume mount:

```sh
nerdctl inspect cloister-cloister-router | grep -A2 Mounts
nerdctl inspect cloister-mache           | grep -A2 Mounts
```

Both should show `cloister-uds:/run/cloister-uds` (read-write).

### CA bundle unavailable (503 from /mcp)

cloister-router needs `INTERLACE_ROOT_PUBKEY` set to verify the
bundle signature. Without it, the lease gate is off (dev mode); with
it, every request needs auth + a fetchable bundle. See
[ADR-0007](../adr/0007-interlace-substrate.md) + the
[threat model](../security/threat-model.md) for the full pipeline.

### Workerd config error: "binding name not unique"

`emit-compose` infers env-var names from wire `binding` fields. If
two wires share a binding name, the workerd config will reject. Pick
distinct names per wire.

## Cross-repo dependencies

Phase 1 of the deployment needs sibling repos to support capnp-over-UDS:

| Repo | What's needed | Bead |
|---|---|---|
| `mache` | `--ipc-socket` mode (capnp ToolCall over UDS) | `mache-632107` |
| `rosary` | `rsry mcp --ipc-socket` mode (same) | `rosary-6371e3` |
| `notme` | `/internal/ca-bundle` endpoint (JSON, service-binding only) | `notme-049e5f` |

Until those land, `cluster:up` will fail to wire those services — the
schema + emitters are ready; the runtime needs the sockets to actually
exist.

## See also

- [ADR-0009](../adr/0009-compute-substrate-portability.md) — substrate
  portability framing + the 2026-05-10 architectural commit
- [ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) — tier
  classification
- [ADR-0005](../adr/0005-internal-wire-leyline-net.md) — internal wire
  + intra-cluster plain-capnp amendment
- [`manifest/cluster.capnp`](../../manifest/cluster.capnp) — schema
- [`cluster.capnp`](../../cluster.capnp) — default consumer manifest
- [`scripts/emit-compose.mjs`](../../scripts/emit-compose.mjs) — the
  first emitter
