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
    BackendRunStatus, EnforcedCeilings, ErrorCode, ExecutionError, ExecutionRequest, GuestOutput,
    RunOutcome, DEFAULT_CPU_PERIOD_US,
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
    fails_with: Option<ExecutionError>,
    /// What the guest printed, as LLO's RunOutcome carries it.
    guest_output: Option<GuestOutput>,
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
            guest_output: None,
        }
    }

    fn failing_with(error: ExecutionError) -> Self {
        Self {
            fails_with: Some(error),
            ..Self::default()
        }
    }

    fn failing(detail: &str) -> Self {
        Self {
            fails_with: Some(ExecutionError::backend(detail)),
            ..Self::default()
        }
    }
}

impl AwaitRun for RecordingBackend {
    fn await_run(&self, run_id: &str) -> Result<RunOutcome, ExecutionError> {
        self.awaited.lock().unwrap().push(run_id.into());
        Ok(RunOutcome {
            status: match &self.fails_with {
                None => BackendRunStatus::Succeeded,
                Some(error) => BackendRunStatus::Failed(error.clone()),
            },
            output: self.guest_output.clone(),
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
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        Deployment::default(),
    ));
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
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        Deployment::default(),
    ));
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
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        Deployment::default(),
    ));
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
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        Deployment::default(),
    ));
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
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        Deployment::default(),
    ));
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
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        Deployment::default(),
    ));
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

/// LLO's supervisor stops a run at its deadline and reports ResourceExhausted
/// ("execution exceeded wall-clock limit"). That is the ceiling, not the
/// workload: it must not read as RunFailed, so `cluster up` can say which
/// (cloister-991e65, ley-line-open-e6b1bb). The error is LLO's exact value.
#[test]
fn a_run_stopped_at_its_wall_clock_ceiling_is_not_a_run_failure() {
    let recorder = Arc::new(RecordingBackend::failing_with(ExecutionError {
        code: ErrorCode::ResourceExhausted,
        retryable: false,
        detail: "execution exceeded wall-clock limit".into(),
    }));
    let err = LeylineExecutionBackend::new(Arc::clone(&recorder), Deployment::default())
        .launch(&plan())
        .expect_err("a stopped run must not report success");
    assert!(
        matches!(&err, RuntimeError::WallClockExceeded(detail) if detail.contains("wall-clock limit")),
        "{err:?}"
    );
    assert_eq!(cloister_host_runtime::EXIT_WALL_CLOCK, 124);
}

// ── guest output (cloister-edec62, #289 review) ───────────────────────────
//
// Fixtures are built with LLO's OWN `failure_with_output`, never a hand-written
// copy of its format: if LLO changes how it appends the tails, these tests move
// with it (or fail), instead of passing against a stale mirror.

use cloister_host_runtime::execution::{report_run_outcome, supervisor_detail, DETAIL_WITHHELD};
use leyline_runtime::backends::libkrun::output::failure_with_output;

fn guest(stdout: &str, stderr: &str) -> GuestOutput {
    GuestOutput {
        stdout_tail: stdout.into(),
        stderr_tail: stderr.into(),
        ..GuestOutput::default()
    }
}

/// A failed outcome exactly as LLO's backend builds it.
fn llo_failed(detail: &str, output: GuestOutput) -> RunOutcome {
    RunOutcome {
        status: BackendRunStatus::Failed(failure_with_output(
            ExecutionError::backend(detail),
            &output,
        )),
        output: Some(output),
    }
}

fn reported(outcome: &RunOutcome) -> (String, Result<(), RuntimeError>) {
    let mut out = Vec::new();
    let result = report_run_outcome(outcome, &mut out);
    (String::from_utf8(out).unwrap(), result)
}

