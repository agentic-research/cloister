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
    // Still the same property — a microvm plan must NOT silently fall back to
    // running on the host — but the failure now comes from LLO's backend being
    // unavailable rather than from `krunvm` missing on PATH (cloister-17e502).
    // The empty PATH stays: it is what makes "nothing was spawned" observable.
    let plan = write_plan(ExecutionMode::Microvm);
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .args(["run", plan.path().to_str().unwrap()])
        .env("PATH", "")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);

    // The PROPERTY is that a microvm plan never silently runs on the host. Both
    // builds satisfy it and they say so differently, so assert the property and
    // accept either wording rather than pinning one build's phrasing:
    //
    //   with `llo-execution`    — the backend exists and refuses ("launch refused")
    //   without it (default)    — no backend is compiled in at all (§17.1)
    //
    // Pinning "launch refused" made this fail on the default build for the one
    // reason that is not a defect: the feature gate working.
    let refused_by_backend = stderr.contains("launch refused");
    let no_backend_compiled = stderr.contains("no execution backend");
    assert!(
        refused_by_backend || no_backend_compiled,
        "a microvm plan must be refused, by one of the two honest routes: {stderr}"
    );
    // The load-bearing half, true of both: no fallback to host process
    // execution, and no trace of the retired shell-out.
    assert!(!stderr.contains("process execution"), "{stderr}");
    assert!(!stderr.to_lowercase().contains("krunvm"), "{stderr}");
}

#[test]
fn status_and_gc_are_retired_with_a_reason_rather_than_an_unknown_command() {
    // Their subject — krunvm's buildah storage volume — no longer exists
    // (cloister-17e502). They fail, but they say WHY, so an operator with the
    // old command in a script learns what replaced it instead of reading
    // "unknown command" and guessing at a typo.
    for command in ["status", "gc"] {
        let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
            .arg(command)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "{command} must fail");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("cloister-17e502"), "{command}: {stderr}");
        assert!(stderr.contains("ley-line-open"), "{command}: {stderr}");
    }
}

