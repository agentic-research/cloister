# libkrun Spike Formalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the throwaway libkrun boot + op-forwarding spike (currently in the session scratchpad) into a committed, reproducible, self-checking artifact under `tools/libkrun-spike/` that proves the ADR-0044 / ADR-0046 "mediate-below-stock-libkrun" thesis on demand.

**Architecture:** A minimal C program links the installed `libkrun` (Homebrew `slp/krun` tap), boots an Alpine microVM on HVF, mounts a host directory over virtio-fs, and does a guest read + write; a shell harness fetches the rootfs, runs it, and asserts the guest write appeared on the host path. It is a **proof/spike artifact**, not a production component — the seed of the S3 VMM embedding.

**Tech Stack:** C (clang), libkrun 1.19.4 + libkrunfw 5.5.0 (via `brew tap slp/krun`), macOS `codesign` with `com.apple.security.hypervisor`, Alpine aarch64 minirootfs, Taskfile.

## Global Constraints

- **Platform:** macOS Apple Silicon (HVF) is the reference target. The harness MUST **skip gracefully** (exit 0 with a SKIP message) when `libkrun`, `cc`, or `codesign` are absent — same posture as `tools/harness-sandbox`'s `test/nono-isolation.test.mjs`.
- **NOT a CI gate.** GitHub Actions runners lack nested virt (HVF/KVM), so the boot test cannot run in CI. It is a **local, opt-in** `task` target only. Do not wire it into `task lint` / `task verify`.
- **No network in the guest.** The probe adds no net device; only a rootfs + one virtio-fs workspace dir.
- **Commit convention:** every commit prefixed `[cloister-b28416]` (the spike bead). Trailer `bead: cloister` acceptable if the hook needs it.
- **libkrun paths:** headers at `/opt/homebrew/Cellar/libkrun/1.19.4/include`, dylib via `/opt/homebrew/lib`. Reference the versioned Cellar include path but link `-L/opt/homebrew/lib -lkrun -Wl,-rpath,/opt/homebrew/lib`.

---

### Task 1: The probe binary + build script

**Files:**
- Create: `tools/libkrun-spike/probe.c`
- Create: `tools/libkrun-spike/hv.entitlements`
- Create: `tools/libkrun-spike/build.sh`
- Create: `tools/libkrun-spike/.gitignore` (ignore build output + fetched rootfs)

**Interfaces:**
- Produces: a signed executable `tools/libkrun-spike/probe` that reads env `SPIKE_ROOTFS` (rootfs dir) and `SPIKE_WORKSPACE` (host dir exposed to the guest), boots the VM, runs a guest script, and returns 0 on a clean guest exit.

- [ ] **Step 1: Write `probe.c`** (the proven spike, verbatim from the working run)

```c
// cloister-b28416 spike — minimal libkrun VMM embed.
// Boots a microVM, mounts a host dir over virtio-fs, does a guest read+write.
// If the guest write appears on the host path, per-op mediation can live in a
// host-side fs BELOW stock libkrun (ADR-0046 syscall adapter thesis).
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "libkrun.h"

#define CHECK(call) do { int32_t _r = (call); if (_r < 0) { \
    fprintf(stderr, "[host] %s failed: %d\n", #call, _r); return 1; } } while (0)

int main(void) {
    const char *rootfs = getenv("SPIKE_ROOTFS");
    const char *workspace = getenv("SPIKE_WORKSPACE");
    if (!rootfs || !workspace) { fprintf(stderr, "set SPIKE_ROOTFS and SPIKE_WORKSPACE\n"); return 2; }

    int32_t ctx = krun_create_ctx();
    if (ctx < 0) { fprintf(stderr, "[host] krun_create_ctx: %d\n", ctx); return 1; }

    CHECK(krun_set_vm_config(ctx, 1, 512));
    CHECK(krun_set_root(ctx, rootfs));
    CHECK(krun_add_virtiofs(ctx, "workspace", workspace));
    CHECK(krun_set_workdir(ctx, "/"));

    const char *script =
        "echo GUEST_UP; mkdir -p /mnt; "
        "mount -t virtiofs workspace /mnt && echo MOUNT_OK || echo MOUNT_FAIL; "
        "echo READ-HOST-TO-GUEST:; cat /mnt/host-wrote-this.txt; "
        "echo guest-wrote-this-ok > /mnt/guest-wrote-this.txt && echo WRITE_OK || echo WRITE_FAIL; "
        "echo GUEST_DONE";
    const char *const gargv[] = {"busybox", "sh", "-c", script, NULL};
    const char *const genvp[] = {"PATH=/bin:/sbin:/usr/bin:/usr/sbin", NULL};
    CHECK(krun_set_exec(ctx, "/bin/busybox", gargv, genvp));

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    fprintf(stderr, "[host] krun_start_enter...\n"); fflush(NULL);
    int32_t r = krun_start_enter(ctx);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    fprintf(stderr, "[host] krun_start_enter returned %d (elapsed %.1f ms)\n", r, ms);
    return r < 0 ? 1 : 0;
}
```

