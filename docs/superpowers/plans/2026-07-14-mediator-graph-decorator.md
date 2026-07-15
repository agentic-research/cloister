# Mediator: confinement `Graph` decorator (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cloister's policy plane for the ADR-0046 syscall adapter as a **decorator over LLO's public `leyline_fs::graph::Graph` trait** — authorize every op against a confinement/v1 policy, emit a `SkillLoadReceipt` on content reads, and delegate to the real graph. This is the *entire* mediator: `leyline-fs` already provides NFS/FUSE presentation, the arena, the CoW overlay, and validate-on-write.

**Architecture:** A standalone native crate `tools/mediator/` (like `tools/harness-sandbox`, outside the rs/ wasm workspace) defines `ConfinementGraph { inner: Arc<dyn Graph>, policy, receipts }` and `impl Graph for ConfinementGraph`. Each method: `authorize → (receipt) → self.inner.<op>()`, or deny with an error. Wired via `LeylineNfs::new(Arc::new(ConfinementGraph::new(real_graph, policy)))` — no change to `leyline-fs`.

**Tech Stack:** Rust (native), `leyline-fs` (LLO git dep, same URL as the cas-ffi/sign pins), `anyhow`, `serde`. Tests use `leyline_fs::graph::MemoryGraph`.

## Global Constraints

