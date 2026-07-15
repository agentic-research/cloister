// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ConfinementGraph — cloister's policy plane as a decorator over LLO's public
// `leyline_fs::graph::Graph` trait (ADR-0046 syscall adapter; ADR-0035 bridge).
// Every op: authorize (confinement/v1 policy) → (SkillLoadReceipt on reads) →
// delegate to the inner graph, or deny. No change to leyline-fs. Both
// `LeylineNfs::new` and `LeylineFuse::new` take `Arc<dyn Graph>`, so one decorator
// covers NFS (macOS) and FUSE (Linux).

use crate::policy::Policy;
use anyhow::{bail, Result};
use leyline_fs::graph::{Graph, Node};
use std::sync::Arc;

/// Where load events go (ADR-0043). Implemented cloister-side to write the
/// SkillLoadReceipt to the same audit sink the vault-proxy's ProxyCallReceipt uses.
pub trait ReceiptSink: Send + Sync {
    fn skill_load(&self, id: &str);
}

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
        if self.policy.allows_read(id) {
            Ok(())
        } else {
            bail!("confinement: read denied: {id}")
        }
    }
    fn deny_write(&self, id: &str) -> Result<()> {
        if self.policy.allows_write(id) {
            Ok(())
        } else {
            bail!("confinement: write denied: {id}")
        }
    }
    fn child_id(parent: &str, name: &str) -> String {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

impl Graph for ConfinementGraph {
    fn get_node(&self, id: &str) -> Result<Option<Node>> {
        self.deny_read(id)?;
        self.inner.get_node(id)
    }
    fn lookup_child(&self, parent: &str, name: &str) -> Result<Option<Node>> {
        self.deny_read(&Self::child_id(parent, name))?;
        self.inner.lookup_child(parent, name)
    }
    fn list_children(&self, parent: &str) -> Result<Vec<Node>> {
        self.deny_read(parent)?;
        self.inner.list_children(parent)
    }
    fn read_content(&self, id: &str, buf: &mut [u8], offset: u64) -> Result<usize> {
        self.deny_read(id)?;
        self.receipts.skill_load(id); // ADR-0043 load event, per content-addressed read
        self.inner.read_content(id, buf, offset)
    }
    fn write_content(&self, id: &str, data: &[u8], offset: u64) -> Result<usize> {
        self.deny_write(id)?;
        self.inner.write_content(id, data, offset)
    }
    fn create_node(&self, parent: &str, name: &str, is_dir: bool) -> Result<String> {
        self.deny_write(&Self::child_id(parent, name))?;
        self.inner.create_node(parent, name, is_dir)
    }
    fn remove_node(&self, id: &str) -> Result<()> {
        self.deny_write(id)?;
        self.inner.remove_node(id)
    }
    fn truncate(&self, id: &str) -> Result<()> {
        self.deny_write(id)?;
        self.inner.truncate(id)
    }
    fn rename_node(&self, id: &str, new_parent: &str, new_name: &str) -> Result<()> {
        self.deny_write(id)?;
        self.deny_write(&Self::child_id(new_parent, new_name))?;
        self.inner.rename_node(id, new_parent, new_name)
    }
    fn flush_node(&self, id: &str) -> Result<()> {
        // Delegate: leyline-fs's flush drives the validate-on-write splice reproject.
        self.inner.flush_node(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::receipt::RecordingSink;
    use leyline_fs::graph::{Graph, MemoryGraph, Node};

    fn node(id: &str, size: u64) -> Node {
        let name = id.rsplit('/').next().unwrap_or(id).to_string();
        Node { id: id.to_string(), name, is_dir: false, size, mtime_nanos: 0 }
    }

    fn inner() -> Arc<dyn Graph> {
        let mut g = MemoryGraph::new();
        g.add_node(node("/skills/x.md", 5), "/skills", Some(b"hello".to_vec()));
        g.add_node(node("/etc/secret", 3), "/etc", Some(b"top".to_vec()));
        g.add_node(node("/work/out.txt", 0), "/work", Some(Vec::new()));
        Arc::new(g)
    }

    fn ro_skills() -> Policy {
        Policy { read_prefixes: vec!["/skills".into()], write_prefixes: vec![] }
    }
    fn rw_work() -> Policy {
        Policy { read_prefixes: vec!["/work".into()], write_prefixes: vec!["/work".into()] }
    }

    #[test]
    fn read_allowed_delegates() {
        let cg = ConfinementGraph::new(inner(), ro_skills(), Arc::new(RecordingSink::default()));
        let mut buf = [0u8; 8];
        let n = cg.read_content("/skills/x.md", &mut buf, 0).unwrap();
        assert_eq!(&buf[..n], b"hello");
    }

    #[test]
    fn read_denied_outside_policy() {
        let cg = ConfinementGraph::new(inner(), ro_skills(), Arc::new(RecordingSink::default()));
        let mut buf = [0u8; 8];
        assert!(cg.read_content("/etc/secret", &mut buf, 0).is_err());
    }

    #[test]
    fn read_emits_exactly_one_load_receipt() {
        let sink = Arc::new(RecordingSink::default());
        let cg = ConfinementGraph::new(inner(), ro_skills(), sink.clone());
        let mut buf = [0u8; 8];
        cg.read_content("/skills/x.md", &mut buf, 0).unwrap();
        assert_eq!(sink.ids(), vec!["/skills/x.md".to_string()]);
    }

    #[test]
    fn denied_read_emits_no_receipt() {
        let sink = Arc::new(RecordingSink::default());
        let cg = ConfinementGraph::new(inner(), ro_skills(), sink.clone());
        let mut buf = [0u8; 8];
        let _ = cg.read_content("/etc/secret", &mut buf, 0);
        assert!(sink.ids().is_empty());
    }

    /// Minimal writable inner that records writes — isolates the decorator's
    /// delegation from MemoryGraph's own (read-oriented) write semantics.
    #[derive(Default)]
    struct WriteSpy {
        writes: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
    }
    impl Graph for WriteSpy {
        fn get_node(&self, _: &str) -> Result<Option<Node>> {
            Ok(None)
        }
        fn lookup_child(&self, _: &str, _: &str) -> Result<Option<Node>> {
            Ok(None)
        }
        fn list_children(&self, _: &str) -> Result<Vec<Node>> {
            Ok(vec![])
        }
        fn read_content(&self, _: &str, _: &mut [u8], _: u64) -> Result<usize> {
            Ok(0)
        }
        fn write_content(&self, id: &str, data: &[u8], _offset: u64) -> Result<usize> {
            self.writes.lock().unwrap().push((id.to_string(), data.to_vec()));
            Ok(data.len())
        }
    }

    #[test]
    fn write_allowed_on_rw_delegates_to_inner() {
        let spy = Arc::new(WriteSpy::default());
        let cg = ConfinementGraph::new(spy.clone(), rw_work(), Arc::new(RecordingSink::default()));
        let n = cg.write_content("/work/out.txt", b"ok", 0).unwrap();
        assert_eq!(n, 2);
        assert_eq!(spy.writes.lock().unwrap().len(), 1);
        assert_eq!(spy.writes.lock().unwrap()[0].0, "/work/out.txt");
    }

    #[test]
    fn write_denied_never_reaches_inner() {
        // ro policy → the write is denied by policy BEFORE the inner is touched.
        let spy = Arc::new(WriteSpy::default());
        let cg = ConfinementGraph::new(spy.clone(), ro_skills(), Arc::new(RecordingSink::default()));
        assert!(cg.write_content("/skills/x.md", b"tamper", 0).is_err());
        assert!(spy.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn write_denied_on_ro_prefix() {
        // ro on /skills, no write prefix → a write to /skills is denied by policy
        // BEFORE it reaches the inner graph.
        let cg = ConfinementGraph::new(inner(), ro_skills(), Arc::new(RecordingSink::default()));
        assert!(cg.write_content("/skills/x.md", b"tamper", 0).is_err());
    }
}
