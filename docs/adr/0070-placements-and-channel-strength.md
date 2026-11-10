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
[bundles.orders]
placement.local = "microvm"     # constructed by cloister + LLO
placement.gcp   = "cloudRun"    # forwarded; deployed by the operator's own tooling

[bundles.payments]
placement.local = "kubernetes"  # forwarded to whatever cluster kubectl targets (kind locally)
manifest        = "deploy/payments/service.yaml"
```

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
- The emitter lowering from `cluster.toml`, the forwarded placements, and the
  strength rail are not built.

The first slice after this ADR is two services joined by one declared
connection, with:
1. a positive and a negative assertion on a `capability` placement, and
2. the same two services forwarded to kind as the `policy` tier.

## Out of scope

- Running terraform, Helm or any deploy tool (forwarded means forwarded).
- Multi-cluster Kubernetes (one cluster locally, one namespace per bundle).
- The broker's protocol handling, which is LLO's (ADR-0035).
- Front-door framing of the README, which is decided elsewhere.
