#![cfg(feature = "llo-execution")]
//
// Gated with the backend it exercises (threat model §17.1): without
// `llo-execution` there is no LLO runtime linked, so there is nothing here to
// test rather than something failing.

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cloister-17e502 acceptance: a launch reaches LLO's first-party execution API
// and spawns NO subprocess.
//
// The bead asks for exactly this, and the second half is the one worth proving.
// `krunvm.rs` shelled out to `krunvm` and `buildah`, which made confinement
// depend on two binaries being on PATH — with "command not found" standing in
// for "this workload is not confined". A test that only checked the happy path
// would pass equally well against the old backend.
//
// What this CANNOT prove, stated so nobody reads more into a green run: no
// libkrun exists on macOS, so the real `KrunWorkerBackend` is never exercised
// here. This drives the API path — cloister's `Backend` → LLO's `Backend` —
// with a recording stub. That is the seam the bead is about; the VM is LLO's
// own test surface, upstream.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cloister_host_runtime::execution::LeylineExecutionBackend;
use cloister_host_runtime::{
    Artifact, Backend, Confinement, ConfinementNetwork, ExecutionMode, HostRuntime, LaunchPlan,
};
use leyline_runtime::{
    Backend as LeylineBackendTrait, BackendCapabilities, BackendClass, BackendRun,
    EnforcedCeilings, ExecutionError, ExecutionRequest,
};

/// Records what cloister asked LLO to do, and nothing else happens.
#[derive(Default)]
struct RecordingBackend {
    starts: AtomicUsize,
    seen: Mutex<Vec<ExecutionRequest>>,
}

impl LeylineBackendTrait for RecordingBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            backend_id: "recording".into(),
            backend_class: BackendClass::MicroVm,
            available: true,
            enforced: EnforcedCeilings::hypervisor_backed(),
        }
    }

    fn start(&self, request: &ExecutionRequest) -> Result<BackendRun, ExecutionError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(request.clone());
        Ok(BackendRun {
            backend_id: "recording".into(),
        })
    }

    fn cancel(&self, _run_id: &str) -> Result<bool, ExecutionError> {
        Ok(true)
    }
}

fn plan() -> LaunchPlan {
    LaunchPlan {
        schema: "cloister/host-runtime/v1".into(),
        bundle: "alpha".into(),
        mode: ExecutionMode::Microvm,
        artifact: Artifact {
            image: "ghcr.io/example/alpha".into(),
            digest: format!("blake3-256:{}", "a".repeat(64)),
            entrypoint: "/bin/agent".into(),
            args: vec!["--once".into()],
        },
        confinement: Confinement {
            network: ConfinementNetwork::default(),
            ..Default::default()
        },
        workspace: "/tmp/workspace".into(),
        control_socket: "/tmp/control.sock".into(),
    }
}

#[test]
fn launch_reaches_the_llo_api_without_spawning_anything() {
    // PATH is emptied for the duration. If any code path still shelled out to
    // `krunvm` or `buildah`, it would fail to resolve them and the launch would
    // error — so a successful launch under an empty PATH is the assertion, not
    // just a successful launch.
    let original = std::env::var_os("PATH");
    unsafe { std::env::set_var("PATH", "") };

    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder)));
    let result = HostRuntime::new(None, Some(backend)).launch(&plan());

    match &original {
        Some(value) => unsafe { std::env::set_var("PATH", value) },
        None => unsafe { std::env::remove_var("PATH") },
    }

    result.expect("launch must succeed with no PATH — nothing may be spawned");
    assert_eq!(
        recorder.starts.load(Ordering::SeqCst),
        1,
        "LLO's start() is the one call"
    );
}

#[test]
fn the_plan_is_translated_rather_than_passed_through() {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder)));
    HostRuntime::new(None, Some(backend))
        .launch(&plan())
        .expect("launch");

    let seen = recorder.seen.lock().unwrap();
    let request = seen.first().expect("one request");

    // The digest is SPLIT into DigestRef, not copied whole. A pass-through
    // would leave `algorithm` empty and `value` carrying the "blake3-256:" prefix,
    // which LLO would then compare against a bare hex digest and never match.
    assert_eq!(request.rootfs.algorithm, "blake3-256");
    assert_eq!(request.rootfs.value, "a".repeat(64));

    assert_eq!(request.executable, "bin/agent");
    assert_eq!(request.arguments, vec!["--once".to_string()]);
    assert!(request.allowed_egress.is_empty());

    // And the confinement document is deliberately ABSENT — cloister's
    // confinement describes a different tier than LLO's compiled policy, and
    // pairing them is refused by the equality contract. See the module doc.
    assert!(
        request.confinement_manifest.is_none(),
        "carrying cloister's own confinement would be refused at the fold, by name"
    );
}

#[test]
fn unsupported_launch_grants_are_refused_before_the_backend_is_called() {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder)));
    let mut unsupported = plan();
    unsupported.confinement.network.allow_hosts = vec!["api.example.com".into()];
    let err = HostRuntime::new(None, Some(backend))
        .launch(&unsupported)
        .expect_err("unsupported authority must fail closed");
    assert!(format!("{err}").contains("egress grants"));
    assert_eq!(recorder.starts.load(Ordering::SeqCst), 0);
}

#[test]
fn a_malformed_artifact_digest_is_refused_before_the_backend_is_called() {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder)));
    let mut bad = plan();
    bad.artifact.digest = "not-a-digest".into();

    // Fails in translation, not inside LLO — so the error names cloister's plan
    // rather than surfacing as an opaque backend error one layer down.
    let err = backend
        .launch(&bad)
        .expect_err("a digest with no algorithm must be refused");
    assert!(
        format!("{err}").contains("not-a-digest"),
        "the error names the offending value"
    );
    assert_eq!(
        recorder.starts.load(Ordering::SeqCst),
        0,
        "the backend is never reached"
    );
}
