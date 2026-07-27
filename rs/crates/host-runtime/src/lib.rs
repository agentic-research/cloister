// SPDX-License-Identifier: AGPL-3.0-or-later

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
            if entry.mode != "" && entry.mode != "rw" {
                return Err(RuntimeError::InvalidPlan(format!(
                    "confinement fs mode must be empty or rw: {:?}",
                    entry.mode
                )));
            }
        }
        Ok(())
    }
}

fn is_canonical_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|value| !value.split('/').any(|part| part == "." || part == ".."))
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
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
}
