// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::Path;
use std::path::PathBuf;
#[cfg(feature = "llo-execution")]
use std::sync::Arc;
#[cfg(feature = "llo-execution")]
use std::time::Duration;

use anyhow::{bail, Context, Result};
#[cfg(feature = "llo-execution")]
use cloister_host_runtime::execution::{CancelOutcome, Deployment, LeylineExecutionBackend};
#[cfg(feature = "llo-execution")]
use cloister_host_runtime::HostRuntime;
use cloister_host_runtime::LaunchPlan;
#[cfg(feature = "llo-execution")]
use leyline_runtime::backends::libkrun::backend::{KrunWorkerBackend, KrunWorkerConfig};

/// Whether this build can confine a workload at all.
///
/// `false` without `llo-execution` is the honest answer, not a probe failure:
/// there is no backend compiled in to ask.
#[cfg(feature = "llo-execution")]
fn microvm_available() -> bool {
    backend().available()
}
#[cfg(not(feature = "llo-execution"))]
fn microvm_available() -> bool {
    false
}

fn read_plan(path: &Path) -> Result<LaunchPlan> {
    let bytes =
        std::fs::read(path).with_context(|| format!("reading launch plan {}", path.display()))?;
    let plan: LaunchPlan = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing launch plan {}", path.display()))?;
    plan.validate().context("validating launch plan")?;
    Ok(plan)
}

/// Deployment configuration for LLO's microVM backend (cloister-17e502).
///
/// Behind `llo-execution` per threat model §17.1 — see Cargo.toml. Without the
/// feature there is no backend, and `HostRuntime` refuses rather than falling
/// back to running on the host.
#[cfg(feature = "llo-execution")]
///
/// Every path is an env var with a documented default, because these are
/// DEPLOYMENT facts — LLO ADR-0036 turns on exactly this: an issuer that knows
/// its deployment can predict the confinement document, and these are what it
/// would need to know. They are read here, at the one place the backend is
/// constructed, rather than threaded through the launch plan: a workload must
/// not be able to name its own runtime files.
fn krun_config() -> KrunWorkerConfig {
    let path = |var: &str, default: &str| -> PathBuf {
        std::env::var_os(var)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(default))
    };
    KrunWorkerConfig {
        worker: path(
            "CLOISTER_KRUN_WORKER",
            "/usr/local/libexec/leyline-krun-worker",
        ),
        cas_root: path("CLOISTER_CAS_ROOT", "/var/lib/cloister/cas"),
        ephemeral_root: path("CLOISTER_EPHEMERAL_ROOT", "/var/lib/cloister/run"),
        // LLO v0.21 (bead ley-line-open-f1c46f): the worker LINKS libkrun, so
        // there is no libkrun path to configure (`CLOISTER_LIBKRUN` is gone).
        // libkrunfw is still loaded at run time and must be granted to the
        // worker as a runtime file; no default is guessed, since a wrong path
        // would be granted into the confinement document.
        runtime_files: std::env::var_os("CLOISTER_LIBKRUNFW")
            .map(PathBuf::from)
            .into_iter()
            .collect(),
        devices: Vec::new(),
        ready_timeout: Duration::from_secs(30),
        // Off, and not reachable from a launch plan. LLO's own comment is the
        // reason and it is cloister's too: a workload must not widen its own
        // boundary. Turning this on is an operator decision about a deployment,
        // which is why it is not an env var here either — flip it deliberately.
        tsi_hijack_inet: false,
    }
}

