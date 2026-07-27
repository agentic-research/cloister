// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{LaunchPlan, RuntimeError};

const RESTRICTION_SCHEMA: &str = "cloister/krunvm-restriction/v1";
const KRUNVM_COMPAT: &str = "0.2";
const GUEST_WORKSPACE: &str = "/workspace";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KrunvmSettings {
    pub storage_volume: PathBuf,
    pub cpus: u32,
    pub memory_mib: u32,
    pub dns: String,
    pub host_arch: String,
}

impl Default for KrunvmSettings {
    fn default() -> Self {
        Self {
            storage_volume: PathBuf::from("/Volumes/krunvm"),
            cpus: 1,
            memory_mib: 1024,
            dns: "1.1.1.1".into(),
            host_arch: std::env::consts::ARCH.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Serialize)]
struct PersistentRestriction<'a> {
    schema: &'static str,
    artifact_index_digest: &'a str,
    cpus: u32,
    memory_mib: u32,
    dns: &'a str,
    workdir: &'static str,
    volumes: BTreeMap<&'static str, &'a str>,
    ports: BTreeMap<u16, u16>,
    host_arch: &'a str,
    krunvm_compat: &'static str,
}

fn restriction<'a>(
    plan: &'a LaunchPlan,
    settings: &'a KrunvmSettings,
) -> Result<PersistentRestriction<'a>, RuntimeError> {
    plan.validate()?;
    if plan.confinement.port.bind == 0 {
        return Err(RuntimeError::InvalidPlan(
            "microvm confinement.port.bind must be nonzero".into(),
        ));
    }
    if plan.confinement.port.address != "127.0.0.1" && plan.confinement.port.address != "::1" {
        return Err(RuntimeError::InvalidPlan(
            "microvm confinement.port.address must be numeric loopback".into(),
        ));
    }
    let workspace = plan
        .workspace
        .to_str()
        .ok_or_else(|| RuntimeError::InvalidPlan("workspace path must be valid UTF-8".into()))?;
    let mut volumes = BTreeMap::new();
    volumes.insert(GUEST_WORKSPACE, workspace);
    let mut ports = BTreeMap::new();
    ports.insert(plan.confinement.port.bind, plan.confinement.port.bind);
    Ok(PersistentRestriction {
        schema: RESTRICTION_SCHEMA,
        artifact_index_digest: &plan.artifact.digest,
        cpus: settings.cpus,
        memory_mib: settings.memory_mib,
        dns: &settings.dns,
        workdir: GUEST_WORKSPACE,
        volumes,
        ports,
        host_arch: &settings.host_arch,
        krunvm_compat: KRUNVM_COMPAT,
    })
}

pub fn restriction_digest(
    plan: &LaunchPlan,
    settings: &KrunvmSettings,
) -> Result<[u8; 32], RuntimeError> {
    let persistent = restriction(plan, settings)?;
    let bytes = serde_json::to_vec(&persistent)
        .map_err(|error| RuntimeError::Backend(format!("serializing restriction: {error}")))?;
    Ok(Sha256::digest(bytes).into())
}

pub fn vm_name(bundle: &str, digest: &[u8; 32]) -> String {
    let safe_bundle: String = bundle
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let short: String = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("cloister-{safe_bundle}-{short}")
}

pub fn create_command(
    plan: &LaunchPlan,
    settings: &KrunvmSettings,
) -> Result<CommandSpec, RuntimeError> {
    let digest = restriction_digest(plan, settings)?;
    let name = vm_name(&plan.bundle, &digest);
    Ok(CommandSpec {
        program: "krunvm".into(),
        args: vec![
            "create".into(),
            format!("{}@{}", plan.artifact.image, plan.artifact.digest),
            "--name".into(),
            name,
            "--cpus".into(),
            settings.cpus.to_string(),
            "--mem".into(),
            settings.memory_mib.to_string(),
            "--dns".into(),
            settings.dns.clone(),
            "--workdir".into(),
            GUEST_WORKSPACE.into(),
            "--volume".into(),
            format!("{}:{GUEST_WORKSPACE}", plan.workspace.display()),
            "--port".into(),
            format!(
                "{}:{}",
                plan.confinement.port.bind, plan.confinement.port.bind
            ),
        ],
    })
}

pub fn start_command(
    plan: &LaunchPlan,
    settings: &KrunvmSettings,
) -> Result<CommandSpec, RuntimeError> {
    let digest = restriction_digest(plan, settings)?;
    let mut args = vec![
        "start".into(),
        vm_name(&plan.bundle, &digest),
        "--".into(),
        plan.artifact.entrypoint.clone(),
    ];
    args.extend(plan.artifact.args.iter().cloned());
    Ok(CommandSpec {
        program: "krunvm".into(),
        args,
    })
}
