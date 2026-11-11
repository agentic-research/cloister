// SPDX-License-Identifier: AGPL-3.0-or-later
//
// execution — cloister's `Backend` implemented over LLO's first-party execution
// API, replacing the krunvm shell-out (cloister-17e502, ADR-0049).
//
// The whole point is the absence of a subprocess. `krunvm.rs` drove `krunvm` and
// `buildah` through `SystemCommandRunner`, which made cloister's isolation story
// depend on two binaries being on `PATH` at the right versions, with the failure
// mode "command not found" standing in for "this workload is not confined".
// LLO's `Backend` trait is in-process: cloister links it, calls it, and there is
// no PATH, no argv quoting, and no exit-status-to-error translation.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use leyline_runtime::backends::libkrun::backend::KrunWorkerBackend;
use leyline_runtime::backends::libkrun::confinement::confinement_manifest;
use leyline_runtime::backends::libkrun::output::failure_with_output;
use leyline_runtime::confinement::UnixSocketGrant;
use leyline_runtime::{
    Backend as LeylineBackendTrait, BackendRunStatus, CpuLimits, DigestRef, EnforcedCeilings,
    ErrorCode, ExecutionError, ExecutionRequest, GuestOutput, MemoryLimits, PidsLimits,
    ResourceLimits, RunOutcome, DEFAULT_CPU_PERIOD_US,
};

use crate::{Backend, LaunchPlan, RuntimeError};

/// Default ceilings for a launch plan, which carries none of its own.
///
/// `LaunchPlan` is cloister's operator surface and deliberately does not model
/// vcpus/memory/wall-time — those are deployment properties, not per-bundle
/// ones. They are supplied here and named as a cloister default rather than
/// smuggled in as if the operator had asked for them.
///
/// LLO v0.21 (execution/v1 OCI `ResourceLimits`) states memory in bytes and CPU
/// as an OCI quota/period pair; zero means "no ceiling" on every field. The
/// microVM tier sizes whole MiB and whole vCPUs, so both defaults are exact
/// multiples: 1024 MiB, and two periods of quota per period (two vCPUs).
const DEFAULT_VCPUS: u64 = 2;
const DEFAULT_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_WALL_TIME_MS: u64 = 15 * 60 * 1000;

/// cloister's default ceilings, restricted to the ones `enforced` applies.
///
/// Every LLO tier refuses, by name, a non-zero ceiling it cannot enforce
/// (ADR-0035 §4): `outputBytes` everywhere, and memory/cpu/pids on the native
/// tier without a delegated cgroup root. A cloister DEFAULT is not operator
/// authority, so asking for one the tier cannot apply would turn every launch
/// on that tier into a refusal over a number nobody requested. The defaults are
/// therefore requested only where the backend declares a mechanism for them.
///
/// This narrows nothing the operator asked for — `LaunchPlan` asks for nothing
/// here — and the receipt still records the mechanism LLO actually applied.
/// `outputBytes` and `pids` carry no cloister default (there was none before
/// the OCI migration either), so they stay zero.
fn default_limits(enforced: &EnforcedCeilings) -> ResourceLimits {
    let when = |mechanism: leyline_runtime::CeilingMechanism, value: u64| {
        if mechanism.is_enforced() {
            value
        } else {
            0
        }
    };
    let quota = when(enforced.cpu, DEFAULT_VCPUS * DEFAULT_CPU_PERIOD_US);
    ResourceLimits {
        wall_time_ms: when(enforced.wall_time, DEFAULT_WALL_TIME_MS),
        output_bytes: 0,
        memory: MemoryLimits {
            limit: when(enforced.memory, DEFAULT_MEMORY_BYTES),
        },
        cpu: CpuLimits {
            quota,
            // A period without a quota names no ceiling and LLO refuses it.
            period: if quota == 0 { 0 } else { DEFAULT_CPU_PERIOD_US },
        },
        pids: PidsLimits { limit: 0 },
    }
}

