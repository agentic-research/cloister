# krunvm cache lifecycle design

**Date:** 2026-07-27
**Status:** Approved direction; implementation pending
**Tracking:** `cloister-4adbdc`, `cloister-6d7af4`

## Goal

Run lockfile-pinned OCI tools through Cloister's krunvm backend without letting
successive image digests silently fill the host disk.

The runtime must reuse identical VM state, reclaim superseded state through
krunvm and Buildah's public commands, expose disk accounting, and fail before a
new acquisition can exhaust its bounded sparsebundle. It must never delete
Buildah's storage directories directly.

## Evidence

The first Mache dogfood VM resolved this chain:

```text
lockfile index digest
  sha256:8620a0dc...
        │
        ▼ platform resolution (arm64)
manifest digest
  sha256:14ee0c30...
        │
        ▼ Buildah vfs materialization
krunvm working container
```

The registry artifact is about 47 MiB compressed. The mounted Buildah store is
about 1 GiB:

| Store entry | Approximate size |
| --- | ---: |
| Base rootfs layer | 103 MiB |
| Successive `vfs` layer trees | 107–175 MiB each |
| Working-container tree | 175 MiB |
| Total store | 1.0 GiB |

This is not an accidental set of duplicate VMs: one six-layer image plus one
working container causes the expansion. Buildah's macOS `vfs` driver
materializes cumulative directory trees, so a new image digest can consume
close to another GiB even when its compressed delta is small.

`krunvm delete` is necessary but insufficient for garbage collection. Upstream
removes the Buildah working container with `buildah rm`; it does not remove the
now-unreferenced image and layer records. Image reclamation therefore requires a
separate Buildah prune using the same explicit `--root` and `--runroot` that
krunvm owns.

## Prior art to compose

### Zarf

Zarf uses an explicit ORAS cache for content-addressed OCI descriptors and can
pull only the layer families an operation requires. This is the right
acquisition shape: immutable descriptors are reusable independently of mutable
working state.

Zarf's retention policy is not sufficient here. Its cache is intentionally
unbounded and its operator guidance is to inspect it with `du` and periodically
run `zarf tools clear-cache`.

Relevant sources:

- <https://pkg.go.dev/github.com/zarf-dev/zarf/src/pkg/zoci>
- <https://docs.zarf.dev/faq#when-should-i-clear-my-zarf-cache>

### ley-line-open ADR-0031

ADR-0031's useful rule is:

> Reuse an expensive derived value when the exact hash of its cheap,
> consumer-observable input closure is unchanged.

For Cloister, the derived value is a configured krunvm VM. The restriction is
not the entire launch plan: command arguments are supplied at `krunvm start`
time and do not change persistent VM state. The persistent restriction contains
only:

```text
schema version
resolved platform manifest digest
CPU and memory
DNS setting
guest workdir
sorted host-volume → guest-path mappings
sorted host-port → guest-port mappings
host architecture
krunvm major/minor compatibility version
```

The restriction is canonical JSON hashed with SHA-256. A VM name is:

```text
cloister-<bundle>-<first 12 hex chars of restriction digest>
```

The full restriction digest is persisted and checked; the short name is not
treated as collision-proof identity.

## Approaches considered

### A. Lifecycle index over upstream krunvm and Buildah — selected

Cloister records the VM restriction, resolved platform digest, last successful
use, and pin state in a small atomic state document. It creates and deletes VMs
through krunvm, then asks Buildah to prune unreferenced images through the same
explicit storage roots.

This reuses the upstream rootfs implementation and keeps the new code limited to
policy, lifecycle, and accounting.

### B. Replace Buildah storage with a Zarf-style ORAS cache and custom rootfs materializer

This would avoid some `vfs` expansion and enable selective/lazy materialization,
but it duplicates OCI extraction, whiteout, ownership, and rootfs semantics that
krunvm already delegates to Buildah. It is deferred unless measured retention
proves the upstream store cannot support the required three-tool cluster.

### C. Treat the sparsebundle as disposable and recreate it wholesale

This guarantees reclamation but destroys all warm state, cannot preserve active
or pinned tenants selectively, and makes routine digest upgrades destructive.
It remains an explicit disaster-recovery operation, not normal GC.

## Runtime ownership

The sparsebundle remains the outer emergency ceiling. Cloister owns a lower
high-water mark so normal recovery happens before APFS returns `ENOSPC`.

```text
.cloister/krunvm.sparsebundle       outer physical allocation
        │ mounts
        ▼
/Volumes/krunvm                     bounded APFS filesystem
        ├── root/                   Buildah graph root (upstream-owned)
        ├── runroot/                Buildah run root (upstream-owned)
        └── cloister-runtime.json   Cloister lifecycle index
```

