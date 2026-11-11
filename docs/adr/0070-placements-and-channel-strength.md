---
title: "ADR-0070: Placements and channel strength — one graph, lowered per placement"
status: Proposed
date: 2026-11-10
tags: [connections, placement, confinement, capability, kubernetes, knative, cloud-run, llo-boundary]
tracking-bead: cloister-bfa5bc
relates_to:
  - 0035-cloister-llo-boundary.md
  - 0038-derive-bundle-image-from-packages.md
  - 0068-confinement-is-a-lattice.md
  - 0069-declared-connections.md
---

# ADR-0070: Placements and channel strength

Tracking bead: `cloister-bfa5bc`. Evidence: `cloister-77870d` (prior-art
pass, LLO's ADR-0046 Q7 decision) and `cloister-bb0142` (live edge proof).

## Context

[ADR-0069](0069-declared-connections.md) makes a bundle's connections declared
data: the service dials a name, and the substrate decides what answers. It says
which target answers in each environment. It does not say **where the bundle
itself runs** in each environment, or **how strongly** a missing connection is
enforced there.

The case behind both questions: a Go service runs on Cloud Run in production.
Locally it should run beside its dependencies with no code change. Some of
those dependencies want strong isolation (a microVM). Others only need to
exist (a container in kind).

Two findings settle the design.

**1. No surveyed deployment system makes a missing edge mean a missing
channel** (`cloister-77870d`, primary sources fetched 2026-11-09).
- Radius has an application graph whose placement changes per environment
  through recipe packs. A connection injects env vars, and an undeclared peer
  can still be dialled by DNS.
- Score lowers one workload spec to compose or Kubernetes, and enforces
  nothing.
- UDS comes closest: declared edges become default-deny NetworkPolicy plus
  Istio ALLOW rules. That is still a policy on a shared network.
- Istio ambient and Linkerd both default to allow.

Capability-shaped absence exists only in runtimes: Fuchsia's capability
routing (where the network is itself a routed capability), Sandstorm, and
workerd bindings.

**2. Cloister plus LLO already delivers it on two placements.**
- **workerd:** a Worker reaches another bundle only through a binding.
  `globalOutbound` is closed by Inv 1.
- **microVM:** on the libkrun tier with hijacking off, the guest has no NIC
  and no implicit vsock. Its only channels are vsock mappings compiled from
  confinement/v1 §6 grants. Run live (`cloister-bb0142`), the guest served on
  its one declared port, and every other way out failed: undeclared vsock
  ports had no answer, TCP and UDP were unreachable, and a guest dial on its
  serve port was reset.

LLO's Q7 decision (ley-line-open-e2c5ce, implemented in -be3711) presents each
declared channel to an unmodified workload as TCP on guest loopback. With that,
the property holds for real workloads, not just for a vsock-speaking probe.

## Decision

### 1. Cloister is a composition and control plane, and a mesh is one projection of it

Cloister holds one graph:
- **nodes:** bundles, each with a placement per environment
- **edges:** ADR-0069 connections
- **authority:** identity, vault slices, confinement

From that graph cloister derives both the **execution topology** and the
**channel mediation**. A service mesh is roughly the second half alone, so
cloister does not need a separate mesh to rediscover what the deployment graph
meant. It is not a mesh, and it does not insist on owning a data plane: each
placement uses the mechanism it already has (§3).

### 2. Placement is declared per environment, beside ADR-0069's targets

```toml
[[bundles]]
name = "orders"
[[bundles.placements]]
env  = "local"
kind = "microvm"          # constructed by cloister + LLO
[[bundles.placements]]
env  = "gcp"
kind = "cloudRun"         # forwarded; deployed by the operator's own tooling

[[bundles]]
name = "payments"
[[bundles.placements]]
env      = "local"
kind     = "kubernetes"   # forwarded to whatever cluster kubectl targets (kind locally)
manifest = "deploy/payments/service.yaml"
```

**Amended 2026-11-10 (`cloister-991e65`):** placements are a list of rows
keyed by `env`, not `placement.<env>` keys, because capnp has no map type
(the same amendment ADR-0069 made for connection targets). `manifest` sits on
the row, so each environment can forward a different rendered file. A bundle
with no rows and `executionMode = "microvm"` is placed `microvm` in every env
implicitly, which keeps clusters written before placements existed lowering
unchanged.

Placements come in two classes, and the class decides what cloister owns.

| Class | Placements | Cloister owns |
|---|---|---|
| **constructed** | `workerd`, `microvm` | the node: artifact → rootfs → start, and its channels |
| **forwarded** | `kubernetes` (plain or Knative), `cloudRun` | only the edges: the env overlay and policy, never the workload spec |

**Forwarded placements parse; they do not own.** A forwarded bundle names
manifests the operator already has. Cloister parses only the name, ports and
env var names, and only to check connections (does the target port exist, and
do the `appProtocol`s match). It forwards everything else untouched, plus an
overlay: the connection env vars, and policy for the declared edges. This
follows ADR-0038, which derives what it needs from an artifact the operator
already publishes rather than having it restated.

Three rules keep this from growing into a platform:
- **Rendered manifests only.** Cloister runs no Helm, no Kustomize and no
  terraform.
- **Parsed with a real parser** (`lint:structured-parse`).
- **No `cluster.toml` field that duplicates a field the forwarded spec already
  has.** Adding one is the signal that cloister has started owning nodes it
  does not construct.

**Knative is supported, not required.** Where the manifest is a Knative
Service, cloister forwards it unchanged. Cloud Run accepts that format directly
(`gcloud run services replace`), and so does Kubernetes with Knative installed.
Otherwise a plain Deployment and Service overlay applies.

### 3. Channel strength is a property of the placement, and it is ordered

```
capability  ⊐  policy  ⊐  none
```

| Strength | Meaning of "no declared edge" | Placements |
|---|---|---|
| `capability` | the workload holds nothing to dial | `workerd` (bindings), `microvm` with hijacking off (§6 vsock only) |
| `policy` | a reachable peer is refused | `kubernetes` (NetworkPolicy; kind ≥ v0.24 enforces it), `cloudRun` (IAM invoker + ingress), `microvm` with hijacking on |
| `none` | nothing enforces it | any placement without an enforcing mechanism (e.g. a CNI that ignores NetworkPolicy) |

The strength of an edge is the **meet** of its two ends' placements, in the
same lattice style as [ADR-0068](0068-confinement-is-a-lattice.md). A bundle
or connection may declare a minimum:

```toml
[[connections]]
from = "orders"
name = "payments"
minStrength = "capability"
```

A minimum the resolved placements cannot meet **fails the build by name**. A
warning would not do: "this holds the payments credential, so it must not
share a network" is exactly the claim that otherwise erodes silently when
someone moves a bundle into kind for convenience.

**Socket hijacking is a strength downgrade, not a free switch.** It moves a
microVM from `capability` to `policy`, because the guest then uses the host
network filtered by a port map. It stays off by default, as LLO agreed, and it
is an operator decision outside the plan (the host runtime's existing rule).

### 4. Each placement lowers edges to its native mechanism

| Placement | An edge becomes |
|---|---|
| `workerd` | a service binding |
| `microvm` | a confinement/v1 §6 grant carried in the attested document, plus the guest-loopback address LLO's guest init presents (mapping computed by cloister's emitter, committed in the digest — ADR-0046 Q7) |
| `kubernetes` | a Service DNS name in the env overlay, plus a NetworkPolicy allowing only declared edges |
| `cloudRun` | the target service URL in env, plus a `roles/run.invoker` binding the operator's terraform applies (cloister emits it, does not apply it) |
| constructed ↔ forwarded | two host-side channels joined on the host by LLO's broker (e2c5ce). Never a direct path. |

## Rails shipped with the implementation

- Every bundle resolves a placement for every declared environment.
- Every edge's strength is computed and meets its declared minimum (§3).
- Forwarded manifests parse, and every port an edge references exists in them
  with a matching `appProtocol`.
- No `cluster.toml` field duplicates a field of a forwarded workload spec.
- Hijacking on any microvm bundle is reported as `policy` strength, never as
  `capability`.

## What exists today

- The constructed `microvm` lowering of one edge works at the runtime layer:
  `cloister-bb0142` carries a §6 grant as the exact LLO-compiled document.
- The `workerd` lowering is the existing binding model.
- The emitter lowering from `cluster.toml` for the `microvm` row of §4 is
  built (`cloister-991e65`). `cluster.toml` declares `[[bundles.ports]]` and
  `[[connections]]` with per-env `[[connections.targets]]` rows (bundle
  targets only). `toml-to-cluster` checks them by name. `cloister runtime plan
  --env <name> --channel-dir <abs>` lowers a microvm bundle's exposed ports to
  §6 `bind` grants and its connections to connect grants, both with
  `guestPort`, on `<channel-dir>/<bundle>.<port>.sock`. The two ends of an
  edge get the same path, so separately emitted plans join with no broker. A
  `process` bundle with ports or connections is refused (guestPort is
  microVM-only), and so is a connection whose target is not a microvm bundle.
- Placements and the strength rail are built (`cloister-991e65`).
  `Bundle.placements` holds `{env, kind, manifest}` rows and
  `ConnectionSpec.minStrength` holds the floor. `toml-to-cluster` refuses the
  following by name:
  - a duplicate env;
  - an unknown kind;
  - a `microvm` row on a bundle whose `executionMode` is not `microvm`;
  - a `kubernetes` row with no manifest, or a manifest on a constructed kind;
  - a manifest path that is not relative to the cluster directory;
  - a connection end with no placement for the env, or placed a kind no
    emitter lowers (a channel end must be placed `microvm` or `kubernetes`);
  - an exposed port on a bundle with no `microvm` or `kubernetes` placement;
  - an edge whose meet is below its `minStrength`.

  The rail takes microvm as `capability` unconditionally, because socket
  hijacking is hardcoded off in the host runtime and no plan field can turn it
  on.
- The forwarded `kubernetes` row of §4 is built: `cloister cluster k8s --env
  <name> --out <dir>`. For each bundle placed `kubernetes`, it:
  - parses the rendered manifest with a YAML parser;
  - requires exactly one Service, carrying every exposed port with the same
    name, number and `appProtocol`;
  - copies the manifest byte-for-byte;
  - adds a Namespace named after the bundle, unless the manifest declares it,
    and refuses objects in any other namespace;
  - adds a default-deny-ingress NetworkPolicy;
  - adds one NetworkPolicy per declared kubernetes ↔ kubernetes connection,
    admitting the source namespace + source Service selector to the target
    Service selector on the Service's `targetPort`, TCP.

  The operator's objects carry no namespace, so each bundle directory is
  applied with `kubectl apply -n <bundle>`. The demo is
  `tools/dolt-grpc-demo/k8s/`.
- Edges across placements (microvm ↔ kubernetes) are legal in the graph and
  refused by both emitters, which name LLO's broker (`ley-line-open-e2c5ce`).
  `workerd` and `cloudRun` rows parse, and every emitter refuses them as not
  lowered yet.
- No env lowering. A connection's address does not reach the workload: the
  operator's manifest carries it by hand (the demo's `orders.yaml` passes
  `-db dolt.dolt.svc.cluster.local:3306`), and a launch plan carries no
  workload env. That is also why colliding guest ports are refused rather
  than shifted.