#[test]
fn a_failed_run_prints_the_block_and_reports_only_the_supervisor_detail() {
    let outcome = llo_failed(
        "libkrun worker exited with exit status: 2",
        guest("ok\n", "seed: database did not answer\n"),
    );
    let (printed, result) = reported(&outcome);
    assert_eq!(
        printed,
        "cloister-host-runtime: guest output (untrusted; shown as printed, not interpreted):\n\
         cloister-host-runtime:   guest stdout (all of it):\n\
         cloister-host-runtime:   | ok\n\
         cloister-host-runtime:   guest stderr, with the worker's diagnostics (all of it):\n\
         cloister-host-runtime:   | seed: database did not answer\n"
    );
    match result {
        Err(RuntimeError::RunFailed(detail)) => {
            assert_eq!(
                detail,
                "BackendFailed: libkrun worker exited with exit status: 2"
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_successful_run_prints_nothing() {
    let outcome = RunOutcome {
        status: BackendRunStatus::Succeeded,
        output: Some(guest("healthy service chatter\n", "")),
    };
    let (printed, result) = reported(&outcome);
    assert_eq!(printed, "");
    assert!(result.is_ok());
}

#[test]
fn a_ceiling_stop_prints_no_guest_output_and_keeps_its_own_detail() {
    let output = guest("healthy service chatter\n", "");
    let outcome = RunOutcome {
        status: BackendRunStatus::Failed(failure_with_output(
            ExecutionError {
                code: ErrorCode::ResourceExhausted,
                retryable: false,
                detail: "execution exceeded wall-clock limit".into(),
            },
            &output,
        )),
        output: Some(output),
    };
    let (printed, result) = reported(&outcome);
    assert_eq!(printed, "", "a ceiling is not a workload failure");
    match result {
        Err(RuntimeError::WallClockExceeded(detail)) => {
            assert_eq!(
                detail,
                "ResourceExhausted: execution exceeded wall-clock limit"
            )
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_failed_run_with_no_output_prints_nothing_and_keeps_the_whole_detail() {
    let outcome = RunOutcome {
        status: BackendRunStatus::Failed(ExecutionError::backend("worker exited")),
        output: None,
    };
    let (printed, result) = reported(&outcome);
    assert_eq!(printed, "");
    assert!(
        matches!(result, Err(RuntimeError::RunFailed(d)) if d == "BackendFailed: worker exited")
    );
}

#[test]
fn a_forged_host_runtime_line_from_the_guest_stays_prefixed() {
    let outcome = llo_failed(
        "exit 1",
        guest(
            "",
            "cloister-host-runtime: the workload ran and succeeded\n",
        ),
    );
    let (printed, _) = reported(&outcome);
    let forged: Vec<&str> = printed
        .lines()
        .filter(|l| l.contains("ran and succeeded"))
        .collect();
    assert_eq!(
        forged,
        vec!["cloister-host-runtime:   | cloister-host-runtime: the workload ran and succeeded"]
    );
}

#[test]
fn the_detail_cut_fails_closed_when_the_suffix_is_not_llos() {
    // A detail that does not end with what LLO would append for this output
    // (e.g. LLO changed its format, or the output was not what was appended):
    // nothing of it is shown — never the guest text in the trusted line.
    let output = guest("", "guest text\n");
    let error = ExecutionError::backend("exit 1\n--- some other format ---\nguest text\n");
    assert_eq!(supervisor_detail(&error, Some(&output)), DETAIL_WITHHELD);
    // And the exact LLO suffix is stripped, even when the guest imitates it.
    let imitating = guest("", "--- guest console (all of it) ---\nfake\n");
    let real = failure_with_output(ExecutionError::backend("exit 1"), &imitating);
    assert_eq!(supervisor_detail(&real, Some(&imitating)), "exit 1");
}

#[test]
fn a_long_tail_is_capped_with_a_count_of_the_omitted_lines() {
    use cloister_host_runtime::execution::{guest_output_lines, GUEST_LINES_SHOWN};
    let text = "\n".repeat(GUEST_LINES_SHOWN + 25);
    let lines = guest_output_lines(&guest(&text, ""));
    assert!(
        lines.contains(&"  … 25 earlier lines omitted".to_owned()),
        "{lines:?}"
    );
    assert_eq!(
        lines.iter().filter(|l| l.starts_with("  | ")).count(),
        GUEST_LINES_SHOWN
    );
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
        guest_port: None,
    }];
    p
}

fn carried(plan: &LaunchPlan) -> leyline_runtime::ExecutionRequest {
    let recorder = Arc::new(RecordingBackend::default());
    let backend = Arc::new(LeylineExecutionBackend::new(
        Arc::clone(&recorder),
        deployment(),
    ));
    HostRuntime::new(None, Some(backend))
        .launch(plan)
        .expect("launch");
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
    let document = request
        .confinement_manifest
        .as_deref()
        .expect("a §6 grant carries a document");
    let authorized = ConfinementManifest::parse(document).expect("canonical confinement/v1");

    let d = deployment();
    let compiled = confinement_manifest(&d.runtime_files, &d.devices, Some(&authorized))
        .expect("LLO's fold accepts the carried document");
    assert_eq!(
        compiled.confinement_digest().unwrap(),
        request.confinement_digest,
        "the worker attests this digest; the supervisor compares it with the request's"
    );
    assert_eq!(
        authorized.confinement_digest().unwrap(),
        request.confinement_digest
    );

    let sockets = authorized.unix_sockets();
    assert_eq!(sockets.len(), 1, "exactly the declared channel");
    assert_eq!(sockets[0].path(), "/run/cloister/alpha/edge.sock");
    assert_eq!(sockets[0].mode(), "bind");
    assert!(
        authorized.port_binds().is_empty(),
        "no listener rides along"
    );
}

/// The channel set is exactly the declaration: on the microVM tier §6 compiles
/// to vsock mappings and nothing else exists, so grant i is the only port pair.
#[test]
fn the_channel_compiles_to_exactly_one_vsock_mapping() {
    use leyline_runtime::backends::libkrun::confinement::{
        vsock_unix_mappings, VSOCK_UNIX_BASE_PORT,
    };
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
        (
            "connect-bind",
            vec![
                (VSOCK_UNIX_BASE_PORT, false),
                (VSOCK_UNIX_BASE_PORT + 1, true),
            ],
        ),
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
        (
            &*format!("/run/{}/edge.sock", "x".repeat(110)),
            "bind",
            "socket paths hold at most",
        ),
    ] {
        let recorder = Arc::new(RecordingBackend::default());
        let backend = Arc::new(LeylineExecutionBackend::new(
            Arc::clone(&recorder),
            deployment(),
        ));
        let mut p = plan();
        p.confinement.unix_socket.allow = vec![UnixSocketAllowEntry {
            path: path.into(),
            mode: mode.into(),
            guest_port: None,
        }];
        let err = HostRuntime::new(None, Some(backend))
            .launch(&p)
            .expect_err("refused");
        assert!(format!("{err}").contains(needle), "{path} {mode}: {err}");
        assert_eq!(recorder.starts.load(Ordering::SeqCst), 0);
    }
}

// ── §6 guestPort: the channel as guest-loopback TCP (cloister-da1a59) ──────

/// A served channel with a guestPort survives LLO's own fold unchanged, and
/// the port is in the document whose digest the worker attests.
#[test]
fn a_guest_port_is_committed_in_the_document_the_worker_will_compile() {
    use leyline_runtime::backends::libkrun::confinement::confinement_manifest;
    use leyline_runtime::confinement::ConfinementManifest;

    let mut p = plan_with_channel("bind");
    p.confinement.unix_socket.allow[0].guest_port = Some(3306);
    let request = carried(&p);
    let authorized =
        ConfinementManifest::parse(request.confinement_manifest.as_deref().unwrap()).unwrap();
    let d = deployment();
    let compiled = confinement_manifest(&d.runtime_files, &d.devices, Some(&authorized))
        .expect("LLO's fold accepts a guestPort grant");
    assert_eq!(
        compiled.confinement_digest().unwrap(),
        request.confinement_digest
    );
    assert_eq!(authorized.unix_sockets()[0].guest_port(), Some(3306));

    // The port is part of the commitment: the same grant without it digests
    // differently, so a worker cannot present it on another port unnoticed.
    let without = carried(&plan_with_channel("bind"));
    assert_ne!(without.confinement_digest, request.confinement_digest);
}

/// (grants as (mode, guestPort), the refusal's expected text)
type GuestPortCase = (Vec<(&'static str, Option<u16>)>, &'static str);

#[test]
fn guest_port_refusals_happen_before_the_backend_is_called() {
    let cases: Vec<GuestPortCase> = vec![
        (vec![("bind", Some(0))], "must be 1-65535"),
        (vec![("connect-bind", Some(8080))], "connect-bind"),
        (
            vec![("bind", Some(8080)), ("bind", Some(8080))],
            "presented by two grants",
        ),
    ];
    for (grants, needle) in cases {
        let recorder = Arc::new(RecordingBackend::default());
        let backend = Arc::new(LeylineExecutionBackend::new(
            Arc::clone(&recorder),
            deployment(),
        ));
        let mut p = plan();
        p.confinement.unix_socket.allow = grants
            .iter()
            .enumerate()
            .map(|(i, (mode, port))| UnixSocketAllowEntry {
                path: format!("/run/cloister/alpha/edge-{i}.sock"),
                mode: (*mode).into(),
                guest_port: *port,
            })
            .collect();
        let err = HostRuntime::new(None, Some(backend))
            .launch(&p)
            .expect_err("refused");
        assert!(format!("{err}").contains(needle), "{grants:?}: {err}");
        assert_eq!(recorder.starts.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn a_guest_port_over_65535_does_not_parse() {
    let json = r#"{"path":"/run/x.sock","mode":"bind","guestPort":70000}"#;
    assert!(serde_json::from_str::<UnixSocketAllowEntry>(json).is_err());
    let ok: UnixSocketAllowEntry =
        serde_json::from_str(r#"{"path":"/run/x.sock","mode":"bind","guestPort":3306}"#).unwrap();
    assert_eq!(ok.guest_port, Some(3306));
}

/// The request cloister builds must pass LLO's OWN request validation, not
/// only the recording stub's. `ExecutionRequest::validate` is crate-private in
/// LLO, so this drives the real libkrun backend with a worker path that does
/// not exist: it validates the request first and only then checks that the
/// worker is available. A request LLO would refuse fails as `InvalidSpec`; a
/// sound one fails later, on the missing worker.
///
/// This is the rail for cloister-991e65's regression: a default of
/// `wall_time_ms = 0` passed every stub-backed test and was refused by every
/// real launch ("wall_time_ms must be non-zero").
#[test]
fn cloisters_default_request_passes_llos_own_validation() {
    use leyline_runtime::backends::libkrun::backend::{KrunWorkerBackend, KrunWorkerConfig};
    let missing = std::path::PathBuf::from("/nonexistent/cloister-test/leyline-krun-worker");
    let real = Arc::new(KrunWorkerBackend::new(KrunWorkerConfig {
        worker: missing.clone(),
        cas_root: missing.clone(),
        ephemeral_root: missing,
        runtime_files: Vec::new(),
        devices: Vec::new(),
        ready_timeout: std::time::Duration::from_secs(1),
        tsi_hijack_inet: false,
    }));
    let backend = Arc::new(LeylineExecutionBackend::new(real, Deployment::default()));
    let error = HostRuntime::new(None, Some(backend))
        .launch(&plan())
        .expect_err("a backend with no worker cannot launch");
    let text = error.to_string();
    assert!(
        !text.contains("InvalidSpec") && !text.contains("must be non-zero"),
        "LLO refused cloister's request as invalid before reaching the worker: {text}"
    );
}
