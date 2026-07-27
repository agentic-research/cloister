use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use cloister_host_runtime::krunvm::{
    CommandOutput, CommandRunner, CommandSpec, KrunvmBackend, KrunvmSettings,
};
use cloister_host_runtime::{
    Artifact, Backend, Confinement, ConfinementPort, ExecutionMode, LaunchPlan,
};

#[derive(Clone, Default)]
struct RecordingRunner {
    calls: Arc<Mutex<Vec<CommandSpec>>>,
    outputs: Arc<Mutex<VecDeque<CommandOutput>>>,
}

impl RecordingRunner {
    fn with_outputs(outputs: Vec<CommandOutput>) -> Self {
        Self {
            calls: Arc::default(),
            outputs: Arc::new(Mutex::new(outputs.into())),
        }
    }

    fn programs(&self) -> Vec<Vec<String>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| {
                std::iter::once(call.program.clone())
                    .chain(call.args.clone())
                    .collect()
            })
            .collect()
    }
}

impl CommandRunner for RecordingRunner {
    fn run(&self, command: &CommandSpec) -> Result<CommandOutput, String> {
        self.calls.lock().unwrap().push(command.clone());
        self.outputs
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| format!("no fixture output for {command:?}"))
    }
}

fn ok(stdout: &str) -> CommandOutput {
    CommandOutput {
        success: true,
        stdout: stdout.into(),
        stderr: String::new(),
    }
}

fn fail(stderr: &str) -> CommandOutput {
    CommandOutput {
        success: false,
        stdout: String::new(),
        stderr: stderr.into(),
    }
}

fn plan() -> LaunchPlan {
    LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "mache".into(),
        mode: ExecutionMode::Microvm,
        artifact: Artifact {
            image: "ghcr.io/agentic-research/mache".into(),
            digest: format!("sha256:{}", "8".repeat(64)),
            entrypoint: "/usr/local/bin/mache".into(),
            args: vec!["version".into()],
        },
        confinement: Confinement {
            port: ConfinementPort {
                bind: 7532,
                address: "127.0.0.1".into(),
            },
            ..Confinement::default()
        },
        workspace: "/Users/operator/src".into(),
        control_socket: "/tmp/cloister/mache.sock".into(),
    }
}

fn inspect(plan: &LaunchPlan, platform: &str) -> String {
    serde_json::json!({
        "FromImage": format!("{}@{}", plan.artifact.image, plan.artifact.digest),
        "FromImageDigest": platform,
    })
    .to_string()
}

fn settings(storage: &std::path::Path) -> KrunvmSettings {
    KrunvmSettings {
        storage_volume: storage.into(),
        cpus: 1,
        memory_mib: 1024,
        dns: "1.1.1.1".into(),
        host_arch: "aarch64".into(),
        reserve_bytes: Some(0),
    }
}

#[test]
fn gc_deletes_known_vm_before_pruning_with_explicit_storage_roots() {
    let temp = tempfile::tempdir().unwrap();
    let first_plan = plan();
    let seed = RecordingRunner::with_outputs(vec![
        fail("not found"),
        ok("created"),
        ok(&inspect(&first_plan, "sha256:platform-one")),
        ok("done"),
    ]);
    KrunvmBackend::new(seed, settings(temp.path()))
        .launch(&first_plan)
        .unwrap();
    let mut current_plan = first_plan;
    current_plan.confinement.port.bind = 7533;
    let current = RecordingRunner::with_outputs(vec![
        fail("not found"),
        ok("created"),
        ok(&inspect(&current_plan, "sha256:platform-two")),
        ok("done"),
    ]);
    KrunvmBackend::new(current, settings(temp.path()))
        .launch(&current_plan)
        .unwrap();

    let runner = RecordingRunner::with_outputs(vec![ok("deleted"), ok("pruned")]);
    let backend = KrunvmBackend::new(runner.clone(), settings(temp.path()));
    let report = backend
        .gc(&Default::default(), &Default::default(), true)
        .unwrap();
    assert_eq!(report.plan.delete_vms.len(), 1);
    let calls = runner.programs();
    assert_eq!(calls[0][..2], ["krunvm", "delete"]);
    assert_eq!(calls[1][..2], ["buildah", "--root"]);
    assert_eq!(calls[1][2], temp.path().join("root").display().to_string());
    assert!(calls[1].contains(&"--runroot".into()));
    assert!(calls[1].contains(&temp.path().join("runroot").display().to_string()));
    assert_eq!(calls[1][calls[1].len() - 2..], ["rmi", "--prune"]);
}

