// SPDX-License-Identifier: AGPL-3.0-or-later

#[cfg(feature = "llo-execution")]
pub mod execution;
pub mod mediator;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const HOST_RUNTIME_SCHEMA: &str = "cloister/host-runtime/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Process,
    Microvm,
}

impl fmt::Display for ExecutionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Process => f.write_str("process"),
            Self::Microvm => f.write_str("microvm"),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub image: String,
    pub digest: String,
    pub entrypoint: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Confinement {
    #[serde(default)]
    pub fs: ConfinementFs,
    #[serde(default)]
    pub network: ConfinementNetwork,
    #[serde(default)]
    pub port: ConfinementPort,
    #[serde(default)]
    pub credential_source: String,
    /// confinement/v1 §6 `unixSocket.allow`: the channels the workload holds.
    ///
    /// On the microVM tier each grant becomes exactly one vsock↔UNIX-socket
    /// mapping, and a guest started without socket hijacking has no other
    /// way out — no NIC, no implicit vsock. So this list is not a filter over
    /// a network the guest already has; it is the complete set of channels
    /// that exist. No entry, no channel (cloister-77870d).
    #[serde(default)]
    pub unix_socket: ConfinementUnixSocket,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfinementUnixSocket {
    #[serde(default)]
    pub allow: Vec<UnixSocketAllowEntry>,
}

/// One §6 grant. `mode` follows `fs.allow`'s convention: empty is the narrow
/// default (connect-only), and widening is spelled out — `bind` (serve without
/// dial) or `connect-bind`.
///
/// `guestPort` (confinement/v1 §6, LLO v0.28.0, ADR-0046 Q7) presents the
/// channel to an UNMODIFIED workload as TCP on the guest's loopback: with
/// connect the workload dials `127.0.0.1:guestPort` and reaches exactly this
/// peer; with `bind` it listens there and only this channel reaches it. It is
/// committed in the attested digest, so the address is allocated by the
/// issuer, never chosen by the workload.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UnixSocketAllowEntry {
    pub path: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_port: Option<u16>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfinementFs {
    #[serde(default)]
    pub allow: Vec<FsAllowEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FsAllowEntry {
    pub path: String,
    #[serde(default)]
    pub mode: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConfinementNetwork {
    #[serde(default)]
    pub allow_hosts: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConfinementPort {
    #[serde(default)]
    pub bind: u16,
    #[serde(default)]
    pub address: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LaunchPlan {
    pub schema: String,
    pub bundle: String,
    pub mode: ExecutionMode,
    pub artifact: Artifact,
    #[serde(default)]
    pub confinement: Confinement,
    pub workspace: PathBuf,
    pub control_socket: PathBuf,
}

impl LaunchPlan {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.schema != HOST_RUNTIME_SCHEMA {
            return Err(RuntimeError::InvalidPlan(format!(
                "unsupported schema {:?}; expected {HOST_RUNTIME_SCHEMA}",
                self.schema
            )));
        }
        if self.bundle.trim().is_empty() {
            return Err(RuntimeError::InvalidPlan("bundle must not be empty".into()));
        }
        if self.artifact.image.trim().is_empty() {
            return Err(RuntimeError::InvalidPlan(
                "artifact.image must not be empty".into(),
            ));
        }
        if !is_sha256_digest(&self.artifact.digest) {
            return Err(RuntimeError::InvalidPlan(
                "artifact requires an immutable sha256 digest".into(),
            ));
        }
        if !is_canonical_absolute_path(Path::new(&self.artifact.entrypoint)) {
            return Err(RuntimeError::InvalidPlan(
                "artifact.entrypoint must be a canonical absolute guest path".into(),
            ));
        }
        if !is_canonical_absolute_path(&self.workspace) {
            return Err(RuntimeError::InvalidPlan(
                "workspace must be a canonical absolute host path".into(),
            ));
        }
        if !is_canonical_absolute_path(&self.control_socket) {
            return Err(RuntimeError::InvalidPlan(
                "controlSocket must be a canonical absolute host path".into(),
            ));
        }
        for entry in &self.confinement.fs.allow {
            if !is_canonical_absolute_path(Path::new(&entry.path)) {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement fs path must be canonical and absolute: {:?}",
                    entry.path
                )));
            }
            if !entry.mode.is_empty() && entry.mode != "rw" {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement fs mode must be empty or rw: {:?}",
                    entry.mode
                )));
            }
        }
        for entry in &self.confinement.unix_socket.allow {
            // A leaf, not a tree: the microVM tier maps one vsock port per
            // endpoint, and a directory grant has no endpoint to map.
            if !is_canonical_absolute_path(Path::new(&entry.path)) || entry.path.ends_with('/') {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement unixSocket path must be a canonical absolute socket path: {:?}",
                    entry.path
                )));
            }
            // sun_path holds 104 bytes on macOS and 108 on Linux, NUL
            // included. Past that, libkrun's listening proxy fails to bind and
            // only logs a warning, so the declared channel silently does not
            // exist — found by running a 120-byte path on a live guest.
            if entry.path.len() > MAX_UNIX_SOCKET_PATH {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement unixSocket path is {} bytes; this platform's socket paths hold at most {MAX_UNIX_SOCKET_PATH}: {:?}",
                    entry.path.len(),
                    entry.path
                )));
            }
            if !["", "bind", "connect-bind"].contains(&entry.mode.as_str()) {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement unixSocket mode must be empty (connect), bind, or connect-bind: {:?}",
                    entry.mode
                )));
            }
            // LLO refuses these too; refusing here names the plan, not a
            // worker-side compile error, and a bad plan never reaches LLO.
            match entry.guest_port {
                Some(0) => {
                    return Err(RuntimeError::InvalidPlan(format!(
                        "confinement unixSocket guestPort for {:?} must be 1-65535",
                        entry.path
                    )));
                }
                Some(port) if entry.mode == "connect-bind" => {
                    return Err(RuntimeError::InvalidPlan(format!(
                        "confinement unixSocket guestPort {port} cannot be carried by the connect-bind grant {:?}: one guest port cannot be both the dial presentation's listener and the workload's",
                        entry.path
                    )));
                }
                _ => {}
            }
        }
        let mut ports: Vec<u16> = self
            .confinement
            .unix_socket
            .allow
            .iter()
            .filter_map(|entry| entry.guest_port)
            .collect();
        ports.sort_unstable();
        if let Some(pair) = ports.windows(2).find(|pair| pair[0] == pair[1]) {
            return Err(RuntimeError::InvalidPlan(format!(
                "confinement unixSocket guestPort {} is presented by two grants",
                pair[0]
            )));
        }
        Ok(())
    }
}