/// cloister's `Backend`, served by an LLO execution backend.
///
/// Generic over LLO's trait rather than pinned to `KrunWorkerBackend`, because
/// the two LLO backends (`KrunWorkerBackend`, `NativeWorkerBackend`) map exactly
/// onto cloister's two `ExecutionMode`s, and `HostRuntime` already dispatches on
/// mode. Pinning the concrete type here would rebuild that dispatch a second
/// time in a second place.
pub struct LeylineExecutionBackend<B: LeylineBackendTrait + AwaitRun> {
    inner: Arc<B>,
    deployment: Deployment,
    /// Where `launch` is in starting the run, so a stop that arrives while
    /// LLO is still starting it waits for start to settle instead of
    /// cancelling a run LLO has not published yet (see `cancel`).
    start: Arc<(Mutex<StartPhase>, Condvar)>,
}

/// `launch`'s progress through LLO's `start`, as `cancel` needs to see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartPhase {
    /// `start` has not been called. A stop now means it never will be.
    NotStarted,
    /// `start` is in progress: LLO has not published the run yet.
    Starting,
    /// `start` returned Ok: the run exists and can be cancelled.
    Started,
    /// `start` returned an error: there is no run.
    StartFailed,
    /// A stop arrived before `start` was called; `launch` must not start.
    StopRequested,
}

/// What a stop request actually did. Reported as-is — "stopped" is only ever
/// said for `Cancelled` (cloister-991e65 review: an `Ok(false)` from LLO used
/// to be printed as "stopped" while the worker kept running).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelOutcome {
    /// LLO cancelled the run and finished its cleanup.
    Cancelled,
    /// The stop arrived before the run was started; it will not be started.
    NeverStarted,
    /// `start` failed, so there was no run to cancel.
    StartFailed,
    /// LLO reported the run as no longer active: it had already ended.
    AlreadyEnded,
}

/// The deployment inputs LLO compiles its own confinement document from.
///
/// They are the SAME values the backend was constructed with
/// (`KrunWorkerConfig.runtime_files` / `.devices`), handed here as well so
/// cloister can compute, before the run, the exact document the worker will
/// compile — which is what LLO requires of any carried document (see
/// `to_execution_request`). Per-deployment configuration, not per-run values,
/// so the document is predictable.
#[derive(Debug, Clone, Default)]
pub struct Deployment {
    pub runtime_files: Vec<PathBuf>,
    pub devices: Vec<PathBuf>,
}

/// Block until a started run reaches its terminal state (cloister-991e65).
///
/// LLO's `Backend::start` returns once the worker reports READY, which is
/// before the workload has done anything. Treating that as the run's outcome is
/// how `cloister-host-runtime run` exited 0 for a guest whose result nobody
/// observed — and, since the process then exited and dropped the backend, the
/// drop cancelled the VM it had just started. A launch is therefore not
/// complete until the run is.
///
/// A trait of cloister's rather than LLO's `poll`, because `poll` is
/// non-blocking and the only way to turn it into a wait is a sleep loop, which
/// LLO's own `wait_for_completion` doc forbids ("must not infer completion by
/// ... sleeping for a guessed duration"). The real backend's blocking wait is
/// an inherent method; this names it so the generic wrapper can call it.
///
/// It returns LLO's `RunOutcome` (v0.29.0, ley-line-open-a26ad0): the terminal
/// status AND the guest's bounded, sanitized, UNTRUSTED output tails
/// (cloister-edec62), so a failed run can show what its workload printed.
pub trait AwaitRun {
    fn await_run(&self, run_id: &str) -> Result<RunOutcome, ExecutionError>;
}

impl AwaitRun for KrunWorkerBackend {
    fn await_run(&self, run_id: &str) -> Result<RunOutcome, ExecutionError> {
        self.wait_for_outcome(run_id)
    }
}

/// The message for a failed registry pull. LLO reports every registry failure
/// as `OciImportError::Registry(String)`, so an authentication refusal is
/// recognised by the HTTP status LLO puts in that text (`HTTP 401`, `HTTP
/// 403`) or by its "only anonymous bearer tokens" challenge refusal. Only
/// those get the "public images only" hint; every other failure passes
/// through unchanged. (A typed auth variant would make this exact; until LLO
/// has one, the status token is the narrowest signal.)
pub fn registry_failure_message(error: &leyline_runtime::artifacts::oci::OciImportError) -> String {
    use leyline_runtime::artifacts::oci::OciImportError;
    let auth = matches!(
        error,
        OciImportError::Registry(detail)
            if detail.contains("HTTP 401")
                || detail.contains("HTTP 403")
                || detail.contains("only anonymous bearer tokens")
    );
    if auth {
        format!(
            "{error} — cloister pulls anonymously, so only public images can be pulled; \
             credentials are not supported yet"
        )
    } else {
        error.to_string()
    }
}