#[cfg(feature = "llo-execution")]
fn backend() -> LeylineExecutionBackend<KrunWorkerBackend> {
    let config = krun_config();
    // The deployment inputs LLO compiles its document from, taken from the
    // same config the backend gets, so cloister's carried document and the
    // worker's compiled one start from identical values.
    let deployment = Deployment {
        runtime_files: config.runtime_files.clone(),
        devices: config.devices.clone(),
    };
    LeylineExecutionBackend::new(Arc::new(KrunWorkerBackend::new(config)), deployment)
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        bail!(
            "usage: cloister-host-runtime <validate|run|doctor|guest-platform|platform-admits|import-oci|provision-cas|cas-attach|cas-status> [args]\n\
             CLOISTER_CAS_ROOT and CLOISTER_CAS_STATE_DIR are deployment inputs the cloister CLI sets \
             from its provider record. When both are set, run and import-oci check that the attached \
             volume's root IS that CAS root: a consistency check against a stale or hand-set value, \
             not a security boundary."
        );
    };

    match command.as_str() {
        "validate" => {
            let path = args
                .next()
                .context("usage: cloister-host-runtime validate <plan.json>")?;
            if args.next().is_some() {
                bail!("validate accepts exactly one plan path");
            }
            let plan = read_plan(Path::new(&path))?;
            println!(
                "valid: bundle={} mode={} artifact={}@{}",
                plan.bundle, plan.mode, plan.artifact.image, plan.artifact.digest
            );
            Ok(())
        }
        "run" => {
            let usage = "usage: cloister-host-runtime run [--stop-on-stdin-eof] <plan.json>";
            let mut stop_on_stdin_eof = false;
            let mut path = None;
            for arg in args.by_ref() {
                match arg.as_str() {
                    "--stop-on-stdin-eof" => stop_on_stdin_eof = true,
                    _ if path.is_none() && !arg.starts_with("--") => path = Some(arg),
                    other => bail!("unexpected argument {other:?}; {usage}"),
                }
            }
            let path = path.context(usage)?;
            let plan = read_plan(Path::new(&path))?;

            #[cfg(feature = "llo-execution")]
            {
                // LLO refuses a bind grant whose directory is missing; create
                // it (0700) only after the plan has been validated.
                plan.validate().context("launch refused")?;
                // Attach (or refuse) BEFORE creating any channel directory, so a
                // refusal leaves nothing behind.
                ensure_cas_volume_attached(&krun_config().cas_root).context("launch refused")?;
                cloister_host_runtime::prepare_channel_dirs(&plan).context("launch refused")?;
                // SIGINT/SIGTERM must stop the GUEST, not just this process:
                // the worker is in its own process group and would outlive us.
                // Blocked here, before any thread exists, so every thread
                // inherits the mask and only the stop thread receives them.
                // (std's Command clears the mask in children, so the worker
                // starts with default signal handling.)
                let signals = block_stop_signals()?;
                let backend = Arc::new(backend());
                stop_on_signal(signals, Arc::clone(&backend), plan.clone());
                // Supervised (`cluster up`): EOF on stdin means the supervisor
                // is gone, even by SIGKILL. Routed through the same stop path
                // as SIGTERM by raising it at ourselves: it is blocked in
                // every thread, so the stop thread's sigwait takes it. A plain
                // `runtime run` by hand does not pass the flag and keeps
                // today's behaviour (stdin is not watched).
                if stop_on_stdin_eof {
                    std::thread::spawn(|| {
                        cloister_host_runtime::watch_for_eof(std::io::stdin().lock(), || {
                            cloister_host_runtime::note!("cloister-host-runtime: stdin closed: the supervisor is gone; stopping");
                            // SAFETY: kill(getpid(), SIGTERM) only signals this process.
                            unsafe {
                                libc::kill(libc::getpid(), libc::SIGTERM);
                            }
                        });
                    });
                }
                let launched = HostRuntime::new(None, Some(backend)).launch(&plan);
                // A stop in progress owns the exit: LLO's cancel wakes this
                // thread's wait with "run_id is not active", which is not the
                // run failing. Let the stop thread finish cleanup and exit
                // 128+signal, so the supervisor sees one deterministic status.
                if STOPPING.load(std::sync::atomic::Ordering::SeqCst) {
                    loop {
                        std::thread::park();
                    }
                }
                launched.map_err(|error| match error {
                    // The run happened; "launch refused" would send the
                    // reader to the plan when the answer is in the guest.
                    cloister_host_runtime::RuntimeError::RunFailed(_) => anyhow::Error::new(error),
                    // A distinct exit status, not just a message: see
                    // EXIT_WALL_CLOCK.
                    cloister_host_runtime::RuntimeError::WallClockExceeded(_) => {
                        cloister_host_runtime::note!("cloister-host-runtime: {error}");
                        std::process::exit(cloister_host_runtime::EXIT_WALL_CLOCK);
                    }
                    other => anyhow::Error::new(other).context("launch refused"),
                })
            }
            // Fails closed, and says which build it is. `BackendUnavailable`
            // alone would read as a broken deployment rather than a deliberate
            // one.
            #[cfg(not(feature = "llo-execution"))]
            {
                let _ = (plan, stop_on_stdin_eof);
                bail!(
                    "no execution backend: this binary was built without the \
                     `llo-execution` feature, which carries ley-line-open's runtime \
                     and the nono/sigstore closure threat model §17.1 keeps opt-in. \
                     Rebuild with --features llo-execution to execute tenants."
                )
            }
        }
        // The guest platform this host boots (cloister-1c4ef5): LLO's
        // `Platform::host()`, the SAME value `import-oci` asks LLO to select
        // from an image index. The CLI picks the lock's rootfs row with it, so
        // "the platform this host runs" is decided here and nowhere else.
        "guest-platform" => {
            if args.next().is_some() {
                bail!("guest-platform accepts no arguments");
            }
            #[cfg(feature = "llo-execution")]
            {
                let platform = leyline_runtime::artifacts::oci::Platform::host()?;
                println!(
                    "{}",
                    serde_json::json!({ "platform": platform.to_string() })
                );
                Ok(())
            }
            #[cfg(not(feature = "llo-execution"))]
            {
                bail!("guest-platform needs the `llo-execution` feature (ley-line-open's runtime)")
            }
        }
        // Platform admission, answered by LLO's `Platform::admits` so nothing
        // in the CLI states the rule (cloister-b94b14). `--platform` must come
        // first; every following argument is a candidate platform.
        "platform-admits" => {
            let usage = "usage: cloister-host-runtime platform-admits --platform <os/arch[/variant]> <candidate>...";
            if args.next().as_deref() != Some("--platform") {
                bail!("platform-admits needs --platform first; {usage}");
            }
            let platform_arg = args
                .next()
                .with_context(|| format!("--platform needs a value; {usage}"))?;
            let candidates: Vec<String> = args.collect();
            if let Some(flag) = candidates.iter().find(|c| c.starts_with("--")) {
                bail!("unknown flag {flag:?}; {usage}");
            }
            #[cfg(feature = "llo-execution")]
            {
                use leyline_runtime::artifacts::oci::Platform;
                let platform: Platform = platform_arg
                    .parse()
                    .with_context(|| format!("--platform {platform_arg:?}"))?;
                let (mut admitted, mut overlapping) = (Vec::new(), Vec::new());
                for text in &candidates {
                    let candidate: Platform = text
                        .parse()
                        .with_context(|| format!("candidate platform {text:?}"))?;
                    let forward = platform.admits(&candidate);
                    if forward {
                        admitted.push(text.as_str());
                    }
                    if forward || candidate.admits(&platform) {
                        overlapping.push(text.as_str());
                    }
                }
                println!(
                    "{}",
                    serde_json::json!({
                        "platform": platform.to_string(),
                        "admitted": admitted,
                        "overlapping": overlapping,
                    })
                );
                Ok(())
            }
            #[cfg(not(feature = "llo-execution"))]
            {
                let _ = (platform_arg, candidates);
                bail!("platform-admits needs the `llo-execution` feature (ley-line-open's runtime)")
            }
        }
        "doctor" => {
            if args.next().is_some() {
                bail!("doctor accepts no arguments");
            }
            // Asks the BACKEND whether it can confine, rather than probing PATH
            // for `krunvm` and `buildah`. The old shape answered "are two
            // binaries installed" and was read as "can this host isolate a
            // workload" — a question it never asked.
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "schema": "cloister/host-runtime/doctor/v1",
                    "process": {"available": false},
                    "microvm": {"available": microvm_available()},
                }))?
            );
            Ok(())
        }
        // OCI image → CAS rootfs, through LLO's importer in-process
        // (ley-line-open-7736ab, cloister-3a6dd7). cloister does not convert
        // images itself: LLO verifies every blob and diff_id, selects the
        // host platform, applies whiteouts and publishes the tree under the
        // same CAS root the execution backend loads from, so the printed
        // `rootfs` is directly the plan's `blake3-256:` artifact digest.
        "import-oci" => {
            let usage = "usage: cloister-host-runtime import-oci (--layout <dir> --image <sha256:…|name@sha256:…> | --from-registry <[registry/]repository@sha256:…>) [--symlinks preserve|refuse|resolve]";
            let (mut layout, mut image, mut registry, mut symlinks) =
                (None, None, None, String::from("preserve"));
            while let Some(flag) = args.next() {
                let value = args
                    .next()
                    .with_context(|| format!("{flag} needs a value; {usage}"))?;
                match flag.as_str() {
                    "--layout" => layout = Some(std::path::PathBuf::from(value)),
                    "--image" => image = Some(value),
                    "--from-registry" => registry = Some(value),
                    "--symlinks" => symlinks = value,
                    other => bail!("unknown flag {other:?}; {usage}"),
                }
            }
            // Exactly one source: an on-disk layout, or a registry pull by
            // digest (LLO v0.29.0, ley-line-open-97b636; cloister-727354).
            let source = match (layout, image, registry) {
                (Some(layout), Some(image), None) => ImportSource::Layout(layout, image),
                (None, None, Some(reference)) => ImportSource::Registry(reference),
                _ => bail!("{usage}"),
            };
            #[cfg(feature = "llo-execution")]
            {
                use leyline_runtime::artifacts::oci::{
                    import_oci_layout, OciImport, Platform, SymlinkPolicy, DEFAULT_MAX_ROOTFS_BYTES,
                };
                use leyline_runtime::artifacts::registry::{
                    pull_oci_image, RegistryLimits, RegistryPull,
                };
                let symlinks = match symlinks.as_str() {
                    "preserve" => SymlinkPolicy::Preserve,
                    "refuse" => SymlinkPolicy::Refuse,
                    "resolve" => SymlinkPolicy::Resolve,
                    other => bail!("--symlinks must be preserve, refuse or resolve, not {other:?}"),
                };
                let cas_root = krun_config().cas_root;
                ensure_cas_volume_attached(&cas_root)?;
                let imported = match &source {
                    ImportSource::Layout(layout, image) => import_oci_layout(
                        &OciImport {
                            layout,
                            reference: image,
                            platform: Platform::host()?,
                            symlinks,
                            max_rootfs_bytes: DEFAULT_MAX_ROOTFS_BYTES,
                        },
                        &cas_root,
                    )
                    .with_context(|| format!("import {image} from {}", layout.display()))?,
                    // Anonymous HTTPS only: LLO's pull has no credentials in
                    // v1, so a private image is refused by the registry and
                    // that refusal is reported as-is.
                    ImportSource::Registry(reference) => pull_oci_image(
                        &RegistryPull {
                            reference,
                            platform: Platform::host()?,
                            symlinks,
                            max_rootfs_bytes: DEFAULT_MAX_ROOTFS_BYTES,
                            limits: RegistryLimits::default(),
                            insecure_plain_http: None,
                        },
                        &cas_root,
                    )
                    .map_err(|error| {
                        anyhow::anyhow!(
                            "pull {reference} from its registry: {}",
                            cloister_host_runtime::execution::registry_failure_message(&error)
                        )
                    })?,
                };
                println!("{}", serde_json::to_string(&imported)?);
                Ok(())
            }
            #[cfg(not(feature = "llo-execution"))]
            {
                let _ = (source, symlinks);
                bail!("import-oci needs the `llo-execution` feature (ley-line-open's runtime)")
            }
        }
        // The CAS volume (LLO v0.29.0 cas_volume, ley-line-open-ba86d3;
        // cloister-727354): a case-sensitive store so images whose trees hold
        // names differing only by case (Debian's perl: Pod/ and pod/) import on
        // macOS. `runtime install` calls provision-cas once and records the
        // returned casRoot; nothing else decides the CAS root.
        "provision-cas" | "cas-status" | "cas-attach" => {
            let usage = format!("usage: cloister-host-runtime {command} --state-dir <abs dir>");
            let mut state_dir = None;
            while let Some(flag) = args.next() {
                let value = args
                    .next()
                    .with_context(|| format!("{flag} needs a value; {usage}"))?;
                match flag.as_str() {
                    "--state-dir" => state_dir = Some(PathBuf::from(value)),
                    other => bail!("unknown flag {other:?}; {usage}"),
                }
            }
            let state_dir = state_dir.with_context(|| usage.clone())?;
            #[cfg(feature = "llo-execution")]
            {
                use leyline_runtime::cas_volume::{
                    is_mount_point, probe_sensitivity, CasVolume, DEFAULT_SIZE_CAP_BYTES,
                };
                let volume = CasVolume::new(&state_dir, DEFAULT_SIZE_CAP_BYTES)
                    .context("CAS volume configuration")?;
                if command == "cas-attach" {
                    // Re-attach a provisioned volume; NEVER create one. The CLI
                    // calls this before any CAS check, so a volume a reboot or
                    // logout detached reads as "attach it", never as "rootfs
                    // missing, re-import".
                    let attached = volume
                        .attach_existing()
                        .context("re-attach the CAS volume")?;
                    let reply = match attached {
                        Some(cas) => serde_json::json!({ "provisioned": true, "volume": cas }),
                        None => serde_json::json!({ "provisioned": false }),
                    };
                    println!("{}", serde_json::to_string(&reply)?);
                } else if command == "provision-cas" {
                    // Idempotent: creates the sparsebundle once, attaches it,
                    // reuses it attached. As the calling user, no sudo.
                    let provisioned = volume.provision().context("provision the CAS volume")?;
                    println!("{}", serde_json::to_string(&provisioned)?);
                } else {
                    // Read-only: reports, never creates or attaches.
                    let layout = volume.layout();
                    let attached = is_mount_point(&layout.mountpoint)?;
                    let filesystem = if layout.cas_root.is_dir() {
                        Some(probe_sensitivity(&layout.cas_root).with_context(|| {
                            format!("probe {}", layout.cas_root.display())
                        })?)
                    } else {
                        None
                    };
                    println!(
                        "{}",
                        serde_json::to_string(&serde_json::json!({
                            "casRoot": layout.cas_root,
                            "image": layout.image,
                            "imageExists": layout.image.exists(),
                            "mountpoint": layout.mountpoint,
                            "attached": attached,
                            "filesystem": filesystem,
                        }))?
                    );
                }
                Ok(())
            }
            #[cfg(not(feature = "llo-execution"))]
            {
                let _ = state_dir;
                bail!("{command} needs the `llo-execution` feature (ley-line-open's runtime)")
            }
        }
        // `status` and `gc` are GONE, not ported. Both managed krunvm's buildah
        // storage volume — listing it and pruning it — and that volume does not
        // exist once cloister stops driving krunvm. Porting them would have
        // meant inventing a new subject for a command whose old one was
        // retired, which is how a CLI accumulates verbs that do nothing.
        // LLO owns run lifecycle (cleanup_json); when cloister needs to drive
        // it, that is a new command named for what it actually does.
        "status" | "gc" => bail!(
            "{command} managed krunvm's buildah storage, which cloister no longer uses \
             (cloister-17e502). Run lifecycle now belongs to ley-line-open."
        ),
        _ => bail!(
            "unknown command {command:?}; expected validate, run, doctor, import-oci, provision-cas, or cas-status"
        ),
    }
}

