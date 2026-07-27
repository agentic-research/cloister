// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmRecord {
    pub name: String,
    pub bundle: Option<String>,
    pub restriction: Option<String>,
    pub platform_digest: Option<String>,
    pub last_used: u64,
}

impl VmRecord {
    pub fn known(
        name: &str,
        bundle: &str,
        restriction: &str,
        platform_digest: &str,
        last_used: u64,
    ) -> Self {
        Self {
            name: name.into(),
            bundle: Some(bundle.into()),
            restriction: Some(restriction.into()),
            platform_digest: Some(platform_digest.into()),
            last_used,
        }
    }

    pub fn unknown(name: &str) -> Self {
        Self {
            name: name.into(),
            bundle: None,
            restriction: None,
            platform_digest: None,
            last_used: 0,
        }
    }

    fn is_known(&self) -> bool {
        self.bundle.is_some() && self.restriction.is_some() && self.platform_digest.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageRecord {
    pub platform_digest: String,
    pub known: bool,
    pub last_used: u64,
}

impl ImageRecord {
    pub fn known(platform_digest: &str, last_used: u64) -> Self {
        Self {
            platform_digest: platform_digest.into(),
            known: true,
            last_used,
        }
    }

    pub fn unknown(identifier: &str) -> Self {
        Self {
            platform_digest: identifier.into(),
            known: false,
            last_used: 0,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeInventory {
    pub vms: Vec<VmRecord>,
    pub images: Vec<ImageRecord>,
    pub running_vms: BTreeSet<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GcPlan {
    pub delete_vms: Vec<String>,
    pub prune_images: Vec<String>,
    pub protected_unknown: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageUsage {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub reserve_bytes: u64,
}

impl StorageUsage {
    pub fn new(total_bytes: u64, used_bytes: u64, reserve_bytes: u64) -> Self {
        Self {
            total_bytes,
            used_bytes,
            reserve_bytes,
        }
    }

    pub fn available_bytes(self) -> u64 {
        self.total_bytes.saturating_sub(self.used_bytes)
    }

    pub fn can_acquire(self) -> bool {
        self.available_bytes() >= self.reserve_bytes
    }
}

pub fn required_reserve(total_bytes: u64) -> u64 {
    (total_bytes / 5).max(512 * 1024 * 1024)
}

pub fn plan_gc(
    inventory: &RuntimeInventory,
    active_restrictions: &BTreeSet<String>,
    pinned_platform_digests: &BTreeSet<String>,
) -> GcPlan {
    let mut reclaimable_vms: Vec<&VmRecord> = inventory
        .vms
        .iter()
        .filter(|vm| {
            vm.is_known()
                && !inventory.running_vms.contains(&vm.name)
                && vm
                    .restriction
                    .as_ref()
                    .is_some_and(|restriction| !active_restrictions.contains(restriction))
                && vm
                    .platform_digest
                    .as_ref()
                    .is_some_and(|digest| !pinned_platform_digests.contains(digest))
        })
        .collect();
    reclaimable_vms.sort_by_key(|vm| (vm.last_used, &vm.name));

    let mut reclaimable_images: Vec<&ImageRecord> = inventory
        .images
        .iter()
        .filter(|image| image.known && !pinned_platform_digests.contains(&image.platform_digest))
        .collect();
    reclaimable_images.sort_by_key(|image| (image.last_used, &image.platform_digest));

    let mut protected_unknown: Vec<String> = inventory
        .vms
        .iter()
        .filter(|vm| !vm.is_known())
        .map(|vm| vm.name.clone())
        .chain(
            inventory
                .images
                .iter()
                .filter(|image| !image.known)
                .map(|image| image.platform_digest.clone()),
        )
        .collect();
    protected_unknown.sort();

    GcPlan {
        delete_vms: reclaimable_vms
            .into_iter()
            .map(|vm| vm.name.clone())
            .collect(),
        prune_images: reclaimable_images
            .into_iter()
            .map(|image| image.platform_digest.clone())
            .collect(),
        protected_unknown,
    }
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
