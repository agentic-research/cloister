# NFS Mediator De-Risk + Decision Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the two unknowns that block the ADR-0046 syscall-adapter mediator, so the mediator itself (Plan 3) can be written as an exact-code TDD plan: (a) prove the **virtio-fs → host-NFS-mount** stack forwards *every* guest op faithfully with caching off; (b) decide the **userspace NFS server** implementation.

**Architecture:** Extend the `tools/libkrun-spike` probe so the host directory libkrun passes through is itself an **NFS mount** (not a plain dir). Trace whether guest ops reach the NFS layer, with DAX off and NFS attribute-caching disabled. Then evaluate userspace NFS-server options against the mediator's needs and record a decision.

**Tech Stack:** libkrun (HVF), macOS `nfsd` + `/etc/exports` (stack-proof only — kernel server), `fs_usage` (syscall tracing), the existing `tools/libkrun-spike` harness.

## Global Constraints

- **NFS-first, macOS priority.** Decided 2026-07-14: the mediator transport is NFS (kext-free on macOS), not FUSE. FUSE-over-io_uring is a *later* Linux-host adapter under the same policy core (ADR-0046).
- **DAX off on mediated paths.** All virtio-fs mounts in this plan use `krun_add_virtiofs3(..., shm_size = 0, ...)` so libkrun does not satisfy reads/attrs from a shared DAX window (ADR-0046 mmap/DAX constraint).
- **NFS caching disabled for the proof.** Mount with `actimeo=0` (or `noac`) so the client does not hide ops from the server.
- **Local-only.** Like `tools/libkrun-spike`, this cannot run in CI (no HVF/KVM). `task` targets only; SKIP when prereqs absent.
- **Kernel `nfsd` is for the STACK PROOF ONLY.** The mediator needs a *userspace* NFS server (its per-op hook is where policy runs); macOS `nfsd` is kernel and cannot mediate. Task 3 decides the userspace server.
- **Commit convention:** `[cloister-b28416] <type>(<scope>): <subject>` (`spike` is NOT a valid type — use `chore`/`feat`/`docs`). Trailer `bead: cloister` acceptable.

---

### Task 1: Prove the virtio-fs → host-NFS-mount stack forwards guest ops

**Files:**
- Create: `tools/libkrun-spike/probe-nfs.c` (a probe variant: DAX off via `krun_add_virtiofs3`)
- Create: `tools/libkrun-spike/run-nfs-stack.sh`

**Interfaces:**
- Consumes: the libkrun toolchain + `build.sh` conventions from Plan 1.
- Produces: a PASS/FAIL proof that a guest write through virtio-fs, whose host path is an NFS mount, **lands at the NFS export's backing directory**.

- [ ] **Step 1: Write `probe-nfs.c`** — identical to `probe.c` but DAX-off, so the host path (an NFS mount) is not shadowed by a DAX window

```c
// cloister-b28416 — probe variant with DAX OFF (shm_size=0), so the exposed
// host path (an NFS mount) is hit per-op, not served from a shared window.
#include <stdio.h>
#include <stdlib.h>
#include "libkrun.h"
#define CHECK(c) do { int32_t _r=(c); if(_r<0){fprintf(stderr,"[host] %s: %d\n",#c,_r);return 1;} } while(0)
int main(void){
    const char *rootfs=getenv("SPIKE_ROOTFS"), *ws=getenv("SPIKE_WORKSPACE");
    if(!rootfs||!ws){fprintf(stderr,"set SPIKE_ROOTFS + SPIKE_WORKSPACE\n");return 2;}
    int32_t ctx=krun_create_ctx(); if(ctx<0){fprintf(stderr,"ctx %d\n",ctx);return 1;}
    CHECK(krun_set_vm_config(ctx,1,512));
    CHECK(krun_set_root(ctx,rootfs));
    // DAX off: shm_size=0, read_only=false.
    CHECK(krun_add_virtiofs3(ctx,"workspace",ws,0,false));
    CHECK(krun_set_workdir(ctx,"/"));
    const char *script=
        "echo GUEST_UP; mkdir -p /mnt; "
        "mount -t virtiofs workspace /mnt && echo MOUNT_OK || echo MOUNT_FAIL; "
        "cat /mnt/host-wrote-this.txt; "
        "echo guest-wrote-this-ok > /mnt/guest-wrote-this.txt && echo WRITE_OK; "
        "echo GUEST_DONE";
    const char *const av[]={"busybox","sh","-c",script,NULL};
    const char *const ev[]={"PATH=/bin:/sbin:/usr/bin:/usr/sbin",NULL};
    CHECK(krun_set_exec(ctx,"/bin/busybox",av,ev));
    fprintf(stderr,"[host] start_enter...\n"); fflush(NULL);
    return krun_start_enter(ctx)<0?1:0;
}
```