/// Where `import-oci` reads an image from. (Without `llo-execution` there is
/// no importer, so the payloads are parsed and then unused.)
#[cfg_attr(not(feature = "llo-execution"), allow(dead_code))]
enum ImportSource {
    /// An on-disk OCI layout and the digest to import from it.
    Layout(PathBuf, String),
    /// `[registry/]repository@sha256:…`, pulled anonymously over HTTPS.
    Registry(String),
}

/// Re-attach the CAS volume if one is configured (CLOISTER_CAS_STATE_DIR,
/// set by `runtime install` through the provider record), and check it is the
/// CAS root this process was given. A sparsebundle is detached by logout or
/// reboot; `attach_existing` re-attaches it and NEVER creates one, so a run or
/// import after a reboot finds its store instead of an empty mountpoint.
#[cfg(feature = "llo-execution")]
fn ensure_cas_volume_attached(cas_root: &Path) -> Result<()> {
    use leyline_runtime::cas_volume::{CasVolume, DEFAULT_SIZE_CAP_BYTES};
    let Some(state_dir) = std::env::var_os("CLOISTER_CAS_STATE_DIR") else {
        return Ok(());
    };
    let volume = CasVolume::new(PathBuf::from(&state_dir), DEFAULT_SIZE_CAP_BYTES)
        .context("CAS volume configuration")?;
    match volume.attach_existing().context("re-attach the CAS volume")? {
        None => bail!(
            "no CAS volume is provisioned under {}; run `cloister runtime install`",
            PathBuf::from(&state_dir).display()
        ),
        Some(attached) if attached.cas_root != cas_root => bail!(
            "the CAS volume's root is {}, but this host runtime was given {}; re-run `cloister runtime install`",
            attached.cas_root.display(),
            cas_root.display()
        ),
        Some(_) => Ok(()),
    }
}

