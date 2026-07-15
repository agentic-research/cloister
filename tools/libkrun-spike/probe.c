// cloister-b28416 spike — minimal libkrun VMM embed.
// Boots a microVM, mounts a host dir over virtio-fs, does a guest read+write.
// If the guest write appears on the host path, per-op mediation can live in a
// host-side fs BELOW stock libkrun (ADR-0046 syscall-adapter thesis) — no
// libkrun fork. See docs/adr/0044-compute-isolation-substrate.md + 0046.
//
// Env: SPIKE_ROOTFS (extracted rootfs dir), SPIKE_WORKSPACE (host dir exposed).
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "libkrun.h"

#define CHECK(call) do { int32_t _r = (call); if (_r < 0) { \
    fprintf(stderr, "[host] %s failed: %d\n", #call, _r); return 1; } } while (0)

int main(void) {
    const char *rootfs = getenv("SPIKE_ROOTFS");
    const char *workspace = getenv("SPIKE_WORKSPACE");
    if (!rootfs || !workspace) {
        fprintf(stderr, "set SPIKE_ROOTFS and SPIKE_WORKSPACE\n");
        return 2;
    }

    int32_t ctx = krun_create_ctx();
    if (ctx < 0) { fprintf(stderr, "[host] krun_create_ctx: %d\n", ctx); return 1; }

    CHECK(krun_set_vm_config(ctx, 1, 512));                 // 1 vCPU, 512 MiB
    CHECK(krun_set_root(ctx, rootfs));
    CHECK(krun_add_virtiofs(ctx, "workspace", workspace));  // host dir → guest tag
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
    int32_t r = krun_start_enter(ctx);   // returns only on error in most builds
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = (t1.tv_sec - t0.tv_sec) * 1000.0 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    fprintf(stderr, "[host] krun_start_enter returned %d (elapsed %.1f ms)\n", r, ms);
    return r < 0 ? 1 : 0;
}