The lifecycle index is rebuildable from `krunvm list`, `krunvm inspect`, the
current launch plans, and the lockfile. It is an optimization and audit aid, not
the sole source of ownership truth.

## Reconciliation

For a requested launch plan:

1. Validate the immutable index digest and canonical host paths.
2. Resolve the platform manifest digest before creating persistent state.
3. Compute the persistent restriction digest.
4. Lock the runtime store so concurrent starts cannot race GC or create.
5. Inventory krunvm VMs and current filesystem capacity.
6. Reuse the exact matching VM when its full restriction and inspected
   configuration match.
7. Otherwise mark active VMs and current lockfile digests.
8. Delete superseded, inactive VMs for the same bundle with `krunvm delete`.
9. Ask Buildah to remove only images no longer referenced by any container.
10. Re-check the reserve. Refuse acquisition if the reserve is still not met.
11. Create the new VM from `image@index-digest`.
12. Inspect it and require the resolved platform digest to equal the preflight
    result before recording success.
13. Start it with the plan's entrypoint and arguments after `--`.

A failed create is followed by best-effort deletion of only the deterministic
VM name created by that attempt, then another inventory. Cloister never falls
back to an unconstrained local process.

## Retention and disk pressure

Two thresholds apply:

- **Outer ceiling:** sparsebundle logical capacity. This bounds damage to the
  host even if upstream expansion is larger than predicted.
- **Runtime reserve:** the greater of 20% of mounted capacity or 512 MiB must
  remain free before a new digest acquisition begins.

The initial implementation does not pretend it can predict `vfs` expansion from
compressed registry size. It reclaims first and refuses when the reserve is
already breached. If an upstream create still reaches `ENOSPC`, the attempt is
cleaned up and reported as a storage-capacity error with current usage and the
GC command.

Reachability classes:

| Class | Reclaim automatically? |
| --- | --- |
| Running VM | Never |
| Exact VM required by an active launch | Never |
| Image digest present in current `cluster.lock.toml` | Never by default |
| Superseded VM for the same bundle | Yes, before acquisition |
| Unreferenced image with no current lockfile pin | Yes, at high-water mark |
| Unknown storage entry | No; report and require explicit operator action |

No time-only TTL may evict a pinned artifact. Recency orders candidates only
within the unpinned, unreachable set.

## Operator surface

```text
cloister runtime storage status
cloister runtime storage gc --print
cloister runtime storage gc --yes
cloister runtime run <plan.json>
```

`status` reports mounted capacity, used/free bytes, reserve, VM names,
restriction digests, platform digests, and reachability class.

`gc --print` is the default-safe preview. `--yes` deletes only the printed,
still-unreachable set after taking the store lock and revalidating it.

Automatic pre-launch GC uses the same planner and executor as the CLI. There is
one retention implementation.

## Confinement boundary

The krunvm child is launched by `cloister-host-runtime`, whose process is
confined with the repository's existing nono library integration. Its host
filesystem access includes only:

- the mounted krunvm storage volume,
- the declared workspace paths,
- the runtime control socket and state path,
- required system/runtime libraries.

The microVM is the tool boundary; nono is defense in depth around the host-side
VMM and Buildah processes. Colima may acquire or inspect OCI artifacts, but it
does not replace the host-side libkrun boundary.

## Tests

Unit tests use a command-runner seam and temporary filesystem:

- identical restriction reuses without `krunvm create`;
- changed persistent input produces a different restriction;
- changed start-only arguments do not duplicate VM state;
- running, active, pinned, and unknown entries are never selected;
- superseded inactive VM is selected before unpinned images;
- GC revalidates its plan after acquiring the lock;
- reserve breach refuses creation after GC;
- failed create cleans only its deterministic attempted VM;
- inspect digest mismatch fails closed;
- no code path deletes Buildah directories directly;
- process fallback remains impossible for `mode = microvm`.

An opt-in macOS integration test creates one small pinned image twice and proves
the second run creates no additional VM or material increase in store usage.
It then changes the restriction, previews the old VM as reclaimable, executes
GC, and verifies the old VM is absent.

## Non-goals

- Implementing a new OCI client, layer unpacker, or whiteout engine.
- Treating mutable tags as cache keys.
- Predicting uncompressed `vfs` cost from compressed layer sizes.
- Automatically deleting unknown operator-owned Buildah state.
- Solving content-defined chunking in this increment.