/// Set by the stop thread before it cancels; read by the launching thread.
#[cfg(feature = "llo-execution")]
static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Signals that stop the run (through LLO's cancel) rather than kill this
/// process and orphan the worker: a terminal hangup or quit must not leave a
/// VM behind any more than Ctrl-C may.
#[cfg(feature = "llo-execution")]
const STOP_SIGNALS: [libc::c_int; 4] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT];

/// Block the stop signals in the calling thread (and every thread it later
/// spawns) and return the set, for `stop_on_signal` to `sigwait` on.
#[cfg(feature = "llo-execution")]
fn block_stop_signals() -> Result<libc::sigset_t> {
    // SAFETY: sigemptyset/sigaddset initialise a local set; pthread_sigmask
    // only changes this thread's mask.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in STOP_SIGNALS {
            libc::sigaddset(&mut set, signal);
        }
        let rc = libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        if rc != 0 {
            bail!(
                "block stop signals: {}",
                std::io::Error::from_raw_os_error(rc)
            );
        }
        Ok(set)
    }
}

/// Wait for SIGINT/SIGTERM on a dedicated thread; on one, cancel the run
/// through LLO (which kills the worker's process group and cleans up) and
/// exit 128+signal. Exiting from here rather than returning to `launch` is
/// deliberate: LLO's cancel retires the run's completion, so the launching
/// thread's wait would never be woken.
#[cfg(feature = "llo-execution")]
fn stop_on_signal(
    set: libc::sigset_t,
    backend: Arc<LeylineExecutionBackend<KrunWorkerBackend>>,
    plan: LaunchPlan,
) {
    std::thread::spawn(move || {
        let mut signal: libc::c_int = 0;
        // SAFETY: `set` is the initialised set blocked in this process.
        let rc = unsafe { libc::sigwait(&set, &mut signal) };
        if rc != 0 {
            cloister_host_runtime::note!(
                "cloister-host-runtime: sigwait failed ({}); the run cannot be stopped by signal",
                std::io::Error::from_raw_os_error(rc)
            );
            return;
        }
        STOPPING.store(true, std::sync::atomic::Ordering::SeqCst);
        let name = match signal {
            libc::SIGINT => "SIGINT",
            libc::SIGHUP => "SIGHUP",
            libc::SIGQUIT => "SIGQUIT",
            _ => "SIGTERM",
        };
        let bundle = &plan.bundle;
        // Say what actually happened; "stopped" only for a real cancel.
        // Cancel before LLO publishes the run, and the worker noticing its
        // parent die, are LLO's: ley-line-open-f963e6.
        match backend.cancel(&plan) {
            Ok(CancelOutcome::Cancelled) => {
                cloister_host_runtime::note!("cloister-host-runtime: {name}: run for {bundle} stopped")
            }
            Ok(CancelOutcome::NeverStarted) => cloister_host_runtime::note!(
                "cloister-host-runtime: {name}: stop arrived before the run for {bundle} was started; it was not started"
            ),
            Ok(CancelOutcome::StartFailed) => cloister_host_runtime::note!(
                "cloister-host-runtime: {name}: the run for {bundle} had failed to start; nothing to stop"
            ),
            Ok(CancelOutcome::AlreadyEnded) => cloister_host_runtime::note!(
                "cloister-host-runtime: {name}: the run for {bundle} had already ended"
            ),
            Err(error) => cloister_host_runtime::note!(
                "cloister-host-runtime: {name}: stopping the run for {bundle} FAILED, its worker may still be running: {error}"
            ),
        }
        std::process::exit(128 + signal);
    });
}

fn main() {
    if let Err(error) = run() {
        cloister_host_runtime::note!("cloister-host-runtime: {error:#}");
        std::process::exit(1);
    }
}
