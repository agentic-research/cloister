# ADR-0044 — Compute-isolation substrate: libkrun-embedded microVM with a host-mediated policy filesystem

- **Status:** Proposed (2026-07-08)
- **Tracking bead:** `cloister-b244d1` (compute-substrate decision) · decade `harness-substrate`
- **Pairs with:**
  - ADR-0009 (compute substrate portability — this *realizes* it, macOS/Apple-Silicon first)
  - ADR-0043 (delivery plane — the *read* side of this filesystem: serving skills/tools + load receipts)
  - ADR-0035 (cloister↔LLO boundary — the FUSE mediator is `fuse-backend-rs`, LLO-adjacent Rust; mache is already a FUSE fs)
  - ADR-0039 (macOS-first precedent for at-rest security)

## Context

The `harness-substrate` endgame (ADR-0043) needs a **kernel-isolated unit whose
*only* filesystem is served by a host-side mediator** — so every read/write is
authorized (validate-on-write, deny out-of-scope, log opens), and host paths
(`~/.ssh`) are simply not in the guest's view. Targets: **macOS and Linux,
Apple Silicon first.** The substrate choice gates the whole decade: the
mediated workspace fs (`cloister-b2d2b1`) can only be "the only fs" if the
isolation boundary makes it so.

A survey (2025–2026, doc-cited in the bead) resolves the field sharply:

| Option | Per-op host-mediated fs? | macOS (Apple Silicon)? | Notes |
|---|---|---|---|
| **libkrun** | **✅ yes** — embeds an in-process virtio-fs **FUSE server** (`fuse-backend-rs`) you specialize | **✅ HVF** *and* Linux KVM | one VMM + mediator, two hypervisor backends |
| Apple Virtualization.framework | ❌ — shares a **real directory**, no per-op hook | ✅ | buys path-*invisibility*, NOT write-authorization |
| Firecracker | ❌ — **no virtio-fs** (block device only) | ❌ Linux/KVM only | mediation would be vsock/block, not a FUSE chokepoint |
| gVisor | n/a (syscall intercept) | ❌ cloud/Linux | different shape; overhead |
| Lima/colima/OrbStack | ❌ — VZ virtio-fs shared-dir | ✅ | full Linux VM; no policy hook |

The differentiator: **nobody in the prior art (E2B/Fly=Firecracker, Modal=gVisor,
Cloudflare=containers) does host-side per-operation FUSE mediation of the guest
fs** — and none offer it *locally on macOS*. That is exactly the position this
substrate takes.

## Decision

**Adopt libkrun as the compute-isolation substrate**, with the guest's only
filesystem served by libkrun's in-process **virtio-fs FUSE server**, specialized
into a **policy passthrough** (the `mediated-workspace-fs`, `cloister-b2d2b1`).
Concretely:

- **One mediator, two backends.** libkrun links Hypervisor.framework on
  Apple-Silicon macOS and KVM on Linux behind one C API. We write the VMM
  embedding + the FUSE policy server **once** and get both targets — directly
  serving "macOS + Linux, Apple Silicon first" without a fork per OS.
- **The FUSE server is the chokepoint.** Built on `fuse-backend-rs` (the Cloud
  Hypervisor Rust library libkrun already uses; the same FUSE-server pattern
  mache/LLO already ship). Its `passthrough` fs is specialized: allowlist paths,
  **validate-on-write** (tree-sitter for source, per ADR-0043), **deny + log**
  out-of-scope, and never expose `~/.ssh`/`~/.aws`. Every guest read/write is a
  host-authorized op — the read side *is* skill/tool delivery + `SkillLoadReceipt`
  (ADR-0043); the write side *is* the workspace validation.
- **`krunvm`/`krunkit` are the reference embedding** — boot in milliseconds from
  OCI images (the rootfs is the OCI image over virtio-fs), which composes with
  ADR-0041's image-publish contract.
- **Defense-in-depth inside the guest:** Linux **Landlock** (`rust-landlock`
  crate; the canonical one, not a bespoke wrapper) path-scopes the agent as a
  coarse second ring behind the mediator + VM boundary.
- **State/rollback** (`cloister-b34db4`): the FUSE mediator is the natural
  snapshot boundary — overlay-back the exported tree (lower = clean, upper =
  agent mutations; rollback = discard upper), paired with jj/git for
  human-facing semantic diffs.

## Consequences

- **Single implementation across macOS + Linux.** The dual HVF/KVM backend is the
  load-bearing reason to pick libkrun over VZ (macOS-only, no policy hook) or
  Firecracker (Linux-only, no virtio-fs).
- The `mediated-workspace-fs` thread becomes concrete: a `fuse-backend-rs` policy
  passthrough — the *same shape mache/LLO already prove* — not a new fs.
- The substrate is a **differentiated position**: host-side per-op FUSE mediation,
  local-first, which no shipping agent sandbox does.
- New trust seams: the VMM embedding, the policy FUSE server, the OCI rootfs
  supply chain (reuse ADR-0041 signing). Threat model gains a section before code.
- **Honest uncertainties (verify against `libkrun` main before implementing):**
  (1) libkrun's `passthrough_fs` policy is today a **code-level extension**, not a
  config knob — we fork/specialize `fuse-backend-rs`, not configure it. (2) VZ
  boot times are Apple-undocumented; libkrun/krunvm claim ms-class — measure in
  the `cloister-b28416` spike. (3) macOS has no host `AF_VSOCK`; control-plane
  RPC uses a host unix socket (vfkit/libkrun pattern).

## Alternatives considered

- **Apple Virtualization.framework + a curated `VZSingleDirectoryShare`.** Far
  simpler, and enough if we only wanted *coarse path-scoping* (don't share
  `~/.ssh`). Rejected as the substrate because it cannot authorize individual
  reads/writes — no validate-on-write, no per-op deny/log. Kept as a documented
  **fallback "coarse mode"** for environments where libkrun can't run.
- **Firecracker.** Battle-tested (E2B, Fly, Lambda) and sub-125ms, but **Linux/KVM
  only** (not Apple Silicon) and **no virtio-fs** — the guest fs is a block image,
  so mediation would move off the FUSE chokepoint into a vsock protocol or
  block-image control. Wrong shape for a mediated fs; wrong platform for
  Apple-Silicon-first.
- **gVisor.** User-space kernel with syscall interception (Modal). Cloud/Linux,
  meaningful overhead, and not the host-mediated-fs shape. Rejected.
- **Full Linux VM (Lima/colima/OrbStack).** VZ virtio-fs shared-directory — same
  no-policy-hook limit as VZ, plus a heavier guest. Rejected as the substrate.