- The constructed `microvm` placement runs end to end from `cluster.toml`
  (`cloister-991e65`).
  - `runtime import --bundle` imports the bundle's pinned image and records
    the rootfs in cluster.lock.toml (`[inputs.<b>.oci] rootfs`, plus
    `rootfsSymlinks` when it isn't the default).
  - `runtime plan` emits that `blake3-256:` rootfs. It refuses, naming the
    import command, when the rootfs is missing from the lock or the store.
  - `cluster up --env <env>` starts every microvm-placed bundle, targets
    before sources. A bundle counts as "bound" once its bind sockets exist; its
    health isn't checked ([ADR-0071](0071-who-owns-a-running-workload.md) §3). It supervises the
    runs in the foreground and stops them in reverse order. The host runtime
    cancels its LLO run on SIGINT/SIGTERM.
  - Live: the dolt/orders demo answered grpcurl over a declared edge. With the
    edge removed, orders exited 2 and `up` tore dolt down
    (`tools/dolt-grpc-demo/microvm/`).
  - Images come from an on-disk OCI layout, or since LLO v0.29.0 from their
    registry. `runtime import --bundle` with no `--layout` pulls the lock's
    pinned `identifier@sha256:…`, anonymously over HTTPS (`cloister-727354`).
    The CAS root and the run root sit on LLO's case-sensitive volume, which
    `runtime install` provisions. The published `dolthub/dolt-sql-server`
    image runs this way, with no env
    (`tools/dolt-grpc-demo/microvm-published/`).
- Not built: the `cloudRun` lowering, `cloudSql` / `cloudRun` targets, the
  "no `cluster.toml` field duplicates a forwarded spec field" rail beyond the
  Service-port check, and policy for `expose = "edge"` ingress from outside
  the cluster.
- Not built: ADR-0069 §2's rail "every connection resolves for every declared
  env". There is no env registry yet, so nothing knows which envs a cluster
  declares. A connection with no target for an env is refused only when that
  env is lowered (`runtime plan --env`, `cluster k8s --env`).

## Out of scope

- Running terraform, Helm or any deploy tool (forwarded means forwarded).
- Multi-cluster Kubernetes (one cluster locally, one namespace per bundle).
- The broker's protocol handling, which is LLO's (ADR-0035).
- Front-door framing of the README, which is decided elsewhere.