/// Printed in place of a failure's detail when cloister cannot separate the
/// supervisor's words from the guest's (see `supervisor_detail`). Fails CLOSED:
/// guest text never reaches the trusted failure line.
pub const DETAIL_WITHHELD: &str =
    "detail withheld: it did not end with the guest output LLO appends, so cloister cannot tell the supervisor's words from the guest's";

/// The supervisor's own part of a failed run's detail.
///
/// LLO appends the guest's tails (and any reported, unverified event) to a
/// failure's detail with `failure_with_output`. Rather than mirror LLO's
/// heading strings, cloister asks LLO's own function what it would append for
/// THIS output — by applying it to the same error with an empty detail — and
/// strips exactly that suffix. If LLO changes its format, this still computes
/// the right suffix; if the detail does not end with it, the detail is
/// withheld rather than shown, so a guest can never write into the trusted
/// line. With no output, LLO appended nothing and the detail is whole.
pub fn supervisor_detail(error: &ExecutionError, output: Option<&GuestOutput>) -> String {
    let Some(output) = output else {
        return error.detail.clone();
    };
    let appended = failure_with_output(
        ExecutionError {
            code: error.code,
            retryable: error.retryable,
            detail: String::new(),
        },
        output,
    )
    .detail;
    match error.detail.strip_suffix(appended.as_str()) {
        Some(own) => own.to_owned(),
        None => DETAIL_WITHHELD.to_owned(),
    }
}

/// At most this many lines of each guest stream are printed; the rest are
/// counted, so a tail of bare newlines cannot flood a terminal's scrollback.
pub const GUEST_LINES_SHOWN: usize = 40;

/// The guest-output block printed for a FAILED run (never for a success, and
/// never for a stop at the wall-clock ceiling: that is not the workload
/// failing, and a healthy service's stdout does not belong in a CI log
/// because a deadline passed).
///
/// The text is the workload's own: untrusted, never interpreted, and it never
/// changes the exit status. LLO has already replaced control characters other
/// than newline and tab with U+FFFD (and invalid UTF-8). Each guest line is
/// further prefixed with `| `, so nothing the guest prints can pass for one
/// of the host runtime's own lines.
pub fn guest_output_lines(output: &GuestOutput) -> Vec<String> {
    let mut lines = vec!["guest output (untrusted; shown as printed, not interpreted):".to_owned()];
    for (name, text, dropped) in [
        ("stdout", &output.stdout_tail, output.stdout_dropped_bytes),
        (
            "stderr, with the worker's diagnostics",
            &output.stderr_tail,
            output.stderr_dropped_bytes,
        ),
    ] {
        if text.is_empty() {
            lines.push(format!("  guest {name}: (empty)"));
            continue;
        }
        let kept = if dropped > 0 {
            format!("last part; {dropped} earlier bytes dropped")
        } else {
            "all of it".to_owned()
        };
        lines.push(format!("  guest {name} ({kept}):"));
        let all: Vec<&str> = text.lines().collect();
        let omitted = all.len().saturating_sub(GUEST_LINES_SHOWN);
        if omitted > 0 {
            lines.push(format!("  … {omitted} earlier lines omitted"));
        }
        for line in &all[omitted..] {
            lines.push(format!("  | {line}"));
        }
    }
    lines
}

