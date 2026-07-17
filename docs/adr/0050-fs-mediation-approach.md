---
title: "ADR-0050: FS-mediation approach — content-addressed rootfs + VM isolation as the substrate, per-op FUSE as an escalation"
status: Proposed (2026-07-17)
date: 2026-07-17
tags: [compute-isolation, filesystem, content-addressed, provenance, prior-art, libkrun]
threat_model: docs/security/threat-model.md
relates_to:
  - 0009-compute-substrate-portability.md
  - 0043-delivery-plane-skills-agents-tools.md
  - 0044-compute-isolation-substrate.md
  - 0046-mediated-capability-core.md
  - 0048-unified-tool-primitive.md
  - 0049-cloister-host-runtime.md
---

## Context

ADR-0044 chose **host-side per-op FUSE mediation** as *the* compute-isolation
filesystem substrate — "the guest's only filesystem is a mediated fs; every
read/write is a host-authorized op." ADR-0049 surfaced that the load-bearing new
code is a `fuse-backend-rs`-over-`leyline-fs::Graph` adapter (leyline-fs's FUSE is
`fuser`; libkrun's is `fuse-backend-rs`) — the crux the whole runtime hinges on.

Before building the hardest possible thing, we surveyed how five shipping
AI-agent sandboxes (all 2026-GA) handle the filesystem. The finding reorders the
bet.

## Prior art — how five shipping sandboxes handle the fs

Each row cites a primary vendor source (see Sources).

| System | Isolation boundary | Guest fs | Per-op fs mediation | Persistence | Provenance |
|---|---|---|---|---|---|
| **Cloudflare Sandbox** | per-sandbox **VM/container** | normal Linux fs (`readFile`/`writeFile`) | **no** — `inotify` for *events* only (`watch()`→SSE) | container/VM | none (boundary) |
| **Vercel Sandbox** | **Firecracker** microVM | normal private fs | **no** | **auto-snapshot** on stop/resume; Drives (beta) | none (boundary) |
| **E2B** | **Firecracker** microVM (own kernel) | normal fs (`rootfs.ext4`) | **no** | **snapshot-restore** (rootfs+mem, ms-class) | none (boundary) |
| **Modal** | **gVisor** (user-space kernel, syscall intercept) | ephemeral container fs | **no** — gVisor filters syscalls for *isolation*, not per-file policy | **Volumes** (background commit) | none (boundary) |
| **Daytona** | per-sandbox **dedicated kernel** | own fs | **no** | container/workspace | none (boundary) |

**The consensus is unanimous, and it is not cloister's plan:** isolate the whole
fs at the VM/container boundary, expose a normal fs inside, persist via
snapshot/volume. **Nobody does host-side per-op fs mediation**, and **nobody uses
a content-addressed rootfs** — all use plain `ext4`/overlay.

Two readings, both true:

1. Per-op mediation is genuinely **novel** (ADR-0044 was right that no one ships
   it) — but novel *because it is the hard path the market routed around*, getting
   "good enough" isolation from the boundary.
2. cloister's real differentiator is **provenance** (its whole thesis: attestation,
   receipts, capsule lineage), and the cheapest, most robust source of provenance
   is a **content-addressed, signed rootfs** — which no competitor has and which
   cloister *already has* (leyline CAS + the arena; ADR-0044 itself says "the
   rootfs is the OCI image over virtio-fs").

## Decision

**Adopt the content-addressed shape as the fs substrate; make per-op FUSE
mediation an *escalation*, not the default.** The ADR-0049 host-runtime fs is:

- **Base = a content-addressed, signed rootfs.** The read-only tree is the
  leyline-fs arena / OCI image — every file is a CAS blob with a digest, so the
  rootfs *is* a signed manifest of exactly what is loadable. This is "every skill
  load is traced" at the **scope + integrity** level (ADR-0043): you can prove the
  exact signed set the agent could load. No competitor does this.
- **Isolation = the VM boundary** (libkrun, ADR-0044) — the industry consensus,
  proven, sufficient.
- **Deny = content-absence + LSM.** Out-of-scope content is simply not in the
  rootfs; `nono` (Seatbelt/Landlock) denies host paths (incl. the ADR-0049
  credential paths).
- **Writes = CoW overlay + validate-on-commit.** leyline-fs's `StagingGraph`
  already does copy-on-write + validate-on-write; validation lands per-reproject,
  not per-syscall.
- **Events = `inotify`** (Cloudflare's move) or CAS-materialization events — which
  is also the hooks lever (`cloister-6998d3`).

**Per-op FUSE mediation (the `fuse-backend-rs`-over-`Graph` adapter) is deferred**
to an escalation, built *only* when the threat model requires **host-side per-read
proof** that content-addressing + VM-isolation cannot give — i.e. "prove the agent
*read* file X," not merely "prove X was in its signed rootfs."

This **amends ADR-0044** (the substrate is the content-addressed rootfs, not the
per-op FUSE server) and **resolves ADR-0049 open question #1** (do not build the
adapter now).

## What this reuses vs defers

- **Reuses:** the `ConfinementGraph` + leyline-fs `Graph` work (#139–141) feeds the
  rootfs — the policy decides *what goes into the signed rootfs* (the scope); the
  CAS/arena is the base. libkrun + nono + the OCI-rootfs path already exist.
- **Defers:** only the per-op *serving* (`serve_nfs` / the `fuse-backend-rs`
  adapter). The NFS spike (`tools/libkrun-spike`) stays a throwaway that proved
  per-op mediation is *possible* — no longer on the critical path.

## Consequences

- **Ships faster + de-risked** — the hard adapter leaves the critical path; the fs
  is composed from existing pieces (arena + libkrun + nono + overlay).
- **Industry-aligned isolation, differentiated provenance** — boundary isolation
  like everyone, plus a content-addressed signed rootfs like no one.
- **The escalation is a named decision, not a default** — per-op FUSE returns the
  moment the threat model names a host-side-per-read requirement.

## The escalation trigger (for the threat model)

Build the per-op FUSE adapter when the model requires proving an *individual read
occurred, host-side* — e.g. a regulated audit of which specific skill an agent
loaded, where "it was in the signed rootfs" is insufficient and "it was read" is
required. Absent that, content-addressed scope + integrity is the provenance.

## Alternatives considered

- **Keep per-op FUSE as the substrate (ADR-0044 as-was).** Rejected as the
  *default*: hardest path, whole market routes around it, content-addressing gives
  the provenance more cheaply. Kept as the **escalation**.
- **gVisor instead of libkrun** (Modal's model — user-space kernel, syscall
  intercept). A genuine per-syscall mediation point *without* a FUSE, worth noting
  — but it changes the isolation substrate (ADR-0044) and is Linux-centric; flagged
  for the compute-substrate-portability thread (ADR-0009), not decided here.

## Sources

- Cloudflare Sandbox: <https://developers.cloudflare.com/sandbox/> · security model
  <https://developers.cloudflare.com/sandbox/concepts/security/> · GA
  <https://blog.cloudflare.com/sandbox-ga/>
- Vercel Sandbox: <https://vercel.com/docs/sandbox> · concepts
  <https://vercel.com/docs/sandbox/concepts>
- E2B: persistence <https://e2b.dev/docs/sandbox/persistence> · Firecracker infra
  <https://deepwiki.com/e2b-dev/infra/3.2-firecracker-integration>
- Modal: sandboxes <https://modal.com/docs/guide/sandboxes> · volumes
  <https://modal.com/docs/guide/volumes> · files
  <https://modal.com/docs/guide/sandbox-files>
- Daytona: sandboxes <https://www.daytona.io/docs/en/sandboxes/>
