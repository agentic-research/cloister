// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-991e65 (S5): one fixture, two parsers. test/fixtures/runtime-plan/
// holds the exact plans `cloister runtime plan` emits for the dolt/orders
// fixture; scripts/test/declared-connections.test.mjs asserts the JS emitter
// still produces them byte for byte. Here the Rust side loads the SAME files,
// so a drift between emitter and parser fails a test on one side or the other.

use std::path::PathBuf;

use cloister_host_runtime::LaunchPlan;

fn fixture(bundle: &str) -> LaunchPlan {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/runtime-plan")
        .join(format!("{bundle}.plan.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

#[test]
fn the_emitted_plans_parse_and_validate() {
    for bundle in ["dolt", "orders"] {
        let plan = fixture(bundle);
        plan.validate().unwrap_or_else(|e| panic!("{bundle}: {e}"));
        assert_eq!(plan.bundle, bundle);
    }
}

#[test]
fn the_two_plans_join_on_one_socket_path() {
    let dolt = fixture("dolt");
    let orders = fixture("orders");
    let bind = &dolt.confinement.unix_socket.allow[0];
    let connect = orders
        .confinement
        .unix_socket
        .allow
        .iter()
        .find(|g| g.mode.is_empty())
        .expect("orders connects to dolt");
    assert_eq!(bind.mode, "bind");
    assert_eq!(connect.path, bind.path);
    assert_eq!(connect.guest_port, bind.guest_port);
    assert_eq!(connect.guest_port, Some(3306));
}

#[cfg(feature = "llo-execution")]
#[test]
fn carried_confinement_accepts_the_emitted_plans_and_llo_folds_them() {
    use cloister_host_runtime::execution::{carried_confinement, Deployment};
    use leyline_runtime::backends::libkrun::confinement::confinement_manifest;
    use leyline_runtime::confinement::ConfinementManifest;

    let deployment = Deployment {
        runtime_files: vec!["/opt/homebrew/lib/libkrunfw.5.dylib".into()],
        devices: Vec::new(),
    };
    for bundle in ["dolt", "orders"] {
        let plan = fixture(bundle);
        let (digest, document) = carried_confinement(&plan, &deployment)
            .unwrap_or_else(|e| panic!("{bundle}: {e}"));
        let document = document.expect("a plan with grants carries a document");
        let authorized = ConfinementManifest::parse(&document).expect("canonical confinement/v1");
        let compiled = confinement_manifest(
            &deployment.runtime_files,
            &deployment.devices,
            Some(&authorized),
        )
        .expect("LLO's fold accepts the carried document");
        assert_eq!(compiled.confinement_digest().unwrap(), digest, "{bundle}");
        let sockets = authorized.unix_sockets();
        assert_eq!(sockets.len(), plan.confinement.unix_socket.allow.len(), "{bundle}");
        for (socket, grant) in sockets.iter().zip(&plan.confinement.unix_socket.allow) {
            assert_eq!(socket.path(), grant.path);
            assert_eq!(socket.guest_port(), grant.guest_port);
        }
    }
}