/// Turn a finished run's outcome into the launch result, writing the guest
/// output block to `out` for a failed run. Separated from `launch` so tests
/// can observe exactly what is printed.
///
/// - Succeeded: nothing is written.
/// - Failed at the wall-clock ceiling (LLO reports the deadline as
///   ResourceExhausted — runtime process.rs; at the pinned LLO no other
///   libkrun-tier failure uses that code): no block; `WallClockExceeded`.
/// - Failed otherwise: the block (when LLO returned output), then `RunFailed`
///   carrying the supervisor's detail only.
///
/// The block is written through one `out` borrow; `launch` passes a locked
/// stderr, so the stop thread's messages cannot interleave with it.
pub fn report_run_outcome(
    outcome: &RunOutcome,
    out: &mut dyn std::io::Write,
) -> Result<(), RuntimeError> {
    let summary = |error: &ExecutionError| {
        format!(
            "{:?}: {}",
            error.code,
            supervisor_detail(error, outcome.output.as_ref())
        )
    };
    match &outcome.status {
        BackendRunStatus::Succeeded => Ok(()),
        BackendRunStatus::Failed(error) if error.code == ErrorCode::ResourceExhausted => {
            Err(RuntimeError::WallClockExceeded(summary(error)))
        }
        BackendRunStatus::Failed(error) => {
            if let Some(output) = &outcome.output {
                let block: String = guest_output_lines(output)
                    .into_iter()
                    .map(|line| format!("cloister-host-runtime: {line}\n"))
                    .collect();
                // Ignore write errors: the supervisor may be gone (see note!).
                let _ = out.write_all(block.as_bytes());
                let _ = out.flush();
            }
            Err(RuntimeError::RunFailed(summary(error)))
        }
    }
}

impl<B: LeylineBackendTrait + AwaitRun> LeylineExecutionBackend<B> {
    pub fn new(inner: Arc<B>, deployment: Deployment) -> Self {
        Self {
            inner,
            deployment,
            start: Arc::new((Mutex::new(StartPhase::NotStarted), Condvar::new())),
        }
    }

    /// Availability snapshot, for `doctor` / `status`.
    ///
    /// Replaces `executable_available("krunvm") && executable_available("buildah")`
    /// — a PATH probe that answered "are the binaries present" and was read as
    /// "can this host confine a workload". LLO's backend answers the second
    /// question directly, which is the one an operator was always asking.
    pub fn available(&self) -> bool {
        self.inner.capabilities().available
    }

