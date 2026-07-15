# NFS server for the ADR-0046 syscall-adapter mediator — decision (2026-07-14)

Plan 2 (`docs/superpowers/plans/2026-07-14-nfs-mediator-derisk.md`) Task 3.

## Requirement

The mediator needs a **userspace** NFS server whose per-request path is where
cloister policy runs: authorize `open`/`read`/`write`, serve the read side from
`leyline-cas` by digest (lower), validate-on-write the mutable workspace (upper),
and emit `SkillLoadReceipt` on CAS-object reads. macOS kernel `nfsd` is
disqualified — it has no userspace hook. macOS (Apple-Silicon, kext-free) is the
priority platform; Linux second.

## Options (grounded in real sources)

| Option | Lang | Per-op policy hook | macOS + Linux | Maturity | Notes |
|---|---|---|---|---|---|
| **`nfsserve`** (xetdata / huggingface) | **Rust** | implement one `vfs::NFSFileSystem` trait | **Linux + Mac + Windows**, no kext | production — powers **xet mount** (multi-TB content-addressed repos) | built *because* "FUSE is annoying on Mac (drivers necessary)" — our exact reason; NFSv3, "incomplete but very functional" |
| **mache's `willscott/go-nfs` + `go-billy`** | Go | implement `billy.Filesystem` | yes (mache ships it on Mac) | production — mache's projected fs | proves the pattern (`internal/nfsmount/graphfs.go` is a custom `billy.Filesystem`); but Go, not Rust |
| macOS kernel `nfsd` | — | **none** (kernel) | macOS | shipped | disqualified — no userspace policy hook; usable only for the Task 1 transport proof |

## Task 1–2 result (transport stack)

**Pending — user runs `run-nfs-stack.sh` + `trace-fidelity.sh` (needs `sudo` for
`nfsd`/exports + an `fs_usage` terminal).** These validate the *transport*
(virtio-fs → host NFS mount forwards every op with DAX off + `actimeo=0`); they
are **independent of the library choice** below (which stands on API / language /
maturity merits). Fill on run:
- Stack forwards guest read+write: `<PASS/FAIL>`
- Caching-off fidelity (repeated reads each hit the server): `<observed count>`

## Decision

**Adopt `nfsserve` (Rust, xetdata/huggingface).**

Rationale:
1. **Language-aligns the mediator with its dependencies.** The read side is
   `leyline-cas` (Rust), the policy is confinement/v1 (Rust, `tools/harness-sandbox`),
   validate-on-write is tree-sitter (Rust). A Rust NFS server keeps the mediator
   single-language with the CAS + policy + validation code. mache's Go server
   would force a Go/Rust boundary around exactly the hot, security-critical path.
2. **Purpose-built for this exact use case.** `nfsserve` exists to mount a
   **content-addressed store** cross-platform **without a FUSE kext** — which is
   the mediator (CAS lower, macOS-first, no kext). Not merely viable; designed
   for it.
3. **macOS-first, kext-free, proven.** Cross-platform (Linux/Mac/Windows),
   production-hardened by xet mounts. Matches the NFS-first decision's driver.

**Rejected:** macOS kernel `nfsd` (no userspace hook). **Fallback:** mache's
`go-nfs` + `billy.Filesystem` — it proves the pattern and is the choice *only if*
a Go mediator is later preferred; rejected now because it fragments the language
of the security-critical fs path.

## Open verification before Plan 3

- **Write completeness — VERIFIED (2026-07-14, docs.rs `NFSFileSystem` trait).**
  No gap. `write(id, offset, data) -> fattr3`, `create(dirid, filename, attr) ->
  (fileid3, fattr3)`, `setattr(id, sattr3) -> fattr3`, plus `mkdir` / `remove` /
  `rename` / `symlink` / `create_exclusive` are all **required** trait methods, and
  `capabilities() -> VFSCapabilities` declares read-write (the trait documents the
  `NFS3ERR_ROFS` read-only pattern). The mediator's validate-on-write upper maps
  1:1 onto these. The "incomplete but functional" caveat is about edge features,
  not the write path.
- **64-bit fileid mapping — the remaining design item (folds into Plan 3).** The
  trait keys every object on `fileid3` (u64): `read`/`write`/`getattr`/`lookup`
  all take/return it. So the mediator must map each fs object to a stable u64 —
  CAS digest → id for the lower (a digest↔id table), inode-like ids for the
  upper. Bounded and known; decided in Plan 3.

## What Plan 3 builds on this

The policy fs implemented as an `nfsserve` `NFSFileSystem` impl: lower = `leyline-cas`
by digest (+ `SkillLoadReceipt` per read), upper = validate-on-write workspace,
gated by the same `VerifiedLease` the vault uses (reuse `src/routes/lease-middleware.ts`
in place per ADR-0046). Guest reaches it via `krun_add_virtiofs3(..., shm_size=0)`
pointed at the mediator's NFS mount.

## Sources

- [xetdata/nfsserve — Rust NFS server](https://github.com/xetdata/nfsserve) ·
  [huggingface/nfsserve](https://github.com/huggingface/nfsserve) ·
  [crates.io/nfsserve](https://crates.io/crates/nfsserve)
- [XetHub — NFS > FUSE: Why We Built our own NFS Server in Rust](https://xethub.com/blog/nfs-fuse-why-we-built-nfs-server-rust)
- mache: `go.mod` (`willscott/go-nfs`, `go-git/go-billy`), `internal/nfsmount/graphfs.go`
