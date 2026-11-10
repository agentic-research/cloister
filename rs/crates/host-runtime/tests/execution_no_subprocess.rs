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
// What this CANNOT prove, stated so nobody reads more into a green run: the real
// `KrunWorkerBackend` is never exercised here. This drives the API path —
// cloister's `Backend` → LLO's `Backend` — with a recording stub. That is the
// seam the bead is about; the VM is LLO's own test surface, upstream. (An
// earlier version said "no libkrun exists on macOS". It does — Homebrew ships
// libkrun + libkrunfw, and LLO's darwin-arm64 krun worker boots a guest there,
// cloister-991e65. The stub is a choice of test scope, not a platform limit.)

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use cloister_host_runtime::execution::{AwaitRun, Deployment, LeylineExecutionBackend};
use cloister_host_runtime::{
    Artifact, Backend, Confinement, ConfinementNetwork, ExecutionMode, HostRuntime, LaunchPlan,
    RuntimeError, UnixSocketAllowEntry,
};
use leyline_runtime::{
    Backend as LeylineBackendTrait, BackendCapabilities, BackendClass, BackendRun,
    BackendRunStatus, DEFAULT_CPU_PERIOD_US, EnforcedCeilings, ExecutionError, ExecutionRequest,
};

/// Records what cloister asked LLO to do, and nothing else happens.
///
/// `start` applies LLO's own per-tier ceiling check (`EnforcedCeilings::check`)
/// before recording, so a request a real tier would refuse by name is refused
/// here too — the stub cannot accept a limit the backend it stands for would not.
struct RecordingBackend {
    class: BackendClass,
    enforced: EnforcedCeilings,
    starts: AtomicUsize,
    seen: Mutex<Vec<ExecutionRequest>>,
    /// Run IDs `await_run` was asked about, in order.
    awaited: Mutex<Vec<String>>,
    /// What the run ends as. `None` = succeeded.
    fails_with: Option<String>,
}

impl Default for RecordingBackend {
    fn default() -> Self {
        Self::tier(BackendClass::MicroVm, EnforcedCeilings::hypervisor_backed())
    }
}

impl RecordingBackend {
    fn tier(class: BackendClass, enforced: EnforcedCeilings) -> Self {
        Self {
            class,
            enforced,
            starts: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
            awaited: Mutex::new(Vec::new()),
            fails_with: None,
        }
    }

    fn failing(detail: &str) -> Self {
        Self {
            fails_with: Some(detail.into()),
            ..Self::default()
        }
    }
}

impl AwaitRun for RecordingBackend {
    fn await_run(&self, run_id: &str) -> Result<BackendRunStatus, ExecutionError> {
        self.awaited.lock().unwrap().push(run_id.into());
        Ok(match &self.fails_with {
            None => BackendRunStatus::Succeeded,
            Some(detail) => BackendRunStatus::Failed(ExecutionError::backend(detail.clone())),
        })
    }
}

impl LeylineBackendTrait for RecordingBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            backend_id: "recording".into(),
            backend_class: self.class,
            available: true,
            unavailable_reason: None,
            enforced: self.enforced,
        }
    }

    fn start(&self, request: &ExecutionRequest) -> Result<BackendRun, ExecutionError> {
        self.enforced.check(&request.limits)?;
        self.starts.fetch_add(1, Ordering::SeqCst);
        self.seen.lock().unwrap().push(request.clone());
        Ok(BackendRun {
            backend_id: "recording".into(),
            channels: Vec::new(),
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
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default()));
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
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default()));
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

    // With no §6 grant, nothing is carried and LLO compiles its own policy.
    // cloister's other confinement dimensions describe a different tier and
    // are never sent as the document. See the module doc.
    assert!(request.confinement_manifest.is_none());
    assert!(request.confinement_digest.is_empty());
}

/// cloister-dac140: the request carries the execution/v1 OCI `ResourceLimits`
/// shape, and on the microVM tier every cloister default is one the hypervisor
/// can size exactly — whole MiB, whole vCPUs.
#[test]
fn microvm_launch_carries_oci_defaults_the_hypervisor_can_size() {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default()));
    HostRuntime::new(None, Some(backend))
        .launch(&plan())
        .expect("the microVM tier accepts cloister's defaults");

    let seen = recorder.seen.lock().unwrap();
    let limits = seen.first().expect("one request").limits;
    assert_eq!(limits.wall_time_ms, 15 * 60 * 1000);
    assert_eq!(limits.output_bytes, 0, "every tier refuses outputBytes");
    assert_eq!(limits.memory.limit, 1024 * 1024 * 1024);
    assert_eq!(limits.cpu.quota, 2 * DEFAULT_CPU_PERIOD_US);
    assert_eq!(limits.cpu.period, DEFAULT_CPU_PERIOD_US);
    assert_eq!(limits.pids.limit, 0, "libkrun does not enforce pids");
    assert_eq!(limits.memory.hypervisor_ram_mib().unwrap(), Some(1024));
    assert_eq!(limits.cpu.hypervisor_vcpus().unwrap(), Some(2));
    assert!(
        seen[0].workspaces.is_empty(),
        "a launch plan maps no Graph workspace authority"
    );
}