    /// Stop `plan`'s run and wait for LLO to release it (cloister-991e65).
    ///
    /// The krun worker runs in its OWN process group (LLO
    /// `configure_process_group`), so a host runtime that simply dies leaves
    /// the worker — and the guest — running. A supervisor that wants a run
    /// gone (`cloister cluster up` on SIGINT) signals the host runtime, and the
    /// host runtime calls this: LLO's cancel sweeps the worker's group and
    /// returns only once cleanup has finished.
    ///
    /// A stop can arrive while `launch` is still inside LLO's `start` — up to
    /// the worker's readiness timeout after spawn. LLO publishes the run only
    /// when `start` returns, so a cancel before then answers `Ok(false)` and
    /// the worker it is starting keeps going. So a stop during start marks
    /// itself, waits for `start` to settle, and only then cancels; a stop
    /// before `start` stops it from being called at all. The LLO side —
    /// cancelling before readiness, and the worker noticing its parent die —
    /// is ley-line-open-f963e6.
    pub fn cancel(&self, plan: &LaunchPlan) -> Result<CancelOutcome, RuntimeError> {
        let (lock, settled) = &*self.start;
        let mut phase = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *phase == StartPhase::NotStarted {
            *phase = StartPhase::StopRequested;
            return Ok(CancelOutcome::NeverStarted);
        }
        while *phase == StartPhase::Starting {
            phase = settled
                .wait(phase)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        match *phase {
            StartPhase::StartFailed => Ok(CancelOutcome::StartFailed),
            StartPhase::StopRequested | StartPhase::NotStarted => Ok(CancelOutcome::NeverStarted),
            StartPhase::Starting => unreachable!("waited above"),
            StartPhase::Started => {
                drop(phase);
                match self.inner.cancel(&run_id(plan)) {
                    Ok(true) => Ok(CancelOutcome::Cancelled),
                    Ok(false) => Ok(CancelOutcome::AlreadyEnded),
                    Err(error) => Err(RuntimeError::Backend(error.to_string())),
                }
            }
        }
    }

    /// Move the start phase, waking any `cancel` waiting on it.
    fn set_phase(&self, next: StartPhase) {
        let (lock, settled) = &*self.start;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
        settled.notify_all();
    }
}

/// The LLO run id for `plan`: derived from the bundle, so a replayed plan is
/// the same run rather than a new one each time it is submitted.
pub fn run_id(plan: &LaunchPlan) -> String {
    format!("run-{}", plan.bundle)
}

/// Translate a cloister launch plan into an LLO execution request.
///
/// ## When a confinement document is carried, and when it is not
///
/// LLO's worker compiles its own confinement/v1 document from the deployment
/// (the symbolic rootfs `/run/rootfs/`, runtime files, devices), folds in the
/// dimensions a grant may originate (§4, §6) from a carried document, and then
/// requires the carried document to EQUAL the compiled one — equality, not
/// subset, so a carried document can never claim a policy the worker would not
/// apply (LLO PR #329; verified against LLO head b9b800c, where passing the
/// bundle's own boundary as the document answered `FOLD-REFUSED` on §2).
///
/// - **No §6 grant:** nothing is carried (`None`), and LLO compiles its own
///   policy exactly as before.
/// - **§6 grants:** cloister builds the document with LLO's own compiler
///   (`confinement_manifest`) over the same deployment inputs the worker uses,
///   then adds the grants. That is the document the worker will compile after
///   folding them, so equality holds by construction rather than by keeping
///   two implementations in step. Its digest is carried too, so the worker's
///   attestation is checked against what cloister asked for.
///
/// Every other grant is still refused by name. §2 `fs.allow` cannot be carried
/// (LLO never folds it — that would widen what LLO grants itself), §4 needs
/// socket hijacking, which is off and not plan-reachable, and §5 / egress have
/// no mapping. Refusing keeps a plan from running with grants silently dropped.
fn to_execution_request(
    plan: &LaunchPlan,
    enforced: &EnforcedCeilings,
    deployment: &Deployment,
) -> Result<ExecutionRequest, RuntimeError> {
    if !plan.confinement.network.allow_hosts.is_empty() {
        return Err(RuntimeError::InvalidPlan(
            "LLO execution/v1 does not yet support egress grants; refusing to discard confinement.network.allowHosts".into(),
        ));
    }
    if !plan.confinement.fs.allow.is_empty()
        || !plan.confinement.credential_source.is_empty()
        || plan.confinement.port.bind != 0
        || !plan.confinement.port.address.is_empty()
    {
        return Err(RuntimeError::InvalidPlan(
            "LLO execution/v1 authority mapping for filesystem, credentials, and ports is not implemented; refusing to discard launch-plan grants".into(),
        ));
    }
    let (confinement_digest, carried) = carried_confinement(plan, deployment)?;
    if plan.artifact.args.iter().any(|arg| arg.contains('\0')) {
        return Err(RuntimeError::InvalidPlan(
            "artifact arguments must not contain NUL bytes".into(),
        ));
    }
    let (algorithm, value) = plan.artifact.digest.split_once(':').ok_or_else(|| {
        RuntimeError::InvalidPlan(format!(
            "artifact digest {:?} is not <algorithm>:<hex>",
            plan.artifact.digest
        ))
    })?;
    if algorithm != "blake3-256"
        || value.len() != 64
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(RuntimeError::InvalidPlan(
            "LLO execution requires a blake3-256 artifact digest; refusing to submit a sha256 or mutable image reference".into(),
        ));
    }
    let executable = plan.artifact.entrypoint.strip_prefix('/').ok_or_else(|| {
        RuntimeError::InvalidPlan("artifact.entrypoint must be absolute in the host plan so it can be converted to a guest-relative LLO path".into())
    })?;
    if executable.is_empty()
        || executable
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(RuntimeError::InvalidPlan(
            "artifact.entrypoint cannot be converted to a safe guest-relative LLO path".into(),
        ));
    }
    if plan.workspace.as_os_str().is_empty() || plan.control_socket.as_os_str().is_empty() {
        return Err(RuntimeError::InvalidPlan(
            "workspace and control socket are required".into(),
        ));
    }

    Ok(ExecutionRequest {
        // Derived from the bundle, so a replayed plan is the same run rather
        // than a new one each time it is submitted.
        run_id: run_id(plan),
        replay_key: plan.artifact.digest.clone(),
        rootfs: DigestRef {
            algorithm: algorithm.to_string(),
            value: value.to_string(),
        },
        executable: executable.to_string(),
        arguments: plan.artifact.args.clone(),
        public_environment: BTreeMap::new(),
        allowed_egress: Vec::new(),
        limits: default_limits(enforced),
        confinement_digest,
        confinement_manifest: carried,
        // No Graph workspace authority is mapped from a launch plan. On LLO
        // v0.26.0 the native tier, and libkrun without a share provider or with
        // two or more workspaces, refuse a workspace grant before spawn with
        // ErrorCode::WorkspaceUnserved (cloister-dc4a53); such a run must be
        // routed to a workspace-serving backend, never retried without the
        // workspace. A grant's graphRoot is `blake3-256:<storeRoot>` and pre-M1
        // roots are refused (cloister-83d669). Empty is the only value cloister
        // can carry here without a grant to take it from.
        workspaces: Vec::new(),
    })
}