#[test]
fn reserve_breach_refuses_create_after_gc() {
    let temp = tempfile::tempdir().unwrap();
    let plan = plan();
    let runner = RecordingRunner::with_outputs(vec![fail("not found")]);
    let mut settings = settings(temp.path());
    settings.reserve_bytes = Some(u64::MAX);
    let backend = KrunvmBackend::new(runner.clone(), settings);
    let error = backend.launch(&plan).unwrap_err();
    assert!(error.to_string().contains("storage reserve"), "{error}");
    assert!(!runner
        .programs()
        .iter()
        .any(|call| call.contains(&"create".into())));
}

#[test]
fn exact_state_reuses_vm_without_create() {
    let temp = tempfile::tempdir().unwrap();
    let plan = plan();

    let first_runner = RecordingRunner::with_outputs(vec![
        fail("not found"),
        ok("created"),
        ok(&inspect(&plan, "sha256:platform")),
        ok("mache 0.17.0"),
    ]);
    KrunvmBackend::new(first_runner, settings(temp.path()))
        .launch(&plan)
        .unwrap();

    let reuse_runner = RecordingRunner::with_outputs(vec![
        ok(&inspect(&plan, "sha256:platform")),
        ok("mache 0.17.0"),
    ]);
    let backend = KrunvmBackend::new(reuse_runner.clone(), settings(temp.path()));
    backend.launch(&plan).unwrap();
    let calls = reuse_runner.programs();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0][..2], ["krunvm", "inspect"]);
    assert_eq!(calls[1][..2], ["krunvm", "start"]);
    assert!(!calls.iter().any(|call| call.contains(&"create".into())));
}

#[test]
fn newly_created_vm_is_verified_before_start() {
    let temp = tempfile::tempdir().unwrap();
    let plan = plan();
    let runner = RecordingRunner::with_outputs(vec![
        fail("not found"),
        ok("created"),
        ok(&inspect(&plan, "sha256:platform")),
        ok("mache 0.17.0"),
    ]);
    let backend = KrunvmBackend::new(runner.clone(), settings(temp.path()));
    backend.launch(&plan).unwrap();
    let calls = runner.programs();
    assert_eq!(calls[0][..2], ["krunvm", "inspect"]);
    assert_eq!(calls[1][..2], ["krunvm", "create"]);
    assert_eq!(calls[2][..2], ["krunvm", "inspect"]);
    assert_eq!(calls[3][..2], ["krunvm", "start"]);
}

#[test]
fn inspect_source_mismatch_fails_closed_and_cleans_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let plan = plan();
    let runner = RecordingRunner::with_outputs(vec![
        fail("not found"),
        ok("created"),
        ok(&inspect(
            &LaunchPlan {
                artifact: Artifact {
                    image: "ghcr.io/attacker/image".into(),
                    ..plan.artifact.clone()
                },
                ..plan.clone()
            },
            "sha256:attacker",
        )),
        ok("deleted"),
    ]);
    let backend = KrunvmBackend::new(runner.clone(), settings(temp.path()));
    let error = backend.launch(&plan).unwrap_err();
    assert!(error.to_string().contains("source mismatch"), "{error}");
    let calls = runner.programs();
    assert_eq!(calls.last().unwrap()[..2], ["krunvm", "delete"]);
    assert!(!calls.iter().any(|call| call.contains(&"start".into())));
}

#[test]
fn failed_create_cleans_only_the_attempted_deterministic_vm() {
    let temp = tempfile::tempdir().unwrap();
    let plan = plan();
    let runner =
        RecordingRunner::with_outputs(vec![fail("not found"), fail("ENOSPC"), ok("not found")]);
    let backend = KrunvmBackend::new(runner.clone(), settings(temp.path()));
    let error = backend.launch(&plan).unwrap_err();
    assert!(error.to_string().contains("ENOSPC"), "{error}");
    let calls = runner.programs();
    assert_eq!(calls.last().unwrap()[..2], ["krunvm", "delete"]);
    assert_eq!(calls[1][4], calls[2][2]);
}