- [ ] **Step 2: Write `hv.entitlements`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.hypervisor</key><true/>
</dict></plist>
```

- [ ] **Step 3: Write `build.sh`** (fails fast + clearly if libkrun/toolchain missing)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
INC=$(ls -d /opt/homebrew/Cellar/libkrun/*/include 2>/dev/null | head -1)
if [ -z "${INC:-}" ] || ! command -v cc >/dev/null; then
  echo "SKIP: libkrun headers or cc not found (brew tap slp/krun && brew install krunvm)" >&2
  exit 0
fi
cc probe.c -I"$INC" -L/opt/homebrew/lib -lkrun -Wl,-rpath,/opt/homebrew/lib -o probe
codesign --entitlements hv.entitlements -s - --force probe
echo "built + signed: $(pwd)/probe"
```

- [ ] **Step 4: Write `.gitignore`**

```
/probe
/rootfs/
/workspace/
/mini.tar.gz
```

- [ ] **Step 5: Verify it builds + signs**

Run: `chmod +x tools/libkrun-spike/build.sh && tools/libkrun-spike/build.sh`
Expected (on a Mac with libkrun): `built + signed: .../tools/libkrun-spike/probe`, and `codesign -d --entitlements - tools/libkrun-spike/probe` prints `com.apple.security.hypervisor`.
Expected (no libkrun): `SKIP: libkrun headers or cc not found`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add tools/libkrun-spike/probe.c tools/libkrun-spike/hv.entitlements tools/libkrun-spike/build.sh tools/libkrun-spike/.gitignore
git commit -m "[cloister-b28416] spike(libkrun): formalize VMM-embed probe + build"
```

---

### Task 2: The self-checking run harness

**Files:**
- Create: `tools/libkrun-spike/run-spike.sh`

**Interfaces:**
- Consumes: `tools/libkrun-spike/probe` (from Task 1) via `build.sh`.
- Produces: a runnable proof — fetches the rootfs, seeds the workspace, boots, and asserts the guest write forwarded to the host. Exit 0 = PASS or SKIP; exit 1 = the proof failed.

- [ ] **Step 1: Write the assertion harness `run-spike.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/alpine-minirootfs-3.24.0-aarch64.tar.gz"

./build.sh
if [ ! -x ./probe ]; then echo "SKIP: probe not built (no libkrun)"; exit 0; fi

# Fetch + extract the rootfs once (buildah-free).
if [ ! -x ./rootfs/bin/busybox ]; then
  mkdir -p rootfs
  curl -sSL --max-time 90 -o mini.tar.gz "$ALPINE_URL"
  tar -xzf mini.tar.gz -C rootfs
fi

# Seed the workspace with a host-written file the guest must read.
mkdir -p workspace
echo "hello-from-host" > workspace/host-wrote-this.txt
rm -f workspace/guest-wrote-this.txt

export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
OUT=$(SPIKE_ROOTFS="$PWD/rootfs" SPIKE_WORKSPACE="$PWD/workspace" ./probe 2>&1 || true)
echo "$OUT"

# Assert: booted, mounted, and the guest's write reached the HOST path.
echo "$OUT" | grep -q GUEST_UP  || { echo "FAIL: guest did not boot"; exit 1; }
echo "$OUT" | grep -q MOUNT_OK  || { echo "FAIL: virtio-fs did not mount"; exit 1; }
echo "$OUT" | grep -q hello-from-host || { echo "FAIL: guest could not READ host file"; exit 1; }
grep -q guest-wrote-this-ok workspace/guest-wrote-this.txt 2>/dev/null \
  || { echo "FAIL: guest WRITE did not forward to the host path"; exit 1; }
