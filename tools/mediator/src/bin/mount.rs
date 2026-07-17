// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-mediator mount — stands up leyline-fs's NFS presentation over a
// ConfinementGraph (ADR-0046 syscall adapter, Plan 3 Task 5). Requires the `nfs`
// feature (macOS-native nfsserve). The DEMO path serves a MemoryGraph; the real
// path takes a mache-populated leyline-fs arena (from_arena / SqliteGraphAdapter)
// and a §7-verified confinement/v1 policy — the last-mile integration that pairs
// with `task spike:libkrun` (the guest mounts this over virtio-fs).

#[cfg(not(feature = "nfs"))]
fn main() {
    eprintln!("cloister-mediator mount: build with `--features nfs` to run (pulls nfsserve).");
    std::process::exit(2);
}

#[cfg(feature = "nfs")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use cloister_mediator::graph::ConfinementGraph;
    use cloister_mediator::policy::Policy;
    use cloister_mediator::receipt::StderrReceiptSink;
    use leyline_fs::graph::{Graph, MemoryGraph, Node};
    use leyline_fs::nfs::serve_nfs;
    use std::sync::Arc;

    // Demo inner graph. The real path replaces this with a leyline-fs arena
    // (from_arena / SqliteGraphAdapter) that mache populates, and the Policy is
    // parsed from the §7-verified confinement/v1 manifest.
    let mut g = MemoryGraph::new();
    g.add_node(
        Node { id: "/skills/demo.md".into(), name: "demo.md".into(), is_dir: false, size: 11, mtime_nanos: 0 },
        "/skills",
        Some(b"hello world".to_vec()),
    );
    let policy = Policy { read_prefixes: vec!["/skills".into()], write_prefixes: vec![] };
    let confined: Arc<dyn Graph> =
        Arc::new(ConfinementGraph::new(Arc::new(g), policy, Arc::new(StderrReceiptSink)));

    let (port, handle) = serve_nfs(confined, "127.0.0.1:0").await?;
    eprintln!("cloister-mediator: confined NFS server on 127.0.0.1:{port}");
    eprintln!("  reads outside the policy allowlist are denied; loads emit receipts.");
    eprintln!("  mount (macOS): sudo mount -t nfs -o vers=3,tcp,port={port},mountport={port},noac 127.0.0.1:/ /mnt");
    handle.await?;
    Ok(())
}
