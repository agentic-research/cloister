---
title: "ADR-0069: Declared connections — the service dials a name, the substrate decides what answers"
status: Proposed
date: 2026-10-20
tags: [connections, ports, env, app-protocol, credentials, vault, confinement, local-dev, gcp, llo-boundary]
threat_model: docs/security/threat-model.md
relates_to:
  - 0004-capnp-manifest.md
  - 0010-vault-and-bundle-clusters.md
  - 0030-multi-workerd-tenant-isolation.md
  - 0033-bd-substrate-binding.md
  - 0035-cloister-llo-boundary.md
  - 0051-uds-input-transport.md
  - 0066-what-a-notme-wimse-uri-names.md
  - 0068-confinement-is-a-lattice.md
---

# ADR-0069: Declared connections

Tracking bead: `cloister-77870d`. Related: `cloister-778a44` (edge `appProtocol` has no reader).

## Context

The use case is ordinary: **a local dev environment that mirrors a GCP
deployment of Go containers.** In GCP a service talks to Cloud SQL, Pub/Sub,
GCS and its siblings; locally the same image should talk to a Postgres
container, the emulators and the local siblings — no code change, no
per-environment config inside the service. It is network wired to network,
the thing compose / Kubernetes Services / Istio already do.

Cloister has fragments of this and none of them connect:

| Today | Problem |
|---|---|
| `[[edges]].appProtocol` (ADR-0030 §A4) | validated by `lint-app-protocol`, read by nothing |
| `BundleSpec.httpPort` | one unnamed port, HTTP only |
| `confinement.port.bind` | the same port stated a second time; spec allows only one |
| `EnvVar { name, value }` | plaintext only — secrets become values |
| `Wire.binding` | a second, unchecked source of env var names |

## Boundary (ADR-0035)

This ADR is the **declaration half only**. Keeping the halves apart is the point.

- **Cloister owns:** the `cluster.toml` / `cluster.capnp` surface below, the
  per-environment resolution of targets, the derived env vars and confinement
  grants, and the rails that check them. All of it is emit-time data.
- **LLO owns:** whatever moves bytes — the broker that listens on the local
  endpoint, dials the target and injects the credential — and confinement
  enforcement, including widening confinement/v1 §4 to more than one port.
  Implementation choices there (e.g. building the broker on Pingora) are
  LLO's to make in LLO's ADRs, not here.
  Tracked as `ley-line-open-e2c5ce` (connection broker).

