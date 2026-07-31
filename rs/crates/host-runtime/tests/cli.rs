use cloister_host_runtime::{Artifact, Confinement, ConfinementPort, ExecutionMode, LaunchPlan};
use std::fs;
use std::process::Command;

fn write_plan(mode: ExecutionMode) -> tempfile::NamedTempFile {
    let file = tempfile::NamedTempFile::new().unwrap();
    let plan = LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "llo".into(),
        mode,
        artifact: Artifact {
            image: "ghcr.io/agentic-research/ley-line-open".into(),
            digest: format!("sha256:{}", "b".repeat(64)),
            entrypoint: "/usr/bin/leyline".into(),
            args: vec!["serve".into()],
        },
        confinement: Confinement {
            port: ConfinementPort {
                bind: 7532,
                address: "127.0.0.1".into(),
            },
            ..Confinement::default()
        },
        workspace: "/workspace".into(),
        control_socket: "/run/cloister/host.sock".into(),
    };
    fs::write(file.path(), serde_json::to_vec_pretty(&plan).unwrap()).unwrap();
    file
}

#[test]
fn validate_accepts_a_well_formed_plan() {
    let plan = write_plan(ExecutionMode::Microvm);
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .args(["validate", plan.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("valid"));
}

#[test]
fn run_uses_microvm_backend_without_host_process_fallback() {
    let plan = write_plan(ExecutionMode::Microvm);
    let storage = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .args(["run", plan.path().to_str().unwrap()])
        .env("CLOISTER_KRUNVM_VOLUME", storage.path())
        .env("PATH", "")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("running krunvm"), "{stderr}");
    assert!(!stderr.contains("process execution"), "{stderr}");
}

#[test]
fn status_reports_versioned_storage_json() {
    let storage = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .arg("status")
        .env("CLOISTER_KRUNVM_VOLUME", storage.path())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let status: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(status["schema"], "cloister/runtime-storage-status/v1");
    assert_eq!(status["state"], "prepared");
    assert_eq!(
        status["storageVolume"],
        storage.path().display().to_string()
    );
}
