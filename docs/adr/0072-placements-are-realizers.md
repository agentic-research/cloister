---
title: "ADR-0072: Placements are realizers of one grant set"
status: Proposed
date: 2026-11-11
tags: [placement, capability, grant, lowering, confinement, connections, strength, llo-boundary]
tracking-bead: cloister-2af831
relates_to:
  - 0035-cloister-llo-boundary.md
  - 0046-mediated-capability-core.md
  - 0069-declared-connections.md
  - 0070-placements-and-channel-strength.md
  - 0071-who-owns-a-running-workload.md
---

# ADR-0072: Placements are realizers of one grant set

Tracking bead: `cloister-2af831` (the cross-placement demo).

## Context

[ADR-0070](0070-placements-and-channel-strength.md) declares one graph:
bundles, their placement per environment, and the connections between them.
Each placement then lowers edges to its own mechanism. Two lowerings have
shipped, and both have been checked live:

- **microVM.** `cli/lib/cluster/connections.mjs` turns a bundle's ports and
  connections into confinement/v1 §6 socket grants, and `cluster up` runs them.
- **Kubernetes.** `cli/lib/cluster/emit-k8s.mjs` turns the same declarations
  into namespaces and NetworkPolicies.

Each one reads the graph and produces its own mechanism directly. That makes
them separate working paths. An external review called this out as the main
gap: each new placement (workerd, Docker, Cloud Run) would add another path,
and nothing would guarantee that the paths agree on what was granted.

Underneath, every placement realizes the same few things: what the workload
can see on disk, which peers it can reach, what it can reach beyond them,
and which credentials it holds. [ADR-0046](0046-mediated-capability-core.md)
already decides this for transports: one capability core, with syscall, rpc
and ipc as adapters. This ADR applies the same decision to placements.

## Decision

### 1. The graph lowers once, to a grant set per bundle

Lowering is a function from the graph and an environment to one **grant set**
per bundle. The function does not depend on placement. A grant set has four
kinds of grant, which match ADR-0046's adapters and LLO's confinement/v1
dimensions:

| Kind | A grant says | Source in the graph | LLO document |
|---|---|---|---|
| `fs` | this path is visible at this point, read-only or read-write | the bundle's confinement `fs.allow`, and the workspace | confinement/v1 §2 |
| `channel` | serve, or dial, one named peer port with this `appProtocol` | ports and connections (ADR-0069) | confinement/v1 §6, connections/v1 |
| `egress` | reach these hosts beyond declared peers | confinement `network.allowHosts` | confinement/v1 §3 |
| `credential` | hold this vault slice | `holdsCredential` / `vaultSlice` | credential-isolation/v1 |

A grant set names peers by **bundle and port name**, never by address. Each
realizer allocates addresses: a socket path, a Service DNS name, a host port.
That is ADR-0069 §2's rule ("endpoint addresses are allocated, not typed")
placed where it belongs.

### 2. A placement is a realizer with a declared capability table

A realizer turns a grant set into its runtime's mechanism. It declares, for
each kind, the mechanism it uses and the **strength** it achieves
(ADR-0070 §3: `capability ⊐ policy ⊐ none`), or `unsupported`:

| Realizer | fs | channel | egress | credential |
|---|---|---|---|---|
| `microvm` | rootfs plus share: capability | §6 vsock socket: capability | unsupported (refused) | unsupported |
| `kubernetes` | volume: policy | DNS plus NetworkPolicy: policy | NetworkPolicy egress: policy | unsupported |
| `workerd` | unsupported (no POSIX FS) | service binding: capability | unsupported (refused) | vault slice: capability |

The table is data that the realizer exports, and the strength rail reads it.
It isn't prose. The rows above describe what ships today, and a realizer
changes its own row when it gains a mechanism.

`unsupported` for a kind is a refusal of any grant of that kind. It is not a
weaker version of it. Leaving a kind ungranted is a strong guarantee on every
row here:
- a microVM with hijacking off has no network beyond its §6 channels;
- a workerd tool bundle has no `globalOutbound`, so `fetch()` is undefined
  ([ADR-0013](0013-slice-grant-enforcement.md));
- Kubernetes has no such guarantee without a default-deny policy, which the
  realizer emits.

### 2a. Realizers compose: a tree, not n peers

Most placements are the same few primitives with a different config format
on top. Each primitive does three jobs:
- **boundary:** what contains the workload;
- **interfaces:** how bytes get in and out;
- **storage:** what it sees on disk.

The **enforcing layer** is the layer that stops an undeclared edge. It must
sit below the workload and outside the workload's control, and it sets the
strength. So realizers form a tree. A child declares its parent and states
only what it adds or overrides; every other row of its table is inherited.