The seam between them is a data contract: cloister emits, per bundle, a list of
`{endpoint, target, appProtocol, credentialRef}` plus the confinement manifest.
Its shape is to be agreed with LLO before this ADR is accepted
(discovery-first: read LLO's current ADRs on the broker / host-runtime first).

## Decision

### 1. The service surface, in one place

```toml
[bundles.orders]
image = "ghcr.io/acme/orders@sha256:…"

[[bundles.orders.ports]]                 # inbound
name        = "grpc"
port        = 8080
appProtocol = "art.grpc"
expose      = "cluster"                  # "none" | "cluster" | "edge"

[[bundles.orders.ports]]
name        = "metrics"
port        = 9090
appProtocol = "art.http"
expose      = "none"

[bundles.orders.env]                     # config — one source per name
LOG_LEVEL     = { value = "debug" }
STRIPE_KEY    = { vaultSlice = "orders-stripe" }
DATABASE_ADDR = { connection = "orders-db" }
PAYMENTS_ADDR = { connection = "payments" }

[bundles.orders.health]
port = "metrics"
path = "/healthz"

[[connections]]                          # outbound
from        = "orders"
name        = "orders-db"
appProtocol = "art.postgres"
[connections.target.local]
bundle = "postgres"
port   = "pg"
[connections.target.gcp]
cloudSql   = "proj:us-central1:orders"
vaultSlice = "orders-db-iam"

[[connections]]
from        = "orders"
name        = "payments"
appProtocol = "art.grpc"
[connections.target.local]
bundle = "payments"
port   = "grpc"
[connections.target.gcp]
cloudRun = "payments"
```

The service reads `DATABASE_ADDR` and dials it. That is its whole contract.

### 2. Rules

- **Names across references, numbers only on the port row.** Connections and
  health checks name a port.
- **One env namespace, one source per name.** Literal, vault slice,
  connection, emulator convention, platform convention — two sources for one
  name fails the build (compose's last-writer-wins is the bug this prevents).
- **Targets are per environment; the image is not.** `target.<env>` is
  selected at emit (`--env local|gcp`); every connection must resolve for every
  env the cluster declares.
- **Platform conventions are emitted, not hand-set.** `PORT` (Cloud Run) from
  the first exposed port; `PUBSUB_EMULATOR_HOST` / `STORAGE_EMULATOR_HOST` /
  `FIRESTORE_EMULATOR_HOST` / `SPANNER_EMULATOR_HOST` when a `local` target is
  an emulator. Google's client libraries already honour these, so GCP APIs need
  no broker locally.
- **Endpoint addresses are allocated, not typed.** The address behind a
  `connection` env var is assigned by the emitter, deterministically.
- **Credentials are references.** `vaultSlice` everywhere, never a value
  (ADR-0010 / ADR-0051). A brokered connection's credential is injected by the
  broker, so the service never holds it; `vaultSlice` *env* is the fallback for
  what cannot be brokered. The `gcp` target authenticates via Workload Identity
  Federation from the bundle's notme identity (ADR-0066), never a key file.
- **`appProtocol` is consumed.** It is carried into the LLO contract (what the
  broker does with it is LLO's) and checked: a connection's `appProtocol` must
  equal its target port's. Edge `appProtocol` becomes derived from these.
  New blessed labels this needs: `art.postgres`, `art.mysql`, `art.redis`
  (ADR-0030 §A4 amendment).

### 3. Databases: the protocol is the wire, the engine is the target

MySQL, Postgres and Dolt look like three choices and are really two wires:

| `appProtocol` (wire) | Engines that speak it |
|---|---|
| `art.mysql` | MySQL, Cloud SQL for MySQL, MariaDB, Vitess/PlanetScale, **Dolt** (`dolt sql-server`) |
| `art.postgres` | Postgres, Cloud SQL for Postgres, AlloyDB, CockroachDB, **DoltgreSQL** |

So `appProtocol` names the wire — it is what the broker (LLO) has to handle,
and it is the same whatever answers. The **engine** is a property of the
target, and the two are checked against each other: a target whose engine does
not speak the connection's wire fails the build.

```toml
[[connections]]
from        = "orders"
name        = "orders-db"
appProtocol = "art.mysql"
[connections.target.local]
bundle = "dolt"                     # engine = "dolt", declared on the bundle
database = "orders"
branch   = "dev-${USER}"            # Dolt-only component
[connections.target.gcp]
cloudSql   = "proj:us-central1:orders"   # engine = "cloudsql-mysql"
database   = "orders"
vaultSlice = "orders-db-iam"
```

What that buys for the dev-environment use case: GCP runs Cloud SQL for MySQL,
locally the same service talks to Dolt, and the dev database is
**branchable** — seed data is a commit, a developer's experiments live on their
own branch, and "reset my DB" is a checkout. The service is unchanged because
it only ever spoke MySQL.

Rules:

- **`database` and `branch` are structured target components, never a DSN**
  (ADR-0051). Dolt addresses a branch as part of the database name
  (`orders/dev-alice`); the emitter composes that, the operator does not.
  `branch` on a non-versioned engine fails the build rather than being ignored.
- **Wire compatibility is a claim to verify, not assume.** Dolt's MySQL
  compatibility and DoltgreSQL's Postgres compatibility are broad, not total.
  Substituting one engine for another between `local` and `gcp` is the
  operator's call; the substrate guarantees the wire matches, not that every
  query behaves identically.

**ADR-0033 still holds, and this ADR does not reopen it.** That ADR decided
*workerd does not get a MySQL client* and cloister must not acquire a direct
Dolt / MySQL / sql-server binding for **bead** access — beads arrive only over
rosary's MCP interface. Declared connections are for an **external** bundle's
own data (the Go service and its database). So:

- A SQL-wire connection (`art.mysql`, `art.postgres`) may only be declared
  `from` an external bundle, never a workerd-tier bundle. Giving a Worker a SQL
  connection requires amending ADR-0033 first.
- No connection may target the bead store. Rosary's own Dolt, if it uses one,
  is behind its MCP boundary and is not a connection cloister can see or
  declare.

### 4. What becomes derived

| Field | Derived from |
|---|---|
| `httpPort` | `ports[]` (deprecated; still parses) |
| confinement port grants | `ports[]` — never hand-written alongside them |
| `network.allowHosts` | `[]` for any bundle with connections: the endpoints are its only egress (loopback endpoints need `ley-line-open-0e73e8`) |
| `Wire.binding` env | a `connection` env source |
| `[[edges]].appProtocol` | `ports[]` + `connections` |

### 5. Multiple listeners are required

A real service binds more than one port. Cloister declares and derives the
list; confinement/v1 §4 granting a single port is an **upstream dependency**
(LLO: `ley-line-open-e2c33f`; enforcement of any listener grant is
`ley-line-open-17536d`). Cloister-side: `Confinement` gains `ports @4 :List(ConfinementPort)`
(append-only; singular `port @2` still parses as a one-element list). Until
the pinned LLO release folds a list, the rail refuses a multi-listener microvm
bundle by name, citing the dependency — fail closed, never "grant the first
one".

## Rails shipped with the implementation

- Every `appProtocol` in the tree is consumed by an emitter.
- Port references resolve by name; connection ↔ target-port `appProtocol` match.
- Every connection resolves for every declared env.
- Env namespace: no name from two sources.
- Target engine speaks the connection's wire; `branch` only on a versioned engine.
- SQL-wire connections only `from` external bundles; none targets the bead
  store (ADR-0033).
- Bundle with connections ⇒ empty `allowHosts`; port grants derived, not
  hand-set.

## Out of scope

- The broker, its protocol handling and its placement — LLO.
- Deriving `target.gcp` values from a Terraform graph (`terraform output -json`
  → connection targets, tf resources as ADR-0027 capability providers).
  Separate ADR.
- Volumes (`StoragePolicy`), resource limits, replicas.
