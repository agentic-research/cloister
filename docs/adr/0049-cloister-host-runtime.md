---
title: "ADR-0049: The cloister host-runtime — one composed native runtime (nono + leyline-fs + libkrun), not N tools"
status: Proposed (2026-07-17)
date: 2026-07-17
tags: [host-runtime, compute-isolation, mediation, nono, leyline-fs, libkrun, tool-primitive, composition]
threat_model: docs/security/threat-model.md
relates_to:
  - 0009-compute-substrate-portability.md
  - 0013-slice-grant-enforcement.md
  - 0035-cloister-llo-boundary.md
  - 0040-harness-in-cloister.md
  - 0043-delivery-plane-skills-agents-tools.md
  - 0044-compute-isolation-substrate.md
  - 0046-mediated-capability-core.md
  - 0048-unified-tool-primitive.md
---

## Context

The host-side substrate that ADRs 0040/0043/0044/0046 describe currently exists
as **four separate binaries under `tools/`**, each script/spike-shaped:

- `tools/harness-sandbox` — kernel confinement (`nono::Sandbox::apply` in-process,
  Seatbelt/Landlock) + exec.
- `tools/mediator` — the fs policy plane: a `ConfinementGraph` decorator over
  leyline-fs's `Graph`, served as NFS (`serve_nfs`) / FUSE (`mount_fuse`).
- `tools/libkrun-spike` — the microVM boot proof (HVF/KVM, virtio-fs passthrough).
- `tools/harness-shim` — the ADR-0042 dev-run glue.

**These are fragments of one thing.** The observation that forced this ADR: each
fragment is a *wrapper around a library that is designed to be composed
in-process*, not a script. `harness-sandbox` already proves the shape — it
consumes `nono` as a **library** (`nono::Sandbox::apply(&CapabilitySet)`), not by
shelling out to `nono run`. leyline-fs is likewise a library (`Graph`,
`serve_nfs`, `mount_fuse`). libkrun is a C library embedded via FFI. So the
substrate is not "N tools in cloister" — it is **one native runtime that composes
three libraries**, and the `tools/` binaries are the spikes that proved each piece
works. Leaving them as separate `/tools` binaries means they hardcode their policy,
log to `Vec`s, and are hand-run — the spike shape, not the integrated one.

This is the concrete form of `cloister-69dea1` ("the harness as a *declared
host-runner*, not a hand-rolled script") and the **sandbox facet** of the tool
primitive (ADR-0048).

## Decision

**Adopt one first-class cloister native crate — `rs/crates/host-runtime` — that
composes the three libraries into a single host-side runtime**, and retire the
`tools/` fragments into it as modules. The runtime is Rust because its
constituents are native (libkrun FFI, leyline-fs, nono); workerd cannot contain
it (ADR-0040/0033). It is cloister's, not LLO's: it is the **policy + composition**
plane over LLO's **data** plane, per the ADR-0035 boundary (cloister depends on
`leyline-fs`; `leyline-*` primitives stay in LLO).

The runtime composes:

| Module | Library | Role |
|---|---|---|
| **isolation** | `nono` (0.54, in-process) | confine the *runtime process itself* + the guest (Seatbelt/macOS, Landlock/Linux) |
| **mediated fs** | `leyline-fs` `Graph` + cloister's `ConfinementGraph` | authorize-every-op + `SkillLoadReceipt` over the guest's fs |
| **compute** | `libkrun` (FFI) | the microVM (HVF + KVM, one C API) |

### The fs shape — reconciling ADR-0044 with this session's mediator

ADR-0044 decided "the guest's only filesystem is libkrun's **in-process virtio-fs
FUSE server** (`fuse-backend-rs`), specialized." This session instead built the
mediator as a `ConfinementGraph` over leyline-fs, served as a **separate NFS/FUSE
mount** (the `mediate-below-stock-libkrun` de-risk). Those are two shapes for the
same goal, and the mount shape is what introduced the `sudo mount -t nfs` friction
observed on 2026-07-16.

The runtime uses the **in-process** shape, but built from the leyline-fs `Graph`,
not from scratch: a **`fuse-backend-rs` adapter over `ConfinementGraph`** presents
the mediated graph *as libkrun's own virtio-fs*. This composes both:

- **From ADR-0044:** in-process virtio-fs — **no separate mount, no `sudo`, no
  host NFS client** (the mount hop and its root-traversal/`noac` problems vanish).
- **From this session:** the `ConfinementGraph` (leyline-fs `Graph` decorator,
  #139–141) is reused verbatim — no libkrun fork, no from-scratch passthrough.

The `tools/libkrun-spike` NFS run stays a **throwaway** that proved per-op
mediation is possible below stock libkrun; it is *not* the runtime's shape. (This
amends ADR-0044's decision: the specialization target is the leyline-fs `Graph`,
adapted to `fuse-backend-rs`, not a hand-written `fuse-backend-rs` passthrough.)

### nono is the shared policy contract across both planes

nono has both a Rust surface (the runtime *enforces* with it) and — per the
nono.sh project — a TS surface. That makes it **one contract, two planes**, not
two implementations:

- **TS control plane (workerd)** *declares* the confinement (the manifest
  `confinement` facet, `a34edc` / ADR-0013) in nono's policy vocabulary.
- **Rust host-runtime** *enforces* it: `nono::Sandbox::apply` for the process ring
  and the `ConfinementGraph` for the fs ring, both derived from the *same*
  declaration.

This is "**one declaration, both planes**" — the declaration cannot drift from the
enforcement because both read the same nono policy. (Verify nono's TS surface
before relying on it — see Open questions.)