echo "PASS: boot + read-forward + write-forward proven (mediate-below-libkrun holds)"
```

- [ ] **Step 2: Run it to see it PASS (Mac w/ libkrun) or SKIP (elsewhere)**

Run: `chmod +x tools/libkrun-spike/run-spike.sh && tools/libkrun-spike/run-spike.sh`
Expected (Mac w/ libkrun): ends with `PASS: boot + read-forward + write-forward proven ...`
Expected (no libkrun): `SKIP: probe not built (no libkrun)`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add tools/libkrun-spike/run-spike.sh
git commit -m "[cloister-b28416] spike(libkrun): self-checking boot + op-forwarding harness"
```

---

### Task 3: Taskfile target + README (discoverable, documented, explicitly not-CI)

**Files:**
- Modify: `Taskfile.yml` (add a `spike:libkrun` task)
- Create: `tools/libkrun-spike/README.md`

**Interfaces:**
- Consumes: `run-spike.sh` (Task 2).
- Produces: `task spike:libkrun` and operator docs.

- [ ] **Step 1: Add the Taskfile target** (place near other `tools/` build tasks, e.g. after `harness:sandbox:build`)

```yaml
  spike:libkrun:
    desc: "cloister-b28416 — libkrun VMM-embed proof (ADR-0044/0046). Boots an Alpine microVM on HVF, proves guest fs reads+writes forward to a host dir (mediate-below-stock-libkrun). macOS+libkrun only; SKIPs elsewhere. NOT a CI gate (runners lack HVF/KVM). Prereq: brew tap slp/krun && brew install krunvm."
    cmds:
      - bash tools/libkrun-spike/run-spike.sh
```

- [ ] **Step 2: Verify the target runs**

Run: `task spike:libkrun`
Expected: same PASS/SKIP as Task 2 Step 2.

- [ ] **Step 3: Write `README.md`**

````markdown
# tools/libkrun-spike — the S3 VMM-embed proof (cloister-b28416)

Minimal `libkrun` embed that proves the ADR-0046 **syscall adapter** thesis:
a guest's filesystem ops **forward to a host directory** through *stock*
libkrun, so per-op mediation can live in a host-side fs **below** libkrun —
no libkrun fork (see ADR-0044, ADR-0046).

## Run
```sh
brew tap slp/krun && brew install krunvm   # once (installs libkrun + libkrunfw)
task spike:libkrun
```
`PASS` = booted on HVF, mounted a virtio-fs host dir, and the guest's write
appeared on the host path. macOS+libkrun only; `SKIP`s otherwise.

## Why it is not in CI
GitHub Actions runners have no nested virtualization (HVF/KVM), so the boot
cannot run there. This is a **local, opt-in** proof — the same posture as
`tools/harness-sandbox`'s nono-isolation test.

## What it does NOT do
It is a **proof**, not the mediator. It exposes a plain passthrough dir, not a
policy/CAS fs. The mediator (authorize-every-op + `SkillLoadReceipt`) is the
follow-on build, gated on the NFS-vs-FUSE transport decision (ADR-0046 open q).
````

- [ ] **Step 4: Commit**

```bash
git add Taskfile.yml tools/libkrun-spike/README.md
git commit -m "[cloister-b28416] spike(libkrun): task spike:libkrun + README (local-only, documented)"
```

---

## Gated follow-on plans (NOT in this plan — they need a decision first)

These are **separate plans**, each producing working software on its own, and
each blocked on an ADR-0046 open question. Do not start them from this plan.

- **Plan 2 — Mediator skeleton (the real syscall adapter).** Blocked on the
  **NFS vs FUSE transport decision** (ADR-0046 §Constraints + §Open questions):
  - **NFS** (mache-shape): kext-free on macOS, no `io_uring`/FUSE-over-io_uring,
    client attr-caching to tune (`actimeo=0`).
  - **FUSE** (`fuse-backend-rs`): FUSE-over-io_uring on Linux, but **macFUSE kext**
    on macOS (Apple-Silicon friction).
  Once decided: a host-side server that authorizes `open`/`read`/`write` against
  a confinement/v1 policy, serves the read side from `leyline-cas` by digest,
  emits `SkillLoadReceipt`, and is gated by the **same `VerifiedLease`** the vault
  uses (reuse `src/routes/lease-middleware.ts` in place — extract to a shared
  module only once this second adapter proves the shape, per ADR-0046).

- **Plan 3 — Caching-fidelity proof.** Blocked on Plan 2. Extend the probe:
  `shm_size = 0` (DAX off), repeated guest reads/stats, and an `fs_usage` trace
  of the host path to confirm **every** op reaches the mediator (not just
  create/first-read). Answers the ADR-0046 mmap/DAX constraint empirically.
