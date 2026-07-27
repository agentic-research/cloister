// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
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
    pub reserve_bytes: Option<u64>,
}

impl Default for KrunvmSettings {
    fn default() -> Self {
        Self {
            storage_volume: PathBuf::from("/Volumes/krunvm"),
            cpus: 1,
            memory_mib: 1024,
            dns: "1.1.1.1".into(),
            host_arch: std::env::consts::ARCH.into(),
            reserve_bytes: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, command: &CommandSpec) -> Result<CommandOutput, String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, command: &CommandSpec) -> Result<CommandOutput, String> {
        if command.program == "krunvm" && command.args.first().is_some_and(|arg| arg == "start") {
            let status = Command::new(&command.program)
                .args(&command.args)
                .status()
                .map_err(|error| format!("running {}: {error}", command.program))?;
            return Ok(CommandOutput {
                success: status.success(),
                stdout: String::new(),
                stderr: String::new(),
            });
        }
        let output = Command::new(&command.program)
            .args(&command.args)
            .output()
            .map_err(|error| format!("running {}: {error}", command.program))?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedVm {
    bundle: String,
    restriction: String,
    artifact_index_digest: String,
    platform_digest: String,
    #[serde(default)]
    active: bool,
    running: bool,
    last_used: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RuntimeState {
    schema: String,
    #[serde(default)]
    vms: BTreeMap<String, PersistedVm>,
}

struct StateLock(File);

impl StateLock {
    fn acquire(storage: &Path) -> Result<Self, RuntimeError> {
        std::fs::create_dir_all(storage).map_err(|error| {
            RuntimeError::Backend(format!(
                "creating krunvm storage {}: {error}",
                storage.display()
            ))
        })?;
        let path = storage.join("cloister-runtime.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| {
                RuntimeError::Backend(format!("opening state lock {}: {error}", path.display()))
            })?;
        // SAFETY: flock only observes the valid descriptor owned by `file`.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result != 0 {
            return Err(RuntimeError::Backend(format!(
                "locking {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            )));
        }
        Ok(Self(file))
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        // SAFETY: the descriptor remains valid until this Drop implementation returns.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub struct KrunvmBackend<R> {
    runner: R,
    settings: KrunvmSettings,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub schema: &'static str,
    pub storage_volume: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub reserve_bytes: u64,
    pub can_acquire: bool,
    pub tracked_vms: usize,
    pub running_vms: usize,
}

impl<R> KrunvmBackend<R> {
    pub fn new(runner: R, settings: KrunvmSettings) -> Self {
        Self { runner, settings }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectOutput {
    from_image: String,
    from_image_digest: String,
}

const STATE_SCHEMA: &str = "cloister/krunvm-state/v1";

impl<R: CommandRunner> KrunvmBackend<R> {
    fn state_path(&self) -> PathBuf {
        self.settings.storage_volume.join("cloister-runtime.json")
    }

    fn load_state(&self) -> Result<RuntimeState, RuntimeError> {
        let path = self.state_path();
        match std::fs::read(&path) {
            Ok(bytes) => {
                let state: RuntimeState = serde_json::from_slice(&bytes).map_err(|error| {
                    RuntimeError::Backend(format!("parsing state {}: {error}", path.display()))
                })?;
                if state.schema != STATE_SCHEMA {
                    return Err(RuntimeError::Backend(format!(
                        "unsupported state schema {:?} in {}",
                        state.schema,
                        path.display()
                    )));
                }
                Ok(state)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RuntimeState {
                schema: STATE_SCHEMA.into(),
                vms: BTreeMap::new(),
            }),
            Err(error) => Err(RuntimeError::Backend(format!(
                "reading state {}: {error}",
                path.display()
            ))),
        }
    }

    fn save_state(&self, state: &RuntimeState) -> Result<(), RuntimeError> {
        let path = self.state_path();
        let temp = path.with_extension(format!("json.tmp.{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|error| RuntimeError::Backend(format!("serializing state: {error}")))?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|error| {
                RuntimeError::Backend(format!("opening state temp {}: {error}", temp.display()))
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                RuntimeError::Backend(format!("writing state temp {}: {error}", temp.display()))
            })?;
        std::fs::rename(&temp, &path).map_err(|error| {
            RuntimeError::Backend(format!(
                "installing state {} from {}: {error}",
                path.display(),
                temp.display()
            ))
        })
    }

    fn execute(&self, command: &CommandSpec) -> Result<CommandOutput, RuntimeError> {
        self.runner.run(command).map_err(RuntimeError::Backend)
    }

    fn inspect(&self, name: &str) -> Result<CommandOutput, RuntimeError> {
        self.execute(&CommandSpec {
            program: "krunvm".into(),
            args: vec!["inspect".into(), name.into()],
        })
    }

    fn delete(&self, name: &str) {
        let _ = self.execute(&CommandSpec {
            program: "krunvm".into(),
            args: vec!["delete".into(), name.into()],
        });
    }

    fn verify_source(
        &self,
        output: &CommandOutput,
        expected: &str,
    ) -> Result<InspectOutput, RuntimeError> {
        let inspected: InspectOutput = serde_json::from_str(&output.stdout).map_err(|error| {
            RuntimeError::Backend(format!("parsing krunvm inspect output: {error}"))
        })?;
        if inspected.from_image != expected {
            return Err(RuntimeError::Backend(format!(
                "krunvm source mismatch: expected {expected:?}, got {:?}",
                inspected.from_image
            )));
        }
        Ok(inspected)
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn storage_usage(&self) -> Result<StorageUsage, RuntimeError> {
        let path = std::ffi::CString::new(
            self.settings
                .storage_volume
                .to_str()
                .ok_or_else(|| RuntimeError::Backend("storage path is not valid UTF-8".into()))?,
        )
        .map_err(|_| RuntimeError::Backend("storage path contains a NUL byte".into()))?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `path` is NUL-terminated and `stats` points to writable storage.
        if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
            return Err(RuntimeError::Backend(format!(
                "reading storage usage for {}: {}",
                self.settings.storage_volume.display(),
                std::io::Error::last_os_error()
            )));
        }
        // SAFETY: statvfs returned success and initialized `stats`.
        let stats = unsafe { stats.assume_init() };
        let block_size = stats.f_frsize;
        let total_bytes = u64::from(stats.f_blocks).saturating_mul(block_size);
        let available_bytes = u64::from(stats.f_bavail).saturating_mul(block_size);
        let reserve_bytes = self
            .settings
            .reserve_bytes
            .unwrap_or_else(|| required_reserve(total_bytes));
        Ok(StorageUsage::new(
            total_bytes,
            total_bytes.saturating_sub(available_bytes),
            reserve_bytes,
        ))
    }

    fn inventory(state: &RuntimeState) -> RuntimeInventory {
        let mut images = BTreeMap::<String, u64>::new();
        let mut running_vms = BTreeSet::new();
        let vms = state
            .vms
            .iter()
            .map(|(name, record)| {
                images
                    .entry(record.platform_digest.clone())
                    .and_modify(|last_used| *last_used = (*last_used).max(record.last_used))
                    .or_insert(record.last_used);
                if record.running {
                    running_vms.insert(name.clone());
                }
                VmRecord::known(
                    name,
                    &record.bundle,
                    &record.restriction,
                    &record.platform_digest,
                    record.last_used,
                )
            })
            .collect();
        RuntimeInventory {
            vms,
            images: images
                .into_iter()
                .map(|(digest, last_used)| ImageRecord::known(&digest, last_used))
                .collect(),
            running_vms,
        }
    }

    pub fn gc(
        &self,
        active_restrictions: &BTreeSet<String>,
        pinned_platform_digests: &BTreeSet<String>,
        execute: bool,
    ) -> Result<GcReport, RuntimeError> {
        let _lock = StateLock::acquire(&self.settings.storage_volume)?;
        let mut state = self.load_state()?;
        let mut active_restrictions = active_restrictions.clone();
        let mut pinned_platform_digests = pinned_platform_digests.clone();
        for record in state.vms.values().filter(|record| record.active) {
            active_restrictions.insert(record.restriction.clone());
            pinned_platform_digests.insert(record.platform_digest.clone());
        }
        let plan = plan_gc(
            &Self::inventory(&state),
            &active_restrictions,
            &pinned_platform_digests,
        );
        if execute {
            for name in &plan.delete_vms {
                let output = self.execute(&CommandSpec {
                    program: "krunvm".into(),
                    args: vec!["delete".into(), name.clone()],
                })?;
                if !output.success {
                    return Err(RuntimeError::Backend(format!(
                        "krunvm delete {name:?} failed: {}",
                        output.stderr.trim()
                    )));
                }
                state.vms.remove(name);
            }
            if !plan.prune_images.is_empty() {
                let output = self.execute(&CommandSpec {
                    program: "buildah".into(),
                    args: vec![
                        "--root".into(),
                        self.settings
                            .storage_volume
                            .join("root")
                            .display()
                            .to_string(),
                        "--runroot".into(),
                        self.settings
                            .storage_volume
                            .join("runroot")
                            .display()
                            .to_string(),
                        "rmi".into(),
                        "--prune".into(),
                    ],
                })?;
                if !output.success {
                    return Err(RuntimeError::Backend(format!(
                        "buildah prune failed: {}",
                        output.stderr.trim()
                    )));
                }
            }
            self.save_state(&state)?;
        }
        Ok(GcReport {
            plan,
            executed: execute,
        })
    }

    pub fn status(&self) -> Result<RuntimeStatus, RuntimeError> {
        let _lock = StateLock::acquire(&self.settings.storage_volume)?;
        let state = self.load_state()?;
        let usage = self.storage_usage()?;
        Ok(RuntimeStatus {
            schema: "cloister/krunvm-status/v1",
            storage_volume: self.settings.storage_volume.display().to_string(),
            total_bytes: usage.total_bytes,
            used_bytes: usage.used_bytes,
            available_bytes: usage.available_bytes(),
            reserve_bytes: usage.reserve_bytes,
            can_acquire: usage.can_acquire(),
            tracked_vms: state.vms.len(),
            running_vms: state.vms.values().filter(|record| record.running).count(),
        })
    }
}

impl<R: CommandRunner> crate::Backend for KrunvmBackend<R> {
    fn launch(&self, plan: &LaunchPlan) -> Result<(), RuntimeError> {
        let restriction = restriction_digest(plan, &self.settings)?;
        let restriction_hex = hex_digest(&restriction);
        let name = vm_name(&plan.bundle, &restriction);
        let expected_source = format!("{}@{}", plan.artifact.image, plan.artifact.digest);
        let _lock = StateLock::acquire(&self.settings.storage_volume)?;
        let mut state = self.load_state()?;
        let initial_inspect = self.inspect(&name)?;

        let inspected = if initial_inspect.success {
            let record = state.vms.get(&name).ok_or_else(|| {
                RuntimeError::Backend(format!("refusing untracked deterministic krunvm {name:?}"))
            })?;
            if record.restriction != restriction_hex {
                return Err(RuntimeError::Backend(format!(
                    "restriction collision for krunvm {name:?}"
                )));
            }
            self.verify_source(&initial_inspect, &expected_source)?
        } else {
            let usage = self.storage_usage()?;
            if !usage.can_acquire() {
                return Err(RuntimeError::Backend(format!(
                    "krunvm storage reserve would be breached: {} bytes available, {} required",
                    usage.available_bytes(),
                    usage.reserve_bytes
                )));
            }
            let create = create_command(plan, &self.settings)?;
            let created = self.execute(&create)?;
            if !created.success {
                self.delete(&name);
                return Err(RuntimeError::Backend(format!(
                    "krunvm create failed: {}",
                    created.stderr.trim()
                )));
            }
            let verified = self.inspect(&name)?;
            if !verified.success {
                self.delete(&name);
                return Err(RuntimeError::Backend(format!(
                    "krunvm inspect after create failed: {}",
                    verified.stderr.trim()
                )));
            }
            match self.verify_source(&verified, &expected_source) {
                Ok(inspected) => inspected,
                Err(error) => {
                    self.delete(&name);
                    return Err(error);
                }
            }
        };

        for record in state
            .vms
            .values_mut()
            .filter(|record| record.bundle == plan.bundle)
        {
            record.active = false;
        }
        state.vms.insert(
            name.clone(),
            PersistedVm {
                bundle: plan.bundle.clone(),
                restriction: restriction_hex,
                artifact_index_digest: plan.artifact.digest.clone(),
                platform_digest: inspected.from_image_digest,
                active: true,
                running: true,
                last_used: Self::now(),
            },
        );
        self.save_state(&state)?;
        drop(_lock);

        let started = self.execute(&start_command(plan, &self.settings)?)?;

        let _lock = StateLock::acquire(&self.settings.storage_volume)?;
        let mut state = self.load_state()?;
        if let Some(record) = state.vms.get_mut(&name) {
            record.running = false;
            record.last_used = Self::now();
        }
        self.save_state(&state)?;
        if !started.success {
            return Err(RuntimeError::Backend(format!(
                "krunvm start failed: {}",
                started.stderr.trim()
            )));
        }
        Ok(())
    }
}

fn hex_digest(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct GcPlan {
    pub delete_vms: Vec<String>,
    pub prune_images: Vec<String>,
    pub protected_unknown: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GcReport {
    pub plan: GcPlan,
    pub executed: bool,
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

    let delete_vm_names: BTreeSet<&str> =
        reclaimable_vms.iter().map(|vm| vm.name.as_str()).collect();
    let retained_platform_digests: BTreeSet<&str> = inventory
        .vms
        .iter()
        .filter(|vm| !delete_vm_names.contains(vm.name.as_str()))
        .filter_map(|vm| vm.platform_digest.as_deref())
        .collect();
    let mut reclaimable_images: Vec<&ImageRecord> = inventory
        .images
        .iter()
        .filter(|image| {
            image.known
                && !pinned_platform_digests.contains(&image.platform_digest)
                && !retained_platform_digests.contains(image.platform_digest.as_str())
        })
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