/// The native tier without a delegated cgroup root enforces only the wall
/// clock and refuses memory/cpu/pids by name. A cloister default is not
/// operator authority, so it must not turn every launch there into a refusal.
#[test]
fn native_wall_clock_only_launch_requests_only_the_wall_clock() {
    let recorder = Arc::new(RecordingBackend::tier(
        BackendClass::Native,
        EnforcedCeilings::wall_clock_only(),
    ));
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default()));
    HostRuntime::new(None, Some(backend))
        .launch(&plan())
        .expect("a wall-clock-only tier accepts the narrowed defaults");

    let limits = recorder.seen.lock().unwrap()[0].limits;
    assert_eq!(limits.wall_time_ms, 15 * 60 * 1000);
    assert_eq!(limits.memory.limit, 0);
    assert_eq!(limits.cpu.quota, 0);
    assert_eq!(
        limits.cpu.period, 0,
        "a period without a quota names no ceiling and is refused"
    );
    assert_eq!(limits.pids.limit, 0);
}

/// The stub really applies LLO's per-tier check: the microVM defaults handed to
/// a wall-clock-only tier are refused, naming memory.limit first in
/// ResourceLimits order — the refusal the oci-resources vector pins for native
/// macOS. Without this, the two tests above could pass against a stub that
/// accepts anything.
#[test]
fn the_recording_tier_refuses_a_ceiling_it_cannot_enforce() {
    let microvm = Arc::new(RecordingBackend::default());
    LeylineExecutionBackend::new(Arc::clone(&microvm), Deployment::default())
        .launch(&plan())
        .expect("microVM accepts");
    let microvm_request = microvm.seen.lock().unwrap()[0].clone();

    let native = RecordingBackend::tier(BackendClass::Native, EnforcedCeilings::wall_clock_only());
    let err = native
        .start(&microvm_request)
        .expect_err("native without a cgroup root refuses memory");
    assert!(format!("{err}").contains("memory.limit"), "{err}");
    assert_eq!(native.starts.load(Ordering::SeqCst), 0);
}

#[test]
fn unsupported_launch_grants_are_refused_before_the_backend_is_called() {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default()));
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
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default()));
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

/// cloister-991e65: `start` returning is READINESS, not completion. A launch
/// that reported success at readiness exited 0 for a guest whose outcome nobody
/// saw, and dropping the backend on exit cancelled the VM it had just started.
#[test]
fn launch_waits_for_the_run_it_started() {
    let recorder = Arc::new(RecordingBackend::default());
    LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default())
        .launch(&plan())
        .expect("a run that succeeds");
    let started = recorder.seen.lock().unwrap()[0].run_id.clone();
    assert_eq!(
        *recorder.awaited.lock().unwrap(),
        vec![started],
        "the launch waits on exactly the run it started"
    );
}

#[test]
fn a_run_that_fails_is_a_run_failure_not_a_refusal() {
    let recorder = Arc::new(RecordingBackend::failing("guest exited 3"));
    let err = LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default())
        .launch(&plan())
        .expect_err("a failed run must not report success");
    assert!(
        matches!(&err, RuntimeError::RunFailed(detail) if detail.contains("guest exited 3")),
        "{err:?}"
    );
    assert_eq!(recorder.starts.load(Ordering::SeqCst), 1, "it did start");
}

#[test]
fn a_refused_plan_is_never_awaited() {
    let recorder = Arc::new(RecordingBackend::default());
    let mut bad = plan();
    bad.artifact.digest = "not-a-digest".into();
    LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default())
        .launch(&bad)
        .expect_err("refused");
    assert!(recorder.awaited.lock().unwrap().is_empty());
}

// ── §6: a declared channel, and nothing else (cloister-77870d) ─────────────

fn deployment() -> Deployment {
    Deployment {
        runtime_files: vec!["/opt/homebrew/lib/libkrunfw.5.dylib".into()],
        devices: Vec::new(),
    }
}

fn plan_with_channel(mode: &str) -> LaunchPlan {
    let mut p = plan();
    p.confinement.unix_socket.allow = vec![UnixSocketAllowEntry {
        path: "/run/cloister/alpha/edge.sock".into(),
        mode: mode.into(),
    }];
    p
}

