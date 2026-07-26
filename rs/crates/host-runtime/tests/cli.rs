use cloister_host_runtime::{Artifact, Confinement, ExecutionMode, LaunchPlan};
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
        confinement: Confinement::default(),
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
fn run_refuses_microvm_when_backend_is_not_compiled() {
    let plan = write_plan(ExecutionMode::Microvm);
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .args(["run", plan.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("microvm execution backend is unavailable"),
        "{stderr}"
    );
    assert!(
        stderr.contains("refusing an unconstrained fallback"),
        "{stderr}"
    );
}
