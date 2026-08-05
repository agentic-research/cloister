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
use std::sync::Arc;

use leyline_runtime::{
    Backend as LeylineBackendTrait, DigestRef, ExecutionError, ExecutionRequest, ResourceLimits,
};

use crate::{Backend, LaunchPlan, RuntimeError};

/// Default limits for a launch plan, which carries none of its own.
///
/// `LaunchPlan` is cloister's operator surface and deliberately does not model
/// vcpus/memory/wall-time — those are deployment properties, not per-bundle
/// ones. LLO's `ExecutionRequest` requires them, so they are supplied here and
/// named as a cloister default rather than smuggled in as if the operator had
/// asked for them.
const DEFAULT_VCPUS: u8 = 2;
const DEFAULT_MEMORY_MIB: u32 = 1024;
const DEFAULT_WALL_TIME_MS: u64 = 15 * 60 * 1000;

/// cloister's `Backend`, served by an LLO execution backend.
///
/// Generic over LLO's trait rather than pinned to `KrunWorkerBackend`, because
/// the two LLO backends (`KrunWorkerBackend`, `NativeWorkerBackend`) map exactly
/// onto cloister's two `ExecutionMode`s, and `HostRuntime` already dispatches on
/// mode. Pinning the concrete type here would rebuild that dispatch a second
/// time in a second place.
pub struct LeylineExecutionBackend<B: LeylineBackendTrait> {
    inner: Arc<B>,
}

impl<B: LeylineBackendTrait> LeylineExecutionBackend<B> {
    pub fn new(inner: Arc<B>) -> Self {
        Self { inner }
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
/// ## Why `confinement_manifest` is None
///
/// Not an omission, and not a TODO. cloister's `LaunchPlan.confinement` and
/// LLO's compiled confinement document describe DIFFERENT TIERS, and passing one
/// as the other is refused — verified against LLO integration head b9b800c
/// before this code existed, by running cloister's document through LLO's own
/// fold: it answered `FOLD-REFUSED`, naming `§2 fs.allow` as the dimension the
/// compiled policy does not carry.
///
/// LLO's document is built from `LibkrunBackendConfig` — the symbolic rootfs
/// (`/run/rootfs/`), the deployment's runtime files, its device nodes. cloister's
/// is the bundle's own boundary (workspace roots, allowHosts, port). They are
/// both valid confinement/v1 documents and they are not the same document, so
/// the equality contract PR #329 introduced refuses the pairing by name.
///
/// Carrying a document requires cloister to reproduce LLO's compiled one exactly,
/// which per LLO ADR-0036 an issuer configured for a deployment can do — it needs
/// LLO's runtime files and devices, which cloister does not model today. Until it
/// does, LLO compiles its own policy (the `None` path, unchanged behaviour) and
/// cloister's confinement continues to govern the tier it actually describes:
/// the nono/Seatbelt process boundary in `tools/harness-sandbox`.
///
/// Sending `Some(...)` before that is possible would not be a smaller version of
/// the right thing. It would be a run that fails closed at compile time, with a
/// diagnostic naming a dimension mismatch nobody intended to create.
fn to_execution_request(plan: &LaunchPlan) -> Result<ExecutionRequest, RuntimeError> {
    let (algorithm, value) = plan
        .artifact
        .digest
        .split_once(':')
        .ok_or_else(|| RuntimeError::InvalidPlan(format!(
            "artifact digest {:?} is not <algorithm>:<hex>", plan.artifact.digest
        )))?;

    Ok(ExecutionRequest {
        // Derived from the bundle, so a replayed plan is the same run rather
        // than a new one each time it is submitted.
        run_id: format!("run-{}", plan.bundle),
        replay_key: plan.artifact.digest.clone(),
        rootfs: DigestRef {
            algorithm: algorithm.to_string(),
            value: value.to_string(),
        },
        executable: plan.artifact.image.clone(),
        arguments: Vec::new(),
        public_environment: BTreeMap::new(),
        // §3 egress. cloister's allowHosts is the operator's declaration and
        // travels as-is; an empty list means no egress, which is what both
        // specs already mean by omission.
        allowed_egress: plan.confinement.network.allow_hosts.clone(),
        limits: ResourceLimits {
            vcpus: DEFAULT_VCPUS,
            memory_mib: DEFAULT_MEMORY_MIB,
            wall_time_ms: DEFAULT_WALL_TIME_MS,
        },
        confinement_digest: String::new(),
        confinement_manifest: None,
    })
}

impl<B: LeylineBackendTrait> Backend for LeylineExecutionBackend<B> {
    fn launch(&self, plan: &LaunchPlan) -> Result<(), RuntimeError> {
        let request = to_execution_request(plan)?;
        self.inner
            .start(&request)
            .map(|_run| ())
            .map_err(|error: ExecutionError| RuntimeError::Backend(error.to_string()))
    }
}
