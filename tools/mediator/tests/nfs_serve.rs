// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Integration: a ConfinementGraph serves end-to-end through leyline-fs's NFS
// presentation (ADR-0046 Plan 3 Task 5). Runs only with `--features nfs`.
#![cfg(feature = "nfs")]

use cloister_mediator::graph::ConfinementGraph;
use cloister_mediator::policy::Policy;
use cloister_mediator::receipt::RecordingSink;
use leyline_fs::graph::{Graph, MemoryGraph, Node};
use leyline_fs::nfs::serve_nfs;
use std::sync::Arc;

#[tokio::test]
async fn confinement_graph_serves_over_nfs() {
    let mut g = MemoryGraph::new();
    g.add_node(
        Node { id: "/skills/x".into(), name: "x".into(), is_dir: false, size: 2, mtime_nanos: 0 },
        "/skills",
        Some(b"ok".to_vec()),
    );
    let confined: Arc<dyn Graph> = Arc::new(ConfinementGraph::new(
        Arc::new(g),
        Policy { read_prefixes: vec!["/skills".into()], write_prefixes: vec![] },
        Arc::new(RecordingSink::default()),
    ));

    let (port, handle) = serve_nfs(confined, "127.0.0.1:0").await.expect("serve_nfs binds");
    assert!(port > 0, "the confined NFS server bound to a real port");
    handle.abort();
}
