// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-991e65 (S4): who creates `--channel-dir`. LLO does not — its
// pre-start check refuses a serve mapping whose directory is missing — so the
// host runtime creates bind grants' parent directories, 0700, before a launch.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use cloister_host_runtime::{
    prepare_channel_dirs, Artifact, Confinement, ExecutionMode, LaunchPlan, RuntimeError,
    UnixSocketAllowEntry,
};

fn plan(grants: Vec<(&Path, &str)>) -> LaunchPlan {
    let mut confinement = Confinement::default();
    confinement.unix_socket.allow = grants
        .into_iter()
        .map(|(path, mode)| UnixSocketAllowEntry {
            path: path.to_str().unwrap().into(),
            mode: mode.into(),
            guest_port: None,
        })
        .collect();
    LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "orders".into(),
        mode: ExecutionMode::Microvm,
        artifact: Artifact {
            image: "ghcr.io/example/orders".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "/bin/orders".into(),
            args: Vec::new(),
        },
        confinement,
        workspace: "/tmp/workspace".into(),
        control_socket: "/tmp/control.sock".into(),
    }
}

#[test]
fn missing_parents_of_a_bind_grant_are_created_0700() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("ch/nested");
    prepare_channel_dirs(&plan(vec![(&dir.join("orders.grpc.sock"), "bind")])).unwrap();
    for created in [root.path().join("ch"), dir.clone()] {
        let mode = std::fs::metadata(&created).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{} is {mode:o}", created.display());
    }
    assert!(!dir.join("orders.grpc.sock").exists(), "only the directory, never the socket");
}

#[test]
fn a_connect_grant_creates_nothing_its_peer_owns_the_directory() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("peer");
    prepare_channel_dirs(&plan(vec![(&dir.join("dolt.mysql.sock"), "")])).unwrap();
    assert!(!dir.exists());
}

#[test]
fn an_existing_directory_is_left_with_its_own_mode() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("ch");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o750)).unwrap();
    prepare_channel_dirs(&plan(vec![(&dir.join("a.sock"), "connect-bind")])).unwrap();
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o750);
}

#[test]
fn a_parent_that_is_not_a_directory_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("ch");
    std::fs::write(&file, b"not a dir").unwrap();
    let err = prepare_channel_dirs(&plan(vec![(&file.join("a.sock"), "bind")])).unwrap_err();
    assert!(
        matches!(&err, RuntimeError::InvalidPlan(m) if m.contains("exists but is not a directory")),
        "{err}"
    );

    let link = root.path().join("link");
    std::os::unix::fs::symlink(root.path(), &link).unwrap();
    let err = prepare_channel_dirs(&plan(vec![(&link.join("a.sock"), "bind")])).unwrap_err();
    assert!(matches!(err, RuntimeError::InvalidPlan(_)), "a symlinked parent is refused, not followed");
}