/// The confinement document to carry for `plan`'s §6 grants, with its digest:
/// `(String::new(), None)` when there are none. See `to_execution_request`.
///
/// Public so the emitter-fixture test can run it on the exact plans
/// `cloister runtime plan` emits (test/fixtures/runtime-plan/).
pub fn carried_confinement(
    plan: &LaunchPlan,
    deployment: &Deployment,
) -> Result<(String, Option<String>), RuntimeError> {
    let grants = &plan.confinement.unix_socket.allow;
    if grants.is_empty() {
        return Ok((String::new(), None));
    }
    let invalid = |error: ExecutionError| RuntimeError::InvalidPlan(error.to_string());
    let mut document = confinement_manifest(&deployment.runtime_files, &deployment.devices, None)
        .map_err(invalid)?;
    for entry in grants {
        let grant = match entry.mode.as_str() {
            "" => UnixSocketGrant::connect(entry.path.clone()),
            "bind" => UnixSocketGrant::bind(entry.path.clone()),
            "connect-bind" => UnixSocketGrant::connect_bind(entry.path.clone()),
            other => {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement unixSocket mode {other:?} is not connect, bind, or connect-bind"
                )));
            }
        };
        let grant = match entry.guest_port {
            Some(port) => grant.with_guest_port(port).map_err(invalid)?,
            None => grant,
        };
        document = document.with_unix_socket(grant).map_err(invalid)?;
    }
    let digest = document.confinement_digest().map_err(invalid)?;
    let json = document.to_canonical_json().map_err(invalid)?;
    Ok((digest, Some(json)))
}

impl<B: LeylineBackendTrait + AwaitRun> Backend for LeylineExecutionBackend<B> {
    fn launch(&self, plan: &LaunchPlan) -> Result<(), RuntimeError> {
        let request =
            to_execution_request(plan, &self.inner.capabilities().enforced, &self.deployment)?;
        // Say what ceiling this run carries, so a supervisor's log shows why a
        // service stops when it does (ley-line-open-e6b1bb).
        crate::note!(
            "cloister-host-runtime: {}: wall-clock ceiling {} s (the run is stopped when it is reached)",
            request.run_id,
            request.limits.wall_time_ms / 1000
        );
        {
            let (lock, _) = &*self.start;
            let mut phase = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if *phase == StartPhase::StopRequested {
                return Err(RuntimeError::Backend(
                    "a stop was requested before the run was started; not starting it".into(),
                ));
            }
            *phase = StartPhase::Starting;
        }
        if let Err(error) = self.inner.start(&request) {
            self.set_phase(StartPhase::StartFailed);
            return Err(RuntimeError::Backend(error.to_string()));
        }
        self.set_phase(StartPhase::Started);
        let outcome = self
            .inner
            .await_run(&request.run_id)
            .map_err(|error| RuntimeError::Backend(error.to_string()))?;
        report_run_outcome(&outcome, &mut std::io::stderr().lock())
    }
}
