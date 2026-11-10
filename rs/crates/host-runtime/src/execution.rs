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
use std::sync::Arc;

use leyline_runtime::backends::libkrun::backend::KrunWorkerBackend;
use leyline_runtime::backends::libkrun::confinement::confinement_manifest;
use leyline_runtime::confinement::UnixSocketGrant;
use leyline_runtime::{
    Backend as LeylineBackendTrait, BackendRunStatus, CpuLimits, DEFAULT_CPU_PERIOD_US, DigestRef,
    EnforcedCeilings, ExecutionError, ExecutionRequest, MemoryLimits, PidsLimits, ResourceLimits,
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
        if mechanism.is_enforced() { value } else { 0 }
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
pub trait AwaitRun {
    fn await_run(&self, run_id: &str) -> Result<BackendRunStatus, ExecutionError>;
}

impl AwaitRun for KrunWorkerBackend {
    fn await_run(&self, run_id: &str) -> Result<BackendRunStatus, ExecutionError> {
        self.wait_for_completion(run_id)
    }
}

impl<B: LeylineBackendTrait + AwaitRun> LeylineExecutionBackend<B> {
    pub fn new(inner: Arc<B>, deployment: Deployment) -> Self {
        Self { inner, deployment }
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
        run_id: format!("run-{}", plan.bundle),
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
fn carried_confinement(
    plan: &LaunchPlan,
    deployment: &Deployment,
) -> Result<(String, Option<String>), RuntimeError> {
    let grants = &plan.confinement.unix_socket.allow;
    if grants.is_empty() {
        return Ok((String::new(), None));
    }
    let invalid = |error: ExecutionError| RuntimeError::InvalidPlan(error.to_string());
    let mut document =
        confinement_manifest(&deployment.runtime_files, &deployment.devices, None)
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
        self.inner
            .start(&request)
            .map_err(|error: ExecutionError| RuntimeError::Backend(error.to_string()))?;
        match self
            .inner
            .await_run(&request.run_id)
            .map_err(|error| RuntimeError::Backend(error.to_string()))?
        {
            BackendRunStatus::Succeeded => Ok(()),
            BackendRunStatus::Failed(error) => Err(RuntimeError::RunFailed(error.to_string())),
        }
    }
}