- **No upstream `leyline-fs` change.** The `Graph` trait is the extension point; cloister only *implements* it. Per ADR-0035 (bridge crates in cloister) + ADR-0046 (policy core in cloister).
- **`Result` is `anyhow::Result`** (leyline-fs's `graph` module uses `anyhow`). Denials are `anyhow::bail!(...)` — the trait's read-only defaults already `bail!("read-only filesystem")`, so a denied op returning `Err` maps to an NFS/FUSE error cleanly.
- **`Node`** = `{ id: String, name: String, is_dir: bool, size: u64, mtime_nanos: i64 }`. Ids are path-like strings; root's `parent_id` is `""`.
- **Policy is fixed per-mount.** The guest is one confined subject; the confinement/v1 manifest + `VerifiedLease` are set at `ConfinementGraph` construction (from the §7-verified manifest — reuse `tools/harness-sandbox`'s confinement/v1 shape). No per-request subject at the fs layer.
- **Commit convention:** `[cloister-b28416] <type>(<scope>): <subject>` (`chore`/`feat`/`docs`; not `spike`). Trailer `bead: cloister` ok.
- **leyline-fs pin:** use the same LLO git URL as `rs/crates/cas/Cargo.toml`; pin a rev and record it. Confirm `leyline-fs` re-exports `graph::{Graph, Node, MemoryGraph}` and `LeylineNfs`/`LeylineFuse` (verify from the LLO checkout before pinning).

---

### Task 1: Crate skeleton + the confinement policy matcher

**Files:**
- Create: `tools/mediator/Cargo.toml`
- Create: `tools/mediator/rust-toolchain.toml` (match `tools/harness-sandbox` channel)
- Create: `tools/mediator/src/policy.rs`
- Create: `tools/mediator/src/lib.rs`

**Interfaces:**
- Produces: `Policy` with `Policy::allows_read(id: &str) -> bool` and `allows_write(id: &str) -> bool` (path-prefix allowlist derived from a confinement/v1 manifest: read = `fs.allow` entries; write = the `mode:"rw"` subset).

- [ ] **Step 1: Write the failing test** in `src/policy.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Policy {
        // ro on /skills, rw on /work
        Policy { read_prefixes: vec!["/skills".into(), "/work".into()], write_prefixes: vec!["/work".into()] }
    }
    #[test]
    fn read_allowed_under_prefix()   { assert!(policy().allows_read("/skills/x.md")); }
    #[test]
    fn read_denied_outside_prefix()  { assert!(!policy().allows_read("/etc/passwd")); }
    #[test]
    fn write_allowed_only_on_rw()    { assert!(policy().allows_write("/work/out.txt")); }
    #[test]
    fn write_denied_on_ro_prefix()   { assert!(!policy().allows_write("/skills/x.md")); }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tools/mediator && cargo test policy`
Expected: FAIL (`Policy` not defined).

- [ ] **Step 3: Implement `Policy`** in `src/policy.rs`

```rust
use serde::Deserialize;

/// confinement/v1 fs allowlist, flattened to path-prefix sets. `read_prefixes`
/// = every `fs.allow` entry; `write_prefixes` = the `mode:"rw"` subset.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub read_prefixes: Vec<String>,
    pub write_prefixes: Vec<String>,
}

impl Policy {
    pub fn allows_read(&self, id: &str) -> bool { has_prefix(&self.read_prefixes, id) }
    pub fn allows_write(&self, id: &str) -> bool { has_prefix(&self.write_prefixes, id) }
}

fn has_prefix(prefixes: &[String], id: &str) -> bool {
    let id = if id.is_empty() { "/" } else { id };
    prefixes.iter().any(|p| id == p || id.starts_with(&format!("{}/", p.trim_end_matches('/'))) || id.starts_with(p.as_str()))
}

/// confinement/v1 manifest → Policy (mirrors tools/harness-sandbox's shape).
#[derive(Debug, Deserialize)]
pub struct ConfinementFs { pub allow: Vec<FsEntry> }
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum FsEntry { Ro(String), Rw { path: String, mode: String } }

impl From<&ConfinementFs> for Policy {
    fn from(fs: &ConfinementFs) -> Self {
        let mut read_prefixes = Vec::new();
        let mut write_prefixes = Vec::new();
        for e in &fs.allow {
            match e {
                FsEntry::Ro(p) => read_prefixes.push(p.clone()),
                FsEntry::Rw { path, mode } => {
                    read_prefixes.push(path.clone());
                    if mode == "rw" { write_prefixes.push(path.clone()); }
                }
            }
        }
        Policy { read_prefixes, write_prefixes }
    }
}
```

- [ ] **Step 4: Write `Cargo.toml`** (fill `<LLO_URL>`/`<REV>` from `rs/crates/cas/Cargo.toml`)

```toml
[package]
name = "cloister-mediator"
version = "0.0.1"
edition = "2021"
publish = false

[lib]
name = "cloister_mediator"
path = "src/lib.rs"

[dependencies]
leyline-fs = { git = "<LLO_URL>", rev = "<REV>", package = "leyline-fs" }
anyhow = "1"
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
# MemoryGraph is exported by leyline-fs for tests.
```

- [ ] **Step 5: `src/lib.rs`** exposes the modules

```rust
pub mod policy;
pub mod graph;
```

- [ ] **Step 6: Run the test + commit**

Run: `cd tools/mediator && cargo test policy` → PASS.
```bash
git add tools/mediator/Cargo.toml tools/mediator/rust-toolchain.toml tools/mediator/src/policy.rs tools/mediator/src/lib.rs
git commit -m "[cloister-b28416] feat(mediator): confinement/v1 policy matcher (path-prefix allowlist)"
```

---

### Task 2: `ConfinementGraph` — authorize reads, delegate to inner

**Files:**
- Create: `tools/mediator/src/graph.rs`

**Interfaces:**
- Consumes: `Policy` (Task 1), `leyline_fs::graph::{Graph, Node, MemoryGraph}`.
- Produces: `ConfinementGraph { inner: Arc<dyn Graph>, policy: Policy, receipts: Arc<dyn ReceiptSink> }` implementing `Graph`; `ReceiptSink` trait with `fn skill_load(&self, id: &str)`.

- [ ] **Step 1: Write the failing test** in `src/graph.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use leyline_fs::graph::{Graph, MemoryGraph, Node};
    use std::sync::Arc;

    fn inner_with_file() -> Arc<dyn Graph> {
        let mut g = MemoryGraph::new();
        g.add_node(Node { id: "/skills/x.md".into(), name: "x.md".into(), is_dir: false, size: 5, mtime_nanos: 0 }, "/skills", Some(b"hello".to_vec()));
        g.add_node(Node { id: "/etc/secret".into(), name: "secret".into(), is_dir: false, size: 3, mtime_nanos: 0 }, "/etc", Some(b"top".to_vec()));
        Arc::new(g)
    }
    fn cg() -> ConfinementGraph {
        ConfinementGraph::new(inner_with_file(), Policy { read_prefixes: vec!["/skills".into()], write_prefixes: vec![] }, Arc::new(NullSink))
    }

    #[test]
    fn read_allowed_delegates() {
        let mut buf = [0u8; 8];
        let n = cg().read_content("/skills/x.md", &mut buf, 0).unwrap();
        assert_eq!(&buf[..n], b"hello");
    }
    #[test]
    fn read_denied_outside_policy() {
        let mut buf = [0u8; 8];
        assert!(cg().read_content("/etc/secret", &mut buf, 0).is_err());
    }
    struct NullSink;
    impl ReceiptSink for NullSink { fn skill_load(&self, _id: &str) {} }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tools/mediator && cargo test graph`
Expected: FAIL (`ConfinementGraph` not defined).

- [ ] **Step 3: Implement `ConfinementGraph`** (reads authorized + receipted; writes deferred to Task 3)

```rust
use crate::policy::Policy;
use anyhow::{bail, Result};
use leyline_fs::graph::{Graph, Node};
use std::sync::Arc;

/// Where load events go (ADR-0043). Impl'd cloister-side to write the
/// SkillLoadReceipt to the same audit sink the vault-proxy uses.
pub trait ReceiptSink: Send + Sync {
    fn skill_load(&self, id: &str);
}

/// Policy decorator over leyline-fs's Graph. Every op: authorize → (receipt) →
/// delegate, or deny. No change to leyline-fs (ADR-0046 policy core).
pub struct ConfinementGraph {
    inner: Arc<dyn Graph>,
    policy: Policy,
    receipts: Arc<dyn ReceiptSink>,
}

impl ConfinementGraph {
    pub fn new(inner: Arc<dyn Graph>, policy: Policy, receipts: Arc<dyn ReceiptSink>) -> Self {
        Self { inner, policy, receipts }
    }
    fn deny_read(&self, id: &str) -> Result<()> {
        if self.policy.allows_read(id) { Ok(()) } else { bail!("confinement: read denied: {id}") }
    }
    fn child_id(parent: &str, name: &str) -> String {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

impl Graph for ConfinementGraph {
    fn get_node(&self, id: &str) -> Result<Option<Node>> { self.deny_read(id)?; self.inner.get_node(id) }
    fn lookup_child(&self, parent: &str, name: &str) -> Result<Option<Node>> {
        self.deny_read(&Self::child_id(parent, name))?; self.inner.lookup_child(parent, name)
    }
    fn list_children(&self, parent: &str) -> Result<Vec<Node>> { self.deny_read(parent)?; self.inner.list_children(parent) }
    fn read_content(&self, id: &str, buf: &mut [u8], offset: u64) -> Result<usize> {
        self.deny_read(id)?;
        self.receipts.skill_load(id);            // ADR-0043 load event
        self.inner.read_content(id, buf, offset)
    }
    // write methods fall through to the trait's default (EROFS) until Task 3.
}
```

- [ ] **Step 4: Run + commit**

Run: `cd tools/mediator && cargo test` → PASS (policy + graph).
```bash
git add tools/mediator/src/graph.rs
git commit -m "[cloister-b28416] feat(mediator): ConfinementGraph — authorize+receipt reads, delegate"
```

---

### Task 3: Authorize writes (validate-on-write upper)

**Files:**
- Modify: `tools/mediator/src/graph.rs`

**Interfaces:**
- Produces: write methods on `ConfinementGraph` that authorize against `policy.allows_write` then delegate.

- [ ] **Step 1: Write the failing test** (append to `src/graph.rs` tests)

```rust
#[test]
fn write_denied_on_ro_prefix() {
    let cg = ConfinementGraph::new(inner_with_file(),
        Policy { read_prefixes: vec!["/skills".into()], write_prefixes: vec![] }, Arc::new(NullSink));
    assert!(cg.write_content("/skills/x.md", b"tamper", 0).is_err());
}
#[test]
fn write_allowed_on_rw_prefix() {
    let mut g = MemoryGraph::new_writable_placeholder(); // see Step 3 note
    // (a writable MemoryGraph seeded with /work/out.txt)
    let cg = ConfinementGraph::new(Arc::new(g),
        Policy { read_prefixes: vec!["/work".into()], write_prefixes: vec!["/work".into()] }, Arc::new(NullSink));
    assert!(cg.write_content("/work/out.txt", b"ok", 0).is_ok());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tools/mediator && cargo test write_`
Expected: FAIL (write methods not overridden; the RO test may pass via default EROFS, but the RW test fails).

*Note:* confirm `MemoryGraph`'s writable-seeding API from the LLO checkout (`add_node` + whether writes are supported in-memory, or use a small writable test double implementing `Graph`). If `MemoryGraph` is read-only, define a `WritableTestGraph` in the test module that records writes.

- [ ] **Step 3: Implement the write methods** (add to `impl Graph for ConfinementGraph`)

```rust
    fn write_content(&self, id: &str, data: &[u8], offset: u64) -> Result<usize> {
        self.deny_write(id)?; self.inner.write_content(id, data, offset)
    }
    fn create_node(&self, parent: &str, name: &str, is_dir: bool) -> Result<String> {
        self.deny_write(&Self::child_id(parent, name))?; self.inner.create_node(parent, name, is_dir)
    }
    fn remove_node(&self, id: &str) -> Result<()> { self.deny_write(id)?; self.inner.remove_node(id) }
    fn truncate(&self, id: &str) -> Result<()> { self.deny_write(id)?; self.inner.truncate(id) }
    fn rename_node(&self, id: &str, np: &str, nn: &str) -> Result<()> {
        self.deny_write(id)?; self.deny_write(&Self::child_id(np, nn))?; self.inner.rename_node(id, np, nn)
    }
```

and the helper:

```rust
    fn deny_write(&self, id: &str) -> Result<()> {
        if self.policy.allows_write(id) { Ok(()) } else { bail!("confinement: write denied: {id}") }
    }
```

- [ ] **Step 4: Run + commit**

Run: `cd tools/mediator && cargo test` → PASS.
```bash
git add tools/mediator/src/graph.rs
git commit -m "[cloister-b28416] feat(mediator): authorize writes (deny outside rw allowlist)"
```

---

### Task 4: `SkillLoadReceipt` shape + a recording sink test

**Files:**
- Modify: `tools/mediator/src/graph.rs` (test)
- Create: `tools/mediator/src/receipt.rs`

**Interfaces:**
- Produces: `SkillLoadReceipt { id, at }` and a `RecordingSink` (test) proving `read_content` emits exactly one load event with the read id.

- [ ] **Step 1: Write the failing test** in `src/graph.rs`

```rust
#[test]
fn read_emits_one_load_receipt() {
    use crate::receipt::RecordingSink;
    let sink = Arc::new(RecordingSink::default());
    let cg = ConfinementGraph::new(inner_with_file(),
        Policy { read_prefixes: vec!["/skills".into()], write_prefixes: vec![] }, sink.clone());
    let mut buf = [0u8; 8];
    cg.read_content("/skills/x.md", &mut buf, 0).unwrap();
    assert_eq!(sink.ids(), vec!["/skills/x.md".to_string()]);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tools/mediator && cargo test read_emits`
Expected: FAIL (`receipt::RecordingSink` not defined).

- [ ] **Step 3: Implement `src/receipt.rs`**

```rust
use crate::graph::ReceiptSink;
use parking_lot::Mutex;   // add parking_lot to Cargo.toml deps

/// The ADR-0043 load event: signed skill/agent/tool digest D loaded at time T.
/// (Wiring to the real audit sink — same one vault-proxy's ProxyCallReceipt uses —
/// is the integration task; this is the shape + a test sink.)
#[derive(Debug, Clone)]
pub struct SkillLoadReceipt { pub id: String }

#[derive(Default)]
pub struct RecordingSink { ids: Mutex<Vec<String>> }
impl RecordingSink { pub fn ids(&self) -> Vec<String> { self.ids.lock().clone() } }
impl ReceiptSink for RecordingSink {
    fn skill_load(&self, id: &str) { self.ids.lock().push(id.to_string()); }
}
```

Add `pub mod receipt;` to `src/lib.rs` and `parking_lot = "0.12"` to `Cargo.toml`.

- [ ] **Step 4: Run + commit**

Run: `cd tools/mediator && cargo test` → PASS.
```bash
git add tools/mediator/src/receipt.rs tools/mediator/src/lib.rs tools/mediator/Cargo.toml
git commit -m "[cloister-b28416] feat(mediator): SkillLoadReceipt shape + recording sink test"
```

---

### Task 5: Wire into `LeylineNfs` + a local mount smoke (integration point)

**Files:**
- Create: `tools/mediator/src/bin/mount.rs`
- Modify: `Taskfile.yml` (add `mediator:dev`, local-only)

**Interfaces:**
- Consumes: `ConfinementGraph`, `leyline_fs::LeylineNfs` (+ `LeylineFuse`), a real `Graph` from an arena.

- [ ] **Step 1: Write `src/bin/mount.rs`** — construct the real graph, wrap it, hand to `LeylineNfs::new`

```rust
// Constructs the confinement-wrapped mount. The real leyline-fs graph comes
// from an arena (SqliteGraphAdapter / from_arena); verify the exact constructor
// + LeylineNfs serve API from the LLO checkout and fill here. The confinement
// wrapping is the fixed part:
//   let inner: Arc<dyn Graph> = /* leyline-fs arena graph */;
//   let policy = Policy::from(&manifest.fs);          // §7-verified confinement/v1
//   let cg = Arc::new(ConfinementGraph::new(inner, policy, receipts));
//   let nfs = LeylineNfs::new(cg);
//   /* LeylineNfs serve/listen — from leyline-fs API */
fn main() -> anyhow::Result<()> { Ok(()) }
```

- [ ] **Step 2: Verify the leyline-fs mount/serve API** from `~/remotes/art/ley-line-open/rs/ll-open/fs/src/nfs.rs` (the `NFSTcpListener`/serve path) and fill Step 1's `/* … */` with the exact calls. **No placeholders in the committed bin.**

- [ ] **Step 3: Add `mediator:dev` Taskfile target** (local-only, like `spike:libkrun`)

```yaml
  mediator:dev:
    desc: "cloister-b28416 — mount the confinement-wrapped leyline-fs graph (ADR-0046 syscall adapter). Local-only (needs libkrun/mount); NOT a CI gate."
    dir: tools/mediator
    cmds:
      - cargo run --bin mount
```

- [ ] **Step 4: Commit**

```bash
git add tools/mediator/src/bin/mount.rs Taskfile.yml
git commit -m "[cloister-b28416] feat(mediator): mount bin wiring ConfinementGraph into LeylineNfs"
```

---

## Follow-on (after Plan 3): the end-to-end mount + Plan 2 transport spike

- Pair the mount bin with **Plan 2 Tasks 1–2** (guest reaches the leyline-fs NFS mount via libkrun virtio-fs, DAX off) to prove the full stack: `guest → virtio-fs → leyline-fs NFS (ConfinementGraph) → arena/CAS`.
- Wire `ReceiptSink` to cloister's real audit sink (the one `ProxyCallReceipt` uses) — same lease + receipt plane as the vault (ADR-0046).
- `validate-on-write`: leyline-fs's own `validate` feature (`splice_and_reproject`) handles AST validation; the ConfinementGraph adds the *authorization* layer above it. Confirm the division so they compose, not conflict.