fn carried(plan: &LaunchPlan) -> leyline_runtime::ExecutionRequest {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), deployment()));
    HostRuntime::new(None, Some(backend)).launch(plan).expect("launch");
    let seen = recorder.seen.lock().unwrap();
    seen.first().expect("one request").clone()
}

/// The property LLO's worker enforces: it compiles its own document from the
/// deployment, folds §6 in from the carried one, and refuses unless the two are
/// EQUAL. Run that same fold here, with LLO's own compiler, on what cloister
/// sent — if it ever disagrees, the live run would be refused by name.
#[test]
fn a_declared_channel_is_carried_as_the_document_the_worker_will_compile() {
    use leyline_runtime::backends::libkrun::confinement::confinement_manifest;
    use leyline_runtime::confinement::ConfinementManifest;

    let request = carried(&plan_with_channel("bind"));
    let document = request.confinement_manifest.as_deref().expect("a §6 grant carries a document");
    let authorized = ConfinementManifest::parse(document).expect("canonical confinement/v1");

    let d = deployment();
    let compiled = confinement_manifest(&d.runtime_files, &d.devices, Some(&authorized))
        .expect("LLO's fold accepts the carried document");
    assert_eq!(
        compiled.confinement_digest().unwrap(),
        request.confinement_digest,
        "the worker attests this digest; the supervisor compares it with the request's"
    );
    assert_eq!(authorized.confinement_digest().unwrap(), request.confinement_digest);

    let sockets = authorized.unix_sockets();
    assert_eq!(sockets.len(), 1, "exactly the declared channel");
    assert_eq!(sockets[0].path(), "/run/cloister/alpha/edge.sock");
    assert_eq!(sockets[0].mode(), "bind");
    assert!(authorized.port_binds().is_empty(), "no listener rides along");
}

/// The channel set is exactly the declaration: on the microVM tier §6 compiles
/// to vsock mappings and nothing else exists, so grant i is the only port pair.
#[test]
fn the_channel_compiles_to_exactly_one_vsock_mapping() {
    use leyline_runtime::backends::libkrun::confinement::{vsock_unix_mappings, VSOCK_UNIX_BASE_PORT};
    use leyline_runtime::confinement::ConfinementManifest;

    // A connect grant names an endpoint someone else owns, and LLO refuses to
    // compile one whose socket is not bound yet (§6 ordering contract) — so
    // the dialing modes get a real peer to name.
    let dir = std::env::temp_dir().join(format!("cloister-edge-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let peer = dir.join("peer.sock");
    let _ = std::fs::remove_file(&peer);
    let _listener = std::os::unix::net::UnixListener::bind(&peer).unwrap();

    for (mode, expected) in [
        ("", vec![(VSOCK_UNIX_BASE_PORT, false)]),
        ("bind", vec![(VSOCK_UNIX_BASE_PORT + 1, true)]),
        ("connect-bind", vec![(VSOCK_UNIX_BASE_PORT, false), (VSOCK_UNIX_BASE_PORT + 1, true)]),
    ] {
        let mut p = plan_with_channel(mode);
        p.confinement.unix_socket.allow[0].path = peer.to_str().unwrap().into();
        let request = carried(&p);
        let manifest =
            ConfinementManifest::parse(request.confinement_manifest.as_deref().unwrap()).unwrap();
        let ports: Vec<(u32, bool)> = vsock_unix_mappings(&manifest)
            .expect("a leaf socket grant is deliverable")
            .iter()
            .map(|m| (m.port, m.listen))
            .collect();
        assert_eq!(ports, expected, "mode {mode:?}");
    }
}

#[test]
fn a_socket_tree_or_unknown_mode_is_refused_before_the_backend_is_called() {
    for (path, mode, needle) in [
        ("/run/cloister/alpha/", "bind", "socket path"),
        ("relative.sock", "bind", "socket path"),
        ("/run/cloister/alpha/edge.sock", "listen", "unixSocket mode"),
        // Over sun_path: libkrun would warn and run without the channel.
        (&*format!("/run/{}/edge.sock", "x".repeat(110)), "bind", "socket paths hold at most"),
    ] {
        let recorder = Arc::new(RecordingBackend::default());
        let backend = Arc::new(LeylineExecutionBackend::new(Arc::clone(&recorder), deployment()));
        let mut p = plan();
        p.confinement.unix_socket.allow =
            vec![UnixSocketAllowEntry { path: path.into(), mode: mode.into() }];
        let err = HostRuntime::new(None, Some(backend)).launch(&p).expect_err("refused");
        assert!(format!("{err}").contains(needle), "{path} {mode}: {err}");
        assert_eq!(recorder.starts.load(Ordering::SeqCst), 0);
    }
}