```
container            namespaces + cgroups, veth/bridge, overlay       enforcer: host kernel  → policy
├── docker           + bridge network (none on the default bridge)
└── kubernetes       + Service DNS + NetworkPolicy                     (policy only if the CNI enforces it)
vm                   hypervisor, vsock, rootfs + virtio-fs             enforcer: VMM          → capability
└── microvm (LLO)    + confinement/v1 §6 channels
isolate              V8 isolate, bindings, no POSIX FS                 enforcer: runtime      → capability
└── workerd          + service bindings, vault slices
managed (no primitives cloister can see)
└── cloudRun         + IAM invoker, ingress setting                    enforcer: provider     → policy
```

Three consequences:
- **Cloister configures none of these layers itself.** Below cloister, LLO and
  each runtime configure Linux, the hypervisor or the isolate (ADR-0035). A
  realizer is an **encoder** from a grant set into its layer's config format:
  LLO's run grant, Kubernetes YAML, Docker flags, workerd config.
- **A new placement is usually a new child.** Podman goes under `container`,
  Firecracker under `vm`. The child adds an encoder and the rows that differ,
  so ADR §6's test ("adding a placement adds one realizer") becomes "adding a
  placement adds one node".
- **Nesting only adds containment.** A placement can run inside another: on a
  developer Mac, kind runs inside Docker, which runs inside a desktop VM. For
  any edge, the strength is decided by the innermost layer that actually
  enforces that edge. The outer layers can't raise it, and they can't lower it
  for traffic that never crosses them. The rail computes strength from the
  realizer the grant is placed on. The nesting is recorded only to explain it.

### 3. The strength rail is generic

For each grant, the build computes the strength the realizer achieves. For
an edge, it takes the meet of the strengths at both ends.

- A grant whose kind is `unsupported` on its placement **fails the build by
  name**. It is never dropped silently.
- A declared `minStrength` that the result can't meet fails the build by
  name, as ADR-0070 §3 already requires for channels. This ADR extends that
  check to every kind.

### 4. An edge between placements is realized by a bridge

When a channel's two ends are realized by different placements, neither
realizer owns the edge. A **bridge realizer** does: LLO's connection broker
(ADR-0046 Slice 1, `ley-line-open-e2c5ce`).

- Its input is the same channel grant.
- Its output is the connections/v1 entry for the broker, plus each end's local
  half: a §6 connect grant on the microVM side, and a host-published port on
  the Kubernetes side.
- Its strength is the meet of the two ends' strengths. The bridge itself never
  raises it.

### 5. What a grant set does not carry

- **Lifecycle.** Health, restart, scaling and stop grace belong to the
  runtime, or are read from the forwarded spec (ADR-0071). They are not
  grants.
- **The workload spec of a forwarded placement.** Its realizer reads names,
  ports and protocols from the operator's manifest, as ADR-0070 §2 requires,
  and overlays only the realization of its grants.

### 6. The test that the abstraction held

Adding a placement adds **one realizer and its table**. The graph, the
lowering, the strength rail and every other realizer stay unchanged. A change
that has to touch any of those to add a placement means the grant set is
missing a concept, and the change has to say which one.

## Consequences

- The two shipped lowerings are refactored onto the grant set, and their
  output must not change. The #283 and #284 tests, the emitted-plan fixtures
  shared with Rust, and the k8s emitter fixtures must pass unchanged.
- For microVMs, the grant set maps onto confinement/v1 and connections/v1
  with nothing lost. That is the same document LLO already validates, so
  cloister and LLO keep one vocabulary.
- Docker and Cloud Run become one realizer each. Docker is likely `policy` at
  best (bridge networks), or `none` on the default network. The table states
  that rather than hiding it.

## What exists today

| Part | State |
|---|---|
| §1 the grant set as a type | not built. The two lowerings read the graph directly. |
| §2 realizer tables, §2a the realizer tree | not built. The strengths for microvm and kubernetes are hard-coded in `connections.mjs`. |
| §3 generic strength rail | channels only (ADR-0070, #284) |
| §4 bridge realizer | not built. It depends on LLO's broker Slice 1 (`ley-line-open-e2c5ce`) and env lowering (`cloister-2af426`). |
| §6 the test | not run yet. The cross-placement demo (`cloister-2af831`) is its first application. |

## Order of work

1. Refactor the two shipped lowerings onto the grant set and their tables,
   with no change in output. Do this once LLO's broker Slice 1 shape is known,
   so the channel grant is checked against connections/v1 rather than guessed.
2. Add the bridge realizer, built on LLO v0.30.0.
3. Build the cross-placement demo: an agent in a microVM, an API in kind,
   and the database. Then move the API to a microVM, and confirm the move
   touches only the placement row in `cluster.toml`.

## Out of scope

- A cloister-owned data plane. Bridges are LLO's (ADR-0035).
- Discovering infrastructure (Terraform outputs, Compose services). An
  importer can add facts to the graph. It never adds grants: only declared
  connections do (ADR-0070 §2).
