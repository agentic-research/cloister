# Bundle topology — reference

The canonical map of bundles declared in `cluster.toml` /
`cluster.capnp` for the default cloister cluster, their tier, their
transport, and their purpose.

**This page is the source of truth.** Other docs (`README.md`,
`docs/ARCHITECTURE.md`, `recipes/agent-cluster/README.md`,
`docs/deployment/cluster-in-a-pod.md`) link here rather than
re-enumerate. The bug that prompted `cloister-9d602f` was the topology
drifting across 4 files; this page is the convergence point.

For the deployment commands that actually launch the topology see
[`docs/deployment/cluster-in-a-pod.md`](../deployment/cluster-in-a-pod.md).
For the operator story around using the default ART tools securely
through `/mcp`, see
[`docs/deployment/secure-art-tools.md`](../deployment/secure-art-tools.md).
For the schema decisions behind the bundle classification see
[ADR-0011](../adr/0011-hypervisor-bundle-boundary.md) (the
three-criterion test) and [ADR-0009](../adr/0009-compute-substrate-portability.md)
(the compute substrate that hosts each bundle).

## The four default bundles

| Bundle | Tier | Bundle.kind | Transport in | Purpose |
|---|---|---|---|---|
| **`cloister-router`** | hypervisor | `external` (its own workerd container) | HTTP (`:8787` default) | Public face: SSE/HTTP MCP edge, DO state holder (BeadStore, TrustStore, BlobStore, CredentialVault), wires every cluster-tier sibling. |
| **`notme-identity`** | hypervisor | `external` (its own workerd container) | UDS via service binding | Signet master CA, mints lease certs, hosts the OIDC + WebFinger + Nostr identity bridge. |
| **`mache`** | cluster | `external` (Go binary) | UDS via service binding | Code intelligence — `mache_*` MCP tools (dynamic, derived via ADR-0006) plus the lifecycle endpoints (`reparse`, `enrich`, `status`). |
| **`rosary`** | cluster | `external` (Rust binary) | UDS via service binding (with `cloister-companion` as the AF_UNIX bridge) | Bead orchestrator — `rsry_*` MCP tools, work-dispatch + Dolt-backed bead store. |

`cloister-companion` is the Rust AF_UNIX bridge that lets workerd-side
bundles reach UDS sockets (workerd cannot dial `AF_UNIX` from JS); it
appears in some recipes as its own row and is folded into the
"transport" column above. See ADR-0005 for the IPC seam.

Future ART tools can join this table only after their bundle contract is
explicit: packaging artifact, launch command, transport, auth material,
tool prefix, storage, and tenant-isolation posture. Until then the
secure operator runbook covers the two current cluster-tier tools:
`mache` and `rosary`.

`agents/work-board` is intentionally not something Cloister starts or confines.
It is a local web page: `serve.py` serves the page, and `POST /refresh` runs a
script that reads GitHub data with `gh`. It does not expose tools over MCP and
has no `server.json` describing how Cloister should start it. You can run the
board beside Cloister, but it remains a separate user interface unless it later
adds an explicit Cloister server contract.

## Tier classification ([ADR-0011](../adr/0011-hypervisor-bundle-boundary.md))

The three-criterion test:

- **`hypervisor`** — bundle mediates between bundles + the outside,
  has multi-bundle blast radius, is a singleton per cluster. Removing
  it breaks the cluster. Default config: `cloister-router` +
  `notme-identity`.
- **`cluster`** — user-deployable. Removing one disables a feature
  but leaves the cluster otherwise functional. Default config: `mache`
  + `rosary`.

The tier is documentation + audit — not a runtime gate. The slice-grant
enforcement that ACTUALLY isolates bundles lives at the binding layer
([ADR-0013](../adr/0013-slice-grant-enforcement.md)).

## Bundle kinds

Two `Bundle.kind` variants in `cluster.capnp`:

| Kind | Use for | Phase 1 shipping? |
|---|---|---|
| `workerd` | TS/JS bundles that live INSIDE cloister-router's workerd as v8 isolates | Schema-reserved; no users yet |
| `external` | Subprocess containers — Go/Rust binaries, or their own workerd | All four default bundles |

`cloister-router` itself is `external` even though it IS a workerd —
it runs in its OWN container, not inside another workerd. The
`workerd` kind is reserved for *additional* TS bundles that should
share cloister-router's request loop.

## Hypervisor-tier DOs (live inside cloister-router)

When this page says "cloister-router is the DO state holder," the
Durable Objects classified at the hypervisor tier per ADR-0011 are:

| DO | Singleton? | Purpose |
|---|---|---|
| **`TrustStore`** | `idFromName("cluster")` — yes | Lease counters + nonce ledger + receipts + actor CA bundle archive. ADR-0012. |
| **`BlobStore`** | `idFromName("cluster")` — yes | Content-addressed bytes; one row per `content_hash`. |
| **`CredentialVault`** | `idFromName("cluster")` today | KEK-sealed credentials; ADR-0021 specifies the design migration to per-bundle `idFromName(bundle)`. |
| **`BeadStore`** | per-repo (`idFromName(repo)`) — **NOT** hypervisor | Bead state, partitioned by repo. ADR-0012 reclassified this from hypervisor → cluster-tier. |

`BeadStore` is included as the negative example — its `idFromName(repo)`
shape is what makes it bundle-tier, not hypervisor-tier. The
distinction between "hypervisor-tier *bundle*" (the workerd Worker)
and "hypervisor-tier *DO*" (a singleton class inside the router) is
load-bearing for the ADR-0011 three-criterion test.

## When this list changes

If you add or remove a bundle in `cluster.toml` / `cluster.capnp`,
update the table above. Other docs that mention the topology link to
this page; they don't need to know.

For per-recipe variations (which bundles a specific recipe includes
or omits) see the recipe READMEs under
[`recipes/`](../../recipes/) — each lists its own bundle set with a
link back to this canonical for definitions.
