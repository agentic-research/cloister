use cloister_host_runtime::{
    Artifact, Backend, Confinement, EnvVar, ExecutionMode, HostRuntime, LaunchPlan, RuntimeError,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
struct SpyBackend {
    calls: AtomicUsize,
}

impl Backend for SpyBackend {
    fn launch(&self, _plan: &LaunchPlan) -> Result<(), RuntimeError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn plan(mode: ExecutionMode) -> LaunchPlan {
    LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "mache".into(),
        mode,
        artifact: Artifact {
            image: "ghcr.io/agentic-research/mache".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
            entrypoint: "/usr/bin/mache".into(),
            args: vec!["serve".into()],
        },
        confinement: Confinement::default(),
        workspace: "/workspace".into(),
        control_socket: "/run/cloister/host.sock".into(),
        environment: Vec::new(),
    }
}

#[test]
fn microvm_never_falls_back_to_the_process_backend() {
    let process = Arc::new(SpyBackend::default());
    let runtime = HostRuntime::new(Some(process.clone()), None);

    let err = runtime.launch(&plan(ExecutionMode::Microvm)).unwrap_err();
    assert!(matches!(
        err,
        RuntimeError::BackendUnavailable(ExecutionMode::Microvm)
    ));
    assert_eq!(process.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn process_mode_selects_only_the_process_backend() {
    let process = Arc::new(SpyBackend::default());
    let microvm = Arc::new(SpyBackend::default());
    let runtime = HostRuntime::new(Some(process.clone()), Some(microvm.clone()));

    runtime.launch(&plan(ExecutionMode::Process)).unwrap();
    assert_eq!(process.calls.load(Ordering::SeqCst), 1);
    assert_eq!(microvm.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn launch_plan_rejects_mutable_microvm_artifacts() {
    let mut plan = plan(ExecutionMode::Microvm);
    plan.artifact.digest.clear();
    let err = plan.validate().unwrap_err();
    assert!(err.to_string().contains("immutable sha256 digest"));
}

#[test]
fn launch_plan_rejects_relative_workspace_paths() {
    let mut plan = plan(ExecutionMode::Microvm);
    plan.workspace = "relative".into();
    let err = plan.validate().unwrap_err();
    assert!(err.to_string().contains("workspace"));
}

#[test]
fn launch_plan_rejects_non_canonical_paths_instead_of_normalizing_policy() {
    let mut ambiguous_workspace = plan(ExecutionMode::Microvm);
    ambiguous_workspace.workspace = "/workspace/../secret".into();
    let err = ambiguous_workspace.validate().unwrap_err();
    assert!(err.to_string().contains("canonical"), "{err}");

    let mut ambiguous_guest_path = plan(ExecutionMode::Microvm);
    ambiguous_guest_path.artifact.entrypoint = "/usr/bin/../bin/mache".into();
    let err = ambiguous_guest_path.validate().unwrap_err();
    assert!(err.to_string().contains("canonical"), "{err}");
}

#[test]
fn launch_plan_json_uses_manifest_compatible_camel_case_fields() {
    let mut plan = plan(ExecutionMode::Microvm);
    plan.confinement.credential_source = "vault".into();
    plan.confinement.network.allow_hosts = vec!["api.openai.com".into()];

    let json = serde_json::to_value(plan).unwrap();
    assert_eq!(json["controlSocket"], "/run/cloister/host.sock");
    assert_eq!(json["confinement"]["credentialSource"], "vault");
    assert_eq!(
        json["confinement"]["network"]["allowHosts"][0],
        "api.openai.com"
    );
    assert!(json.get("control_socket").is_none());
}

fn var(name: &str, value: &str) -> EnvVar {
    EnvVar {
        name: name.into(),
        value: value.into(),
    }
}

#[test]
fn validate_refuses_a_malformed_environment_by_name_and_never_value() {
    let secret = "s3cret-value";
    let cases: Vec<(&str, Vec<EnvVar>, &str)> = vec![
        ("empty name", vec![var("", secret)], "must not be empty"),
        ("name with =", vec![var("A=B", secret)], "A=B"),
        ("NUL in name", vec![var("A\0B", secret)], "NUL"),
        (
            "NUL in value",
            vec![var("GOOD", &format!("{secret}\0x"))],
            "GOOD",
        ),
        (
            "duplicate name",
            vec![var("DUP", secret), var("DUP", "b")],
            "declared twice",
        ),
    ];
    for (label, environment, expect) in cases {
        let mut p = plan(ExecutionMode::Microvm);
        p.environment = environment;
        let err = p.validate().expect_err(label);
        assert!(matches!(err, RuntimeError::InvalidPlan(_)), "{label}");
        let text = err.to_string();
        assert!(text.contains(expect), "{label}: {text}");
        assert!(!text.contains(secret), "{label}: leaked the value: {text}");
    }
    let mut ok = plan(ExecutionMode::Microvm);
    ok.environment = vec![var("A", "1"), var("B", "")];
    ok.validate().expect("a sound environment validates");
}
