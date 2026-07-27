# krunvm Cache Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cloister-host-runtime` run digest-pinned tool images through krunvm while reusing identical VM state and reclaiming superseded Buildah state before its bounded sparsebundle fills.

**Architecture:** A focused Rust `krunvm` module owns restriction hashing, upstream command construction, inventory, reachability, reserve checks, and the `Backend` implementation. The existing JavaScript CLI delegates runtime execution/status/GC to the Rust binary; it does not duplicate lifecycle policy. All mutations use krunvm and Buildah commands with explicit storage roots.

**Tech Stack:** Rust 2021, serde/serde_json, SHA-256, fs2 filesystem accounting/locking, upstream `krunvm` 0.2.x, Buildah, Node.js CLI delegation, node:test, Cargo tests.

## Global Constraints

- Never delete files beneath Buildah `root` or `runroot` directly.
- Mutable OCI tags are never accepted as runtime identity.
- VM reuse is keyed by the exact persistent restriction, not command arguments.
- Running, active, lockfile-pinned, and unknown entries are never automatically reclaimed.
- Automatic and operator-triggered GC use the same planner and executor.
- The sparsebundle is the emergency ceiling; runtime reserve is `max(20%, 512 MiB)`.
- A microVM request never falls back to a host process.
- Use existing canonical-path and OCI digest contracts; do not add parallel normalizers.

---

### Task 1: Persistent restriction and upstream command contract

**Files:**
- Create: `rs/crates/host-runtime/src/krunvm.rs`
- Modify: `rs/crates/host-runtime/src/lib.rs`
- Modify: `rs/crates/host-runtime/Cargo.toml`
- Test: `rs/crates/host-runtime/tests/krunvm_contract.rs`

**Interfaces:**
- Produces: `KrunvmSettings`, `PersistentRestriction`, `restriction_digest`, `vm_name`, `create_command`, `start_command`.
- Consumes: existing `LaunchPlan`, `ConfinementPort`, and canonical-path validation.

- [ ] **Step 1: Write failing restriction tests**

Create tests that construct two launch plans and assert:

```rust
assert_eq!(restriction_digest(&plan_a, &settings), restriction_digest(&plan_b, &settings));
assert_eq!(vm_name("mache", digest), "cloister-mache-<12 hex>");
```

The plans differ only in `artifact.args`; then change port, workspace, digest,
CPU, and memory independently and require the digest to change.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```sh
cargo test -p cloister-host-runtime --test krunvm_contract
```

Expected: compilation fails because the `krunvm` module and functions do not exist.

- [ ] **Step 3: Implement canonical restriction hashing**

Add:

```rust
#[derive(Clone, Debug, Serialize)]
pub struct PersistentRestriction<'a> {
    schema: &'static str,
    platform_digest: &'a str,
    cpus: u32,
    memory_mib: u32,
    dns: &'a str,
    workdir: &'static str,
    volumes: BTreeMap<&'static str, &'a str>,
    ports: BTreeMap<u16, u16>,
    host_arch: &'a str,
    krunvm_compat: &'static str,
}

pub fn restriction_digest(plan: &LaunchPlan, settings: &KrunvmSettings) -> Result<[u8; 32], RuntimeError>;
pub fn vm_name(bundle: &str, digest: &[u8; 32]) -> String;
```

Use `sha2::Sha256` over `serde_json::to_vec` of BTreeMap-backed fields. Include
the immutable platform manifest digest supplied by settings. Exclude entrypoint
and arguments because `krunvm start -- ...` supplies them without changing
persistent VM state.

- [ ] **Step 4: Implement exact command builders**

Return `CommandSpec { program, args }` values:

```text
krunvm create image@indexDigest --name <vm> --cpus 1 --mem 1024
  --workdir /workspace --volume host:/workspace --port host:guest

krunvm start <vm> -- <entrypoint> <args...>
```

Reject an empty/mutable digest, non-loopback bind address, or missing port.

- [ ] **Step 5: Run tests and commit**

Run:

```sh
cargo test -p cloister-host-runtime --test krunvm_contract
cargo test -p cloister-host-runtime
```

Commit:

```sh
git add rs/crates/host-runtime rs/Cargo.lock
git commit -m "[cloister-6d7af4] feat(runtime): define krunvm restriction contract"
```

### Task 2: Inventory, reachability, and bounded GC planner