### The four integration seams

The runtime is "integrated," not standalone, precisely by these four seams:

1. **Config'd policy ← manifest.** Policy is *loaded* from the confinement/v1 facet
   (`policy.rs::ConfinementFs → Policy` already exists), never hardcoded. The mount
   bin's baked-in demo policy is a placeholder to delete.
2. **Receipts → chain.** `SkillLoadReceipt` emits into cloister's attestation /
   disclosure chain (`cloister-3fc1b6`), not a local `Vec`.
3. **Lease-gate.** Every mediated op is gated by the same `VerifiedLease` the vault
   uses (`src/routes/lease-middleware.ts`), per ADR-0046.
4. **IPC ↔ control plane.** cloister's TS router drives the runtime over a **host
   unix socket** (ADR-0044's `AF_VSOCK`-absent-on-macOS finding), not by spawning
   a hand-run binary — the `69dea1` declared-host-runner contract.

### Credential mediation — own the agent's config hierarchy, don't inject keys

The runtime mediates the agent's credentials not by injecting per-tool env vars,
but by **owning the config *hierarchy* the agent's tools resolve against.** This
is the mechanism for seam #1's credential half, and it exploits that config
resolution is hierarchical + env-overridable:

- **Own the roots (hierarchical placement).** The runtime sets `HOME`,
  `XDG_CONFIG_HOME` + `XDG_CONFIG_DIRS`, and the tool-specific overrides that take
  precedence over them (`ANTHROPIC_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`) to paths
  *inside the mediated tree*. Any XDG-respecting tool (`ant`, the SDK, Claude Code)
  resolves config + credentials `ANTHROPIC_CONFIG_DIR → XDG_CONFIG_HOME/anthropic →
  ~/.config/anthropic`, env-over-file — so the runtime places its **authoritative
  base layer** at the top of that hierarchy (`XDG_CONFIG_HOME`) and can offer
  lower-precedence defaults via `XDG_CONFIG_DIRS`. The agent can't resolve *around*
  a hierarchy whose roots the runtime owns.
- **Deny the host's.** The confinement denies the real host credential paths —
  `~/.config/anthropic/credentials/`, `~/.claude/.credentials.json`, plus ADR-0044's
  `~/.ssh`/`~/.aws`. Even if a tool ignores the env redirect, the operator's tokens
  are unreadable in-guest.
- **What lands there is the runtime's choice.** A short-lived cred, or a config
  whose base-url is cloister's vault-proxy (ADR-0042 `ANTHROPIC_BASE_URL`). For the
  `ant auth login` **OAuth-subscription** case this is ADR-0016 D5's "**receipts,
  not custody**" path: redirect the config, proxy the calls through cloister, never
  copy the OAuth token into the guest.

So the credential story is "**own the agent's config root, deny the host's**" —
not "inject an `ANTHROPIC_API_KEY`."

## Consequences

- **The `tools/` fragments consolidate** into `rs/crates/host-runtime` modules
  (`isolation`, `fs`, `compute`, `ipc`). `tools/` keeps only genuine throwaway
  spikes (`libkrun-spike`). The lift-out concern is resolved by construction: it
  was never meant to live in `/tools`.
- **The tool primitive's sandbox facet becomes real** (ADR-0048): a tool's
  capability + sandbox are enforced by this runtime, config'd from its manifest
  definition.
- **`e87760`** (the keystone proof) retargets from "NFS mount + sudo" to "the
  in-process `fuse-backend-rs`-over-`Graph` adapter," which is both the real shape
  *and* runnable without sudo.
- **New/confirmed trust seams** (threat model): the `fuse-backend-rs` adapter, the
  VMM embedding, the IPC socket, the OCI rootfs supply chain (ADR-0041).
- **Nothing is re-implemented** — the runtime is *composition*: nono + leyline-fs +
  libkrun, already-proven libraries, wired into one process.

## Non-goals

- Not lifting the runtime (or the ConfinementGraph policy) **into LLO** — policy is
  cloister's per ADR-0035; leyline-fs stays the LLO dependency.
- Not a big-bang rewrite — the crate absorbs the `tools/` modules incrementally,
  each already tested.
- Not re-opening the compute-substrate choice (libkrun, ADR-0044) or the
  mediated-capability model (ADR-0046).

## Open questions (for the increments, not this ADR)

1. **Does leyline-fs expose (or should cloister write) a `fuse-backend-rs` adapter
   over `Graph`?** leyline-fs today has a `fuser`-based FUSE (`mount_fuse`) — a
   *different* FUSE library than libkrun's `fuse-backend-rs`. The adapter (Graph →
   `fuse-backend-rs::FileSystem`) is the load-bearing new code; scope whether it
   lives in cloister (bridge, ADR-0035) or is contributed to leyline-fs.
2. **nono's TS surface** — confirm it exists + its policy type is the one the
   manifest facet emits, before treating it as the shared contract.
3. **libkrun's in-process fs specialization** — ADR-0044 uncertainty (1): is
   `passthrough_fs` specialization a code-level extension or a config knob on
   current libkrun main? Measure before committing the adapter's mount path.
4. **The credential deny-list + per-tool precedence** — enumerate every host path
   holding a live credential (`~/.config/anthropic/`, `~/.claude/.credentials.json`,
   `~/.ssh`, `~/.aws`, cloud SDK caches) and confirm each relevant tool honors the
   env redirect (env-over-file). Falsifiable: with the runtime's env set, a guest
   read of the host cred path is denied AND the tool resolves the mediated config.
