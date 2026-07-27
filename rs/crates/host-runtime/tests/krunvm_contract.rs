use cloister_host_runtime::krunvm::{
    create_command, restriction_digest, start_command, vm_name, KrunvmSettings,
};
use cloister_host_runtime::{Artifact, Confinement, ConfinementPort, ExecutionMode, LaunchPlan};

fn plan() -> LaunchPlan {
    LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "mache".into(),
        mode: ExecutionMode::Microvm,
        artifact: Artifact {
            image: "ghcr.io/agentic-research/mache".into(),
            digest: format!("sha256:{}", "8".repeat(64)),
            entrypoint: "/usr/local/bin/mache".into(),
            args: vec!["serve".into(), "--http".into(), "127.0.0.1:7532".into()],
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

fn settings() -> KrunvmSettings {
    KrunvmSettings {
        storage_volume: "/Volumes/krunvm".into(),
        cpus: 1,
        memory_mib: 1024,
        dns: "1.1.1.1".into(),
        host_arch: "aarch64".into(),
        reserve_bytes: None,
    }
}

#[test]
fn start_only_arguments_do_not_duplicate_persistent_vm_state() {
    let base = plan();
    let mut changed = base.clone();
    changed.artifact.args.push("--verbose".into());
    assert_eq!(
        restriction_digest(&base, &settings()).unwrap(),
        restriction_digest(&changed, &settings()).unwrap()
    );
}

#[test]
fn every_persistent_input_changes_the_restriction() {
    let base = plan();
    let digest = restriction_digest(&base, &settings()).unwrap();

    let mut port = base.clone();
    port.confinement.port.bind = 7533;
    assert_ne!(digest, restriction_digest(&port, &settings()).unwrap());

    let mut workspace = base.clone();
    workspace.workspace = "/Users/operator/other".into();
    assert_ne!(digest, restriction_digest(&workspace, &settings()).unwrap());

    let mut image = base.clone();
    image.artifact.digest = format!("sha256:{}", "9".repeat(64));
    assert_ne!(digest, restriction_digest(&image, &settings()).unwrap());

    let mut cpu = settings();
    cpu.cpus = 2;
    assert_ne!(digest, restriction_digest(&base, &cpu).unwrap());

    let mut memory = settings();
    memory.memory_mib = 2048;
    assert_ne!(digest, restriction_digest(&base, &memory).unwrap());
}

#[test]
fn deterministic_name_and_commands_use_only_pinned_upstream_inputs() {
    let plan = plan();
    let settings = settings();
    let digest = restriction_digest(&plan, &settings).unwrap();
    let name = vm_name(&plan.bundle, &digest);
    assert!(name.starts_with("cloister-mache-"));
    assert_eq!(name.len(), "cloister-mache-".len() + 12);

    let create = create_command(&plan, &settings).unwrap();
    assert_eq!(create.program, "krunvm");
    assert_eq!(
        create.args,
        vec![
            "create",
            &format!("{}@{}", plan.artifact.image, plan.artifact.digest),
            "--name",
            &name,
            "--cpus",
            "1",
            "--mem",
            "1024",
            "--dns",
            "1.1.1.1",
            "--workdir",
            "/workspace",
            "--volume",
            "/Users/operator/src:/workspace",
            "--port",
            "7532:7532",
        ]
    );

    let start = start_command(&plan, &settings).unwrap();
    assert_eq!(start.program, "krunvm");
    assert_eq!(
        start.args,
        vec![
            "start",
            &name,
            "--",
            "/usr/local/bin/mache",
            "serve",
            "--http",
            "127.0.0.1:7532",
        ]
    );
}

#[test]
fn command_contract_rejects_non_loopback_or_missing_ports() {
    let mut external = plan();
    external.confinement.port.address = "0.0.0.0".into();
    assert!(create_command(&external, &settings()).is_err());

    let mut missing = plan();
    missing.confinement.port.bind = 0;
    assert!(create_command(&missing, &settings()).is_err());
}