**Files:**
- Modify: `rs/crates/host-runtime/src/krunvm.rs`
- Test: `rs/crates/host-runtime/tests/krunvm_lifecycle.rs`

**Interfaces:**
- Produces: `RuntimeInventory`, `VmRecord`, `GcPlan`, `plan_gc`, `StorageUsage`.
- Consumes: Task 1 restriction names and settings.

- [ ] **Step 1: Write failing planner tests**

Use real structs, not command mocks, for a table containing:

```text
running exact VM
active exact VM
lockfile-pinned old VM
superseded inactive VM for the same bundle
unreferenced known image
unknown VM
```

Assert only the superseded VM and unreferenced known image are selected. Assert
recency changes ordering only within that reclaimable set.

- [ ] **Step 2: Run lifecycle test and verify RED**

Run:

```sh
cargo test -p cloister-host-runtime --test krunvm_lifecycle
```

Expected: compilation fails because inventory and GC planner types do not exist.

- [ ] **Step 3: Implement pure mark/sweep planning**

Add:

```rust
pub fn plan_gc(
    inventory: &RuntimeInventory,
    active_restrictions: &BTreeSet<String>,
    pinned_platform_digests: &BTreeSet<String>,
) -> GcPlan;
```

Unknown records are reported in `protected_unknown`; they never appear in delete
actions. VM deletion actions precede image-prune actions.

- [ ] **Step 4: Add reserve calculation**

Add:

```rust
pub fn required_reserve(total_bytes: u64) -> u64 {
    (total_bytes / 5).max(512 * 1024 * 1024)
}
```

`StorageUsage::can_acquire()` is true only when `available_bytes >= reserve_bytes`.

- [ ] **Step 5: Run tests and commit**

Run:

```sh
cargo test -p cloister-host-runtime --test krunvm_lifecycle
cargo test -p cloister-host-runtime
```

Commit:

```sh
git add rs/crates/host-runtime rs/Cargo.lock
git commit -m "[cloister-4adbdc] feat(runtime): plan bounded krunvm garbage collection"
```

### Task 3: krunvm backend, state lock, and fail-closed execution

**Files:**
- Modify: `rs/crates/host-runtime/src/krunvm.rs`
- Modify: `rs/crates/host-runtime/src/main.rs`
- Modify: `rs/crates/host-runtime/Cargo.toml`
- Test: `rs/crates/host-runtime/tests/krunvm_backend.rs`
- Test: `rs/crates/host-runtime/tests/cli.rs`

**Interfaces:**
- Produces: `KrunvmBackend<R: CommandRunner>`, `SystemCommandRunner`, `status`, `gc`.
- Consumes: Task 1 command contract and Task 2 planner.

- [ ] **Step 1: Write failing backend tests**

Use a recording `CommandRunner` returning fixture JSON/text for `krunvm list`,
`krunvm inspect`, and Buildah inventory. Assert:

- exact inspect match starts without create;
- absent VM triggers GC, reserve recheck, create, inspect, then start;
- inspect platform-digest mismatch fails before start;
- failed create deletes only its deterministic attempted VM;
- GC invokes `krunvm delete <name>` before Buildah prune;
- all Buildah calls contain `--root <volume>/root --runroot <volume>/runroot`;
- reserve breach after GC returns `RuntimeError::Backend` without create.

- [ ] **Step 2: Run backend tests and verify RED**

Run:

```sh
cargo test -p cloister-host-runtime --test krunvm_backend
```

Expected: compilation fails because backend/runner types do not exist.

- [ ] **Step 3: Implement state locking and command execution**

Use `fs2::FileExt::lock_exclusive` on
`<storage-volume>/cloister-runtime.lock`. Inventory is rebuilt under the lock.
Use only upstream commands:

```text
krunvm list
krunvm inspect <name>
krunvm delete <name>
buildah --root ... --runroot ... images --json
buildah --root ... --runroot ... rmi --prune
```

Do not parse or delete `vfs/dir` entries.

- [ ] **Step 4: Wire the real backend and doctor**

`run <plan>` constructs `KrunvmBackend<SystemCommandRunner>` for microVM plans.
`doctor` probes executable availability with bounded `--version` calls, verifies
the configured volume is mounted/writable, reports total/used/free/reserve JSON,
and keeps process mode unavailable.

