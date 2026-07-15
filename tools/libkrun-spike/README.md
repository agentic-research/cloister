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

## What it does NOT do

It is a **proof**, not the mediator. It exposes a plain passthrough dir, not a
policy/CAS fs. The mediator (authorize-every-op + `SkillLoadReceipt`, ADR-0043)
is the follow-on build, gated on the **NFS-vs-FUSE** transport decision
(ADR-0046 open questions).