/// Longest UNIX socket path the platform's `sockaddr_un.sun_path` holds,
/// excluding the terminating NUL.
#[cfg(target_os = "macos")]
const MAX_UNIX_SOCKET_PATH: usize = 103;
#[cfg(not(target_os = "macos"))]
const MAX_UNIX_SOCKET_PATH: usize = 107;

fn is_canonical_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|value| !value.split('/').any(|part| part == "." || part == ".."))
}

fn is_sha256_digest(value: &str) -> bool {
    ["sha256:", "blake3-256:"].iter().any(|prefix| {
        value
            .strip_prefix(prefix)
            .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
    })
}

pub trait Backend: Send + Sync {
    fn launch(&self, plan: &LaunchPlan) -> Result<(), RuntimeError>;
}

pub struct HostRuntime {
    process: Option<Arc<dyn Backend>>,
    microvm: Option<Arc<dyn Backend>>,
}

impl HostRuntime {
    pub fn new(process: Option<Arc<dyn Backend>>, microvm: Option<Arc<dyn Backend>>) -> Self {
        Self { process, microvm }
    }

    pub fn launch(&self, plan: &LaunchPlan) -> Result<(), RuntimeError> {
        plan.validate()?;
        let backend = match plan.mode {
            ExecutionMode::Process => self.process.as_ref(),
            ExecutionMode::Microvm => self.microvm.as_ref(),
        }
        .ok_or(RuntimeError::BackendUnavailable(plan.mode))?;
        backend.launch(plan)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("invalid launch plan: {0}")]
    InvalidPlan(String),
    #[error("{0} execution backend is unavailable; refusing an unconstrained fallback")]
    BackendUnavailable(ExecutionMode),
    #[error("execution backend failed: {0}")]
    Backend(String),
    /// The launch was accepted and the workload ran, then ended in failure.
    /// Distinct from `Backend` so a caller never reads "the guest's process
    /// exited non-zero" as "the runtime refused the plan", or the reverse.
    #[error("the workload ran and failed: {0}")]
    RunFailed(String),
}
