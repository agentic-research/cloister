// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::Path;
#[cfg(feature = "llo-execution")]
use std::path::PathBuf;
#[cfg(feature = "llo-execution")]
use std::sync::Arc;
#[cfg(feature = "llo-execution")]
use std::time::Duration;

use anyhow::{bail, Context, Result};
#[cfg(feature = "llo-execution")]
use cloister_host_runtime::execution::{Deployment, LeylineExecutionBackend};
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
        bail!("usage: cloister-host-runtime <validate|run|doctor|import-oci> [args]");
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
            let path = args
                .next()
                .context("usage: cloister-host-runtime run <plan.json>")?;
            if args.next().is_some() {
                bail!("run accepts exactly one plan path");
            }
            let plan = read_plan(Path::new(&path))?;

            #[cfg(feature = "llo-execution")]
            {
                // LLO refuses a bind grant whose directory is missing; create
                // it (0700) only after the plan has been validated.
                plan.validate().context("launch refused")?;
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
                launched
                    .map_err(|error| match error {
                        // The run happened; "launch refused" would send the
                        // reader to the plan when the answer is in the guest.
                        cloister_host_runtime::RuntimeError::RunFailed(_) => {
                            anyhow::Error::new(error)
                        }
                        // A distinct exit status, not just a message: see
                        // EXIT_WALL_CLOCK.
                        cloister_host_runtime::RuntimeError::WallClockExceeded(_) => {
                            eprintln!("cloister-host-runtime: {error}");
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
                let _ = plan;
                bail!(
                    "no execution backend: this binary was built without the \
                     `llo-execution` feature, which carries ley-line-open's runtime \
                     and the nono/sigstore closure threat model §17.1 keeps opt-in. \
                     Rebuild with --features llo-execution to execute tenants."
                )
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
            let usage = "usage: cloister-host-runtime import-oci --layout <dir> --image <sha256:…|name@sha256:…> [--symlinks refuse|resolve]";
            let (mut layout, mut image, mut symlinks) = (None, None, String::from("refuse"));
            while let Some(flag) = args.next() {
                let value = args
                    .next()
                    .with_context(|| format!("{flag} needs a value; {usage}"))?;
                match flag.as_str() {
                    "--layout" => layout = Some(std::path::PathBuf::from(value)),
                    "--image" => image = Some(value),
                    "--symlinks" => symlinks = value,
                    other => bail!("unknown flag {other:?}; {usage}"),
                }
            }
            let layout = layout.context(usage)?;
            let image = image.context(usage)?;
            #[cfg(feature = "llo-execution")]
            {
                use leyline_runtime::artifacts::oci::{
                    import_oci_layout, OciImport, Platform, SymlinkPolicy, DEFAULT_MAX_ROOTFS_BYTES,
                };
                let symlinks = match symlinks.as_str() {
                    "refuse" => SymlinkPolicy::Refuse,
                    "resolve" => SymlinkPolicy::Resolve,
                    other => bail!("--symlinks must be refuse or resolve, not {other:?}"),
                };
                let cas_root = krun_config().cas_root;
                let imported = import_oci_layout(
                    &OciImport {
                        layout: &layout,
                        reference: &image,
                        platform: Platform::host()?,
                        symlinks,
                        max_rootfs_bytes: DEFAULT_MAX_ROOTFS_BYTES,
                    },
                    &cas_root,
                )
                .with_context(|| format!("import {image} from {}", layout.display()))?;
                println!("{}", serde_json::to_string(&imported)?);
                Ok(())
            }
            #[cfg(not(feature = "llo-execution"))]
            {
                let _ = (layout, image, symlinks);
                bail!("import-oci needs the `llo-execution` feature (ley-line-open's runtime)")
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
        _ => bail!("unknown command {command:?}; expected validate, run, doctor, or import-oci"),
    }
}

/// Set by the stop thread before it cancels; read by the launching thread.
#[cfg(feature = "llo-execution")]
static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Block SIGINT and SIGTERM in the calling thread (and every thread it later
/// spawns) and return the set, for `stop_on_signal` to `sigwait` on.
#[cfg(feature = "llo-execution")]
fn block_stop_signals() -> Result<libc::sigset_t> {
    // SAFETY: sigemptyset/sigaddset initialise a local set; pthread_sigmask
    // only changes this thread's mask.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGTERM);
        let rc = libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        if rc != 0 {
            bail!("block SIGINT/SIGTERM: {}", std::io::Error::from_raw_os_error(rc));
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
            eprintln!(
                "cloister-host-runtime: sigwait failed ({}); the run cannot be stopped by signal",
                std::io::Error::from_raw_os_error(rc)
            );
            return;
        }
        STOPPING.store(true, std::sync::atomic::Ordering::SeqCst);
        let name = if signal == libc::SIGINT { "SIGINT" } else { "SIGTERM" };
        match backend.cancel(&plan) {
            Ok(_) => eprintln!("cloister-host-runtime: {name}: run for {} stopped", plan.bundle),
            Err(error) => eprintln!(
                "cloister-host-runtime: {name}: stopping the run for {} failed: {error}",
                plan.bundle
            ),
        }
        std::process::exit(128 + signal);
    });
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cloister-host-runtime: {error:#}");
        std::process::exit(1);
    }
}