- [ ] **Step 5: Add status and GC subcommands**

Support:

```text
cloister-host-runtime status
cloister-host-runtime gc --print
cloister-host-runtime gc --yes
```

`gc` defaults to preview. `--yes` takes the lock, rebuilds inventory, recomputes
the plan, prints it, and executes exactly that revalidated plan.

- [ ] **Step 6: Run tests and commit**

Run:

```sh
cargo test -p cloister-host-runtime
cargo clippy -p cloister-host-runtime --all-targets -- -D warnings
```

Commit:

```sh
git add rs/crates/host-runtime rs/Cargo.lock
git commit -m "[cloister-6d7af4] feat(runtime): execute pinned krunvm backends"
```

### Task 4: Operator CLI delegation and documentation

**Files:**
- Create: `scripts/host-runtime-cli.mjs`
- Modify: `scripts/cloister-cli.mjs`
- Modify: `scripts/test/cloister-cli.test.mjs`
- Modify: `Taskfile.yml`
- Modify: `GETTING-STARTED.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `cloister runtime run`, `cloister runtime doctor`,
  `cloister runtime storage status`, and `cloister runtime storage gc`.
- Consumes: Task 3 binary commands.

- [ ] **Step 1: Write failing CLI dispatch tests**

Set `CLOISTER_HOST_RUNTIME_BIN` to a temporary executable that records argv.
Assert the four CLI surfaces forward exact arguments and exit status. Assert a
missing binary gives an install/build diagnostic and never falls back.

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```sh
node --test scripts/test/cloister-cli.test.mjs
```

Expected: tests fail because the runtime commands are unknown.

- [ ] **Step 3: Implement one delegation seam**

`host-runtime-cli.mjs` resolves `CLOISTER_HOST_RUNTIME_BIN`, then
`rs/target/release/cloister-host-runtime`, then PATH. It calls `spawnSync` with
inherited stdio and returns the exact child status. Every JavaScript command uses
this one function.

- [ ] **Step 4: Add Taskfile build and dogfood commands**

Add:

```text
task runtime:build
task runtime:doctor
task runtime:run -- <plan.json>
task runtime:storage:status
task runtime:storage:gc -- --print
```

- [ ] **Step 5: Correct truthful docs**

Document macOS prerequisites, sparsebundle expansion, numeric guest loopback,
status/GC previews, and the distinction between shipped krunvm coarse isolation
and proposed per-operation FUSE escalation. Do not claim automated binary
installation.

- [ ] **Step 6: Run tests and commit**

Run:

```sh
node --test scripts/test/cloister-cli.test.mjs scripts/test/init-krun-storage.test.mjs
task lint
```

Commit:

```sh
git add scripts Taskfile.yml GETTING-STARTED.md README.md
git commit -m "[cloister-6d7af4] feat(cli): operate the krunvm runtime"
```

### Task 5: Live Mache reuse and GC verification

**Files:**
- Modify only if a discovered defect requires a preceding failing regression test.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: real runtime evidence on the active Rosary bead.

- [ ] **Step 1: Build and validate a real launch plan**

Run:

```sh
task runtime:build
node scripts/cloister-cli.mjs runtime plan mache \
  --workspace /Users/jamesgardner/remotes/art/cloister \
  --output /tmp/cloister-mache-plan.json
node scripts/cloister-cli.mjs runtime doctor
```

- [ ] **Step 2: Start Mache and smoke MCP**

Run the plan, wait for host port readiness, then POST MCP `initialize` and
`tools/list`. Require server version `0.17.0` and a non-empty tool list.

- [ ] **Step 3: Prove reuse**

Stop cleanly, record store bytes and VM inventory, run the same plan again, and
require:

```text
same deterministic VM name
no krunvm create
no additional VM
no material store growth beyond metadata noise
```

- [ ] **Step 4: Prove GC preview safety**

Run `storage gc --print`; require the active/lockfile-pinned Mache VM and platform
digest to be protected. Do not execute deletion against the only pinned dogfood
VM.

- [ ] **Step 5: Run final gates**

Run:

```sh
task lint
task verify
git diff --check
git status --short
```

- [ ] **Step 6: Update beads**

Comment `cloister-6d7af4` and `cloister-4adbdc` with commit hashes, measured
before/after bytes, smoke output, and any remaining limitation. Leave completion
to the reconciler per repository policy.