- [ ] **Step 2: Write `run-nfs-stack.sh`** — export a dir via macOS `nfsd`, mount it, point the probe's workspace at the MOUNT, assert the guest write lands at the export SOURCE

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
INC=$(ls -d /opt/homebrew/Cellar/libkrun/*/include 2>/dev/null | head -1)
if [ -z "${INC:-}" ] || ! command -v cc >/dev/null; then echo "SKIP: no libkrun/cc"; exit 0; fi
if ! command -v nfsd >/dev/null; then echo "SKIP: nfsd not available"; exit 0; fi

cc probe-nfs.c -I"$INC" -L/opt/homebrew/lib -lkrun -Wl,-rpath,/opt/homebrew/lib -o probe-nfs
codesign --entitlements hv.entitlements -s - --force probe-nfs
[ -x ./rootfs/bin/busybox ] || { echo "SKIP: run ./run-spike.sh once to fetch rootfs"; exit 0; }

SRC="$PWD/nfs-src"; MNT="$PWD/nfs-mnt"
mkdir -p "$SRC" "$MNT"
echo "hello-from-nfs" > "$SRC/host-wrote-this.txt"; rm -f "$SRC/guest-wrote-this.txt"

# Export SRC over NFS (loopback) and mount it at MNT with caching OFF.
# NOTE: requires sudo for exports + nfsd; the harness prints the commands and
# SKIPs if it cannot elevate non-interactively.
if ! sudo -n true 2>/dev/null; then
  echo "SKIP: needs sudo for nfsd/exports; run manually:"
  echo "  echo \"$SRC -mapall=$(id -u):$(id -g) localhost\" | sudo tee /etc/exports"
  echo "  sudo nfsd restart; sudo mount -t nfs -o actimeo=0,resvport localhost:$SRC $MNT"
  exit 0
fi
echo "$SRC -mapall=$(id -u):$(id -g) localhost" | sudo tee /etc/exports >/dev/null
sudo nfsd restart; sleep 2
sudo mount -t nfs -o actimeo=0,resvport "localhost:$SRC" "$MNT" || { echo "FAIL: nfs mount"; exit 1; }
trap 'sudo umount "$MNT" 2>/dev/null || true' EXIT

export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
OUT=$(SPIKE_ROOTFS="$PWD/rootfs" SPIKE_WORKSPACE="$MNT" ./probe-nfs 2>&1 || true); echo "$OUT"
echo "$OUT" | grep -q hello-from-nfs || { echo "FAIL: guest could not READ through the NFS mount"; exit 1; }
grep -q guest-wrote-this-ok "$SRC/guest-wrote-this.txt" 2>/dev/null \
  || { echo "FAIL: guest write did not reach the NFS export SOURCE"; exit 1; }
echo "PASS: virtio-fs → host NFS mount forwards guest reads+writes to the export source"
```

- [ ] **Step 3: Run it**

Run: `chmod +x tools/libkrun-spike/run-nfs-stack.sh && tools/libkrun-spike/run-nfs-stack.sh`
Expected: `PASS: virtio-fs → host NFS mount forwards...`, OR a clear `SKIP` (no libkrun / no sudo / rootfs not fetched).

- [ ] **Step 4: Commit**

```bash
git add tools/libkrun-spike/probe-nfs.c tools/libkrun-spike/run-nfs-stack.sh
git commit -m "[cloister-b28416] chore(libkrun-spike): prove virtio-fs over host-NFS-mount forwards ops (DAX off)"
```

---

### Task 2: Caching-fidelity — prove EVERY op reaches the server, not just the first

**Files:**
- Create: `tools/libkrun-spike/trace-fidelity.sh`

**Interfaces:**
- Consumes: `probe-nfs` + the NFS export from Task 1.
- Produces: evidence (an `fs_usage` trace on the export source) that repeated guest reads/stats each produce a host-side op — i.e. caching does not hide ops from the mediator.

- [ ] **Step 1: Write `trace-fidelity.sh`** — guest reads the same file 3× + stats it; `fs_usage` watches the export source PID/path

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -x ./probe-nfs ] || { echo "SKIP: run ./run-nfs-stack.sh first"; exit 0; }
SRC="$PWD/nfs-src"; MNT="$PWD/nfs-mnt"
[ -d "$MNT" ] || { echo "SKIP: NFS mount from Task 1 not present"; exit 0; }
echo "trace-fidelity: with actimeo=0, a guest that reads /mnt/host-wrote-this.txt"
echo "3x should produce 3 host-side read/getattr ops against $SRC."
echo "Run in another terminal while a repeat-read guest runs:"
echo "  sudo fs_usage -w -f filesys | grep -F '$SRC'"
echo "Manual gate: count >= 3 reads/getattrs on host-wrote-this.txt during the run."
echo "(Automating the fs_usage assertion is a follow-up; this documents the check.)"
```

- [ ] **Step 2: Run + record the observation**

Run: `tools/libkrun-spike/trace-fidelity.sh` then follow its printed `fs_usage` instruction during a repeat-read guest run.
Expected: the repeated guest reads each surface a host op on `nfs-src/host-wrote-this.txt` (caching off works). Record the result in the decision note (Task 3).

- [ ] **Step 3: Commit**

```bash
git add tools/libkrun-spike/trace-fidelity.sh
git commit -m "[cloister-b28416] chore(libkrun-spike): caching-fidelity trace harness (actimeo=0)"
```

---

### Task 3: Decide the userspace NFS server for the mediator

**Files:**
- Create: `docs/superpowers/notes/2026-07-14-nfs-server-decision.md`

**Interfaces:**
- Consumes: the Task 1–2 results (does the stack forward? does caching-off work?).
- Produces: a committed decision naming the userspace NFS-server implementation the mediator (Plan 3) will build on, with the rationale and the rejected options.

- [ ] **Step 1: Evaluate the options against the mediator's needs** and write the decision note

The mediator needs a **userspace** NFS server whose per-request path is where policy runs (authorize open/read/write, serve CAS lower + validate-on-write upper, emit `SkillLoadReceipt`). Evaluate at least:

```markdown
# NFS server for the ADR-0046 syscall-adapter mediator — decision (2026-07-14)

## Requirement
Userspace NFS(v3/v4) server; every op passes a hook where cloister policy runs
(macOS kernel `nfsd` is out — no userspace hook). macOS + Linux. Prefer the
language that matches the fs stack (mache is Go + NFS; fuse-backend-rs is Rust).

## Options
| Option | Lang | Per-op policy hook | macOS+Linux | Maturity | Notes |
|---|---|---|---|---|---|
| Reuse mache's NFS server | Go | <fill from mache source> | yes (mache ships it) | shipped | precedent ADR-0044 cites |
| `nfsserve` crate | Rust | trait per RPC | <verify> | <verify> | matches fuse-backend-rs future |
| Other (<name>) | | | | | |

## Task 1–2 result
- Stack forwards: <PASS/FAIL>
- Caching-off fidelity: <observed op count>

## Decision
<chosen server> because <rationale>. Rejected <others> because <reason>.

## What Plan 3 builds on this
The policy fs (CAS lower + validate-on-write upper) implemented as this server's
request handler, gated by the same `VerifiedLease` the vault uses.
```

Fill every `<...>` from the actual mache source (`~/remotes/art/mache`, the `cmd/mount_nfs.go` / serve path) and from verifying the `nfsserve` crate. **No placeholders in the committed note.**

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/notes/2026-07-14-nfs-server-decision.md
git commit -m "[cloister-b28416] docs(notes): userspace NFS-server decision for the mediator"
```

---

## Unblocks: Plan 3 — the mediator proper (write after this plan lands)

With Task 1–2 proving the stack and Task 3 naming the server, Plan 3 is writable
as exact-code TDD:

- **policy fs** — the chosen NFS server's request handler: allowlist + validate-
  on-write (tree-sitter per ADR-0043) on the upper; serve the lower from
  `leyline-cas` by digest.
- **`SkillLoadReceipt`** — emitted on each CAS-object read (the ADR-0043 load event).
- **lease gate** — the guest's identity → `VerifiedLease` → scope; reuse
  `src/routes/lease-middleware.ts` **in place** (extract to a shared module only
  once this second adapter proves the shape, per ADR-0046).
- **wire-up** — `harness-dev.mjs` mounts the mediator's export and points
  `krun_add_virtiofs3(..., shm_size=0)` at it.

Plan 3 is NOT writable before this plan because its exact code depends on the
chosen server's API (Task 3) and on the stack forwarding faithfully (Task 1–2).
