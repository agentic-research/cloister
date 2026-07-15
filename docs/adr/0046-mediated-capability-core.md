---
title: "ADR-0046: The mediated-capability core — syscall / rpc / ipc as 1:1 transport adapters over one lease+receipt plane"
status: Proposed (2026-07-14)
date: 2026-07-14
tags: [substrate, capability, mediation, lease, receipt, isolation, fs, rpc, ipc]
threat_model: docs/security/threat-model.md
relates_to:
  - 0007-interlace-substrate.md
  - 0013-slice-grant-enforcement.md
  - 0024-credential-isolation-capability.md
  - 0028-capability-scheme.md
  - 0043-delivery-plane-skills-agents-tools.md
  - 0044-compute-isolation-substrate.md
---

## Context

Three cloister subsystems look unrelated and are, on inspection, the **same
thing wearing three transports**:

| Subsystem | Transport | Mediates access to | ADR |
|---|---|---|---|
| **vault-proxy** (`credential-isolation/v1`) | HTTP / MCP (**rpc**) | credential bytes | ADR-0024 |
| **service-binding** — *"service-binding-as-syscall"* | capnp over UDS (**ipc**) | other bundles | ADR-0013 |
| **FS mediator** (the compute-substrate's fs) | virtio-fs / FUSE (**syscall**) | files, skills, tools, workspace | ADR-0044 |

Each one does the identical five things: it **holds** a resource the caller must
not touch directly, **gates** access on an Interlace lease + scope, **serves**
only the policy-permitted projection, **receipts** every access, and **never
lets the raw resource cross** the trust boundary.

This is not a post-hoc analogy — it is already **half-built and observable in
the tree**:

- `src/routes/lease-middleware.ts` → `VerifiedLease` is **already shared** by the
  rpc adapter (vault-proxy) and the ipc adapter (service-binding). Two adapters,
  one lease core, shipped.
- The §7 confinement-digest verify (`cloister-c80953`, shipped) binds an **fs
  policy** to the **same Interlace cert** the vault's leases use — the third
  adapter already reaches for the same identity plane.
- A libkrun spike (2026-07-14, `cloister-b28416`) proved a guest's fs reads and
  writes **forward to a host-side mediator** through *stock* libkrun — so the
  syscall adapter can reuse the pattern rather than fork the VMM.

ADR-0013 already names the load-bearing edge of this: a service binding **is a
syscall** to the substrate. This ADR completes the triangle — **fs-syscall ≡
rpc ≡ ipc**, all invocations of one capability — and names the shared core so
the FS mediator is built as *instance #2 of a proven pattern*, not a new
subsystem.

## Decision

Adopt a single **mediated-capability core** with pluggable **transport
adapters**. The core is transport-independent; each adapter normalizes its
transport's operations into the core's shape.

### The core contract

```
(subject-lease, verb, resource-ref, args)  →  (decision, projection, receipt)
```

with five invariants, none of which mention a transport:

1. **lease-gate** — the caller presents a verified Interlace lease (ADR-0007
   pipeline; `VerifiedLease`).
2. **scope-check** — the lease's scope must grant the requested capability.
3. **receipt** — every grant is receipted (the `ProxyCallReceipt` /
   `SkillLoadReceipt` shape), giving one tamper-evident provenance trail.
4. **no-raw-egress** — the raw resource never crosses the boundary (plaintext
   credential stays in the vault DO; host paths never enter the guest's view).
5. **inflight-cap** — per-subject fairness (the vault's `inflightBySubject`),
   so one caller can't starve the mediator.

### Authorization is at capability **grant**, not per-op

The check runs when a capability is **acquired** (an `open`/`mount`, an RPC
session, a binding resolution) — **not** on every byte. After the grant, ops on
the authorized handle are fast-path. This is the capability-microkernel
discipline (seL4, Fuchsia/Zircon: a syscall, an IPC message, and an RPC are the
same act — invoking a capability on a resource; the expensive check is the grant,
not the invocation). It is what makes a 10⁴–10⁶/sec syscall transport viable on
the same core as a coarse RPC.

### The three adapters

| Adapter | Transport | Resource | Instance | Status |
|---|---|---|---|---|
| **rpc** | HTTP / MCP | creds, tools | vault-proxy (`credential-isolation/v1`) | **shipped** |
| **ipc** | capnp / UDS | bundles | service-binding (ADR-0013) | **shipped** |
| **syscall** | virtio-fs / FUSE | files, skills, workspace | FS mediator (ADR-0044) | proposed |

One core, three surfaces. The **policy plane** (lease + scope + receipt +
no-egress + cap) is shared and built once; each **adapter** owns its own
granularity, statefulness, latency profile, and verb vocabulary and translates
into the core's op shape. The core stays **verb-agnostic** — it asks "is this
subject allowed this capability?"; the adapter interprets `open`/`mmap`/`POST`/a
capnp method into that question.

## Constraints (the honest limits — where this design earns trust)

A steel-man that ignores its own failure modes is not strong. Three limits are
load-bearing and MUST be stated wherever this core is claimed:

1. **Grant-time, not per-op.** The 1:1 holds at the *capability* layer, not the
   *per-byte* layer. You cannot lease-verify or receipt every `read()`; you
   authorize the handle once and stream. Designs that assume per-syscall
   authorization will not perform.

2. **`mmap` + DAX defeat per-op mediation — a real hole in observability.** Once
   a guest maps a writable region (or virtio-fs DAX maps pages directly), writes
   hit shared memory with **no syscall per write** — the mediator is bypassed.
   Therefore mediated paths run **DAX off (`shm_size = 0`) and refuse
   shared-writable `mmap`**, at a measured perf cost. This is the one place the
   unification has a true limit; it is named, not glossed.

3. **Audit granularity is grant / CAS-object-load, not per-byte.** "Receipt every
   op" degrades to "receipt every capability grant and every content-addressed
   load" (a skill load = one `open` of a digest). That is coarse enough for
   provenance ("which signed artifacts ran, under which lease, when") but the
   design must be built that way — per-byte provenance is not offered and must
   not be claimed.

And one framing discipline:

4. **Mediation-core ≠ isolation-ring.** The core (ring 2 — shared, transport-
   blind) is separate from the isolation boundary that contains the caller
   (rings 0–1 — V8 isolate for the vault, process for ipc, VM for fs;
   platform-specific). That the *same* core works behind a V8 boundary, a
   process boundary, and a VM boundary is the proof it is isolation-independent —
   but only if the two layers are kept distinct in code and in prose.

## Relationship to the capability ADRs

- **ADR-0027 (capability matchmaker)** is **composition** — which capabilities
  wire to which, resolved at build time. **This ADR is invocation** — how a
  *granted* capability is mediated at runtime. Complementary: 0027 builds the
  graph; 0046 mediates the calls along its edges.
- **ADR-0024** is the **rpc adapter** (the first instance, and ADR-0027's
  "Phase 4d re-shapes cred-iso/v1 AS a capability to prove the framing" — this
  ADR is what it is re-shaped *into*).
- **ADR-0013** is the **ipc adapter** ("service-binding-as-syscall").
- **ADR-0044** is the **syscall adapter**; its FS mediator becomes instance #2
  that proves the framing generalizes beyond credentials.
- **ADR-0028** (capability identifier scheme) names the capabilities this core
  mediates; **ADR-0043** (delivery plane) is the read-side of the syscall
  adapter (signed skills/tools + load receipts).

## Consequences

- **Build the hard part once.** The lease pipeline, cert-chain verify, receipt
  chain, attestation, and DoS caps are written once and reused across creds,
  files, and bindings. The non-unified trajectory reimplements them three times
  with three chances to diverge.
- **One provenance plane.** Because every capability invocation flows through one
  receipted core, the audit log is unified across resource types: "peer P, under
  lease L, loaded skill D (syscall), called anthropic (rpc), wrote bead B (ipc),
  at times T" — the ADR-0040 control-plane trail, made total.
- **Smaller trusted surface**, and a single place to reason about the
  authorization + audit invariants.
- **New trust seam:** the shared core becomes a high-value target — a bug in it
  is a bug in all three adapters. The threat model gains a section for the core
  before it is factored out of `lease-middleware`.

## Alternatives considered

- **Three separate mediation stacks** (the status-quo trajectory). Rejected:
  triplicate lease/receipt logic, divergence risk, three audit formats.
- **Per-op authorization (no grant fast-path).** Rejected: the syscall hot path
  dies; it also contradicts the capability-OS model this borrows from.
- **Unify the data plane too.** Rejected as a lowest-common-denominator trap:
  only the *policy* plane is universal. Data movement (virtio-fs ring, HTTP body,
  capnp frame) stays fully adapter-native; the core unifies authorization + audit
  only.

## Open questions

- The common op vocabulary: exactly how much the adapter interprets vs. what the
  core sees. Candidate: the core sees `(lease, capability-id, decision)` and the
  adapter owns everything else.
- Receipt chaining across adapters into one provenance log — the schema and the
  cross-adapter ordering guarantee.
- Where the shared core lives as code: factor it out of
  `src/routes/lease-middleware.ts` into a named module/crate, or leave it in
  place and have the syscall adapter depend on it.
- The `mmap`/DAX perf cost with DAX off — measure against the S3 spike.
- Whether the ipc adapter (service-binding) should be retrofitted to emit the
  same receipt shape as the rpc adapter (today it may not).

## References

- `src/routes/lease-middleware.ts` — the lease core already shared by the rpc +
  ipc adapters.
- `src/vault-store.ts` — the five invariants, observable: `VerifiedLease.peerFp`
  (gate), "plaintext credential bytes never cross the RPC boundary" (no-egress),
  `inflightBySubject` (cap).
- `cloister-c80953` — the §7 fs-policy bound to the same Interlace cert (shipped).
- `cloister-b28416` — the libkrun mediate-below-stock spike (2026-07-14).
- ADR-0013, ADR-0024, ADR-0027, ADR-0028, ADR-0043, ADR-0044.
