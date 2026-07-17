# tools/libkrun-spike — the S3 VMM-embed proof (cloister-b28416)

Minimal `libkrun` embed that proves the ADR-0046 **syscall adapter** thesis:
a guest's filesystem ops **forward to a host directory** through *stock*
libkrun, so per-op mediation can live in a host-side fs **below** libkrun —
no libkrun fork. See
[ADR-0044](../../docs/adr/0044-compute-isolation-substrate.md) +
[ADR-0046](../../docs/adr/0046-mediated-capability-core.md).

## Run

```sh
brew tap slp/krun && brew install krunvm   # once (installs libkrun + libkrunfw)
task spike:libkrun
```

`PASS` = booted on HVF, mounted a virtio-fs host dir, the guest **read** a
host-seeded file, and the guest's **write appeared on the host path**.
macOS + libkrun only; `SKIP`s (exit 0) otherwise.

## Why it is not in CI

GitHub Actions runners have no nested virtualization (HVF/KVM), so the boot
cannot run there. This is a **local, opt-in** proof — the same posture as
`tools/harness-sandbox`'s nono-isolation test.

## Files

- `probe.c` — the libkrun embed (`krun_create_ctx` → `set_vm_config` →
  `set_root` → `add_virtiofs` → `set_exec` → `start_enter`).
- `hv.entitlements` — the `com.apple.security.hypervisor` entitlement HVF
  requires; `build.sh` codesigns the binary with it.
- `build.sh` — compile + sign (SKIPs if libkrun/cc absent).
- `run-spike.sh` — fetch rootfs, seed the workspace, boot, assert forwarding.

## The mediated run — `run-mediated.sh` (cloister-e87760, the keystone proof)

`run-spike.sh` exposes a plain passthrough dir. `run-mediated.sh` backs the
guest's virtio-fs with the **ConfinementGraph mediator's NFS** instead (the
NFS-vs-FUSE decision was made — NFS — and the mediator shipped in #139–141), and
proves the guest fs *traverses the mediator*:

```
guest → virtio-fs (DAX off) → host NFS mount (noac) → ConfinementGraph → leyline-fs
```

- **DAX off** — `probe.c` uses `krun_add_virtiofs` (no shm/DAX window), so the
  guest cannot mmap-bypass per-op mediation (ADR-0046 mmap/DAX constraint).
- **`noac`** — the host NFS client's attribute cache is disabled, so *every*
  guest read/stat reaches the mediator, not just create/first-read.

It asserts: an allowed skill (`/skills/demo.md`) is served + logged as a
`SkillLoadReceipt`; a policy-denied path (`/etc/*`) is blocked *in-guest*. The
full every-op fidelity trace (the cloister-e87760 acceptance) is an `fs_usage`
run the script prints instructions for. `task spike:libkrun:mediated`.

macOS + libkrun + sudo (for the NFS mount) only; SKIPs gracefully otherwise.

## What it does NOT do

The plain spike is a **boot proof**, not the mediator. `run-mediated.sh` closes
that gap for fs mediation; the remaining keystone work is the every-op `fs_usage`
fidelity trace (cloister-e87760) and joining the `SkillLoadReceipt` to the
Interlace disclosure chain (cloister-3fc1b6). The production S3 VMM embedding is
a further increment.
