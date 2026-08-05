// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use cloister_host_runtime::execution::LeylineExecutionBackend;
use cloister_host_runtime::{HostRuntime, LaunchPlan};
use leyline_runtime::backends::libkrun::backend::{KrunWorkerBackend, KrunWorkerConfig};

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
/// Every path is an env var with a documented default, because these are
/// DEPLOYMENT facts — LLO ADR-0036 turns on exactly this: an issuer that knows
/// its deployment can predict the confinement document, and these are what it
/// would need to know. They are read here, at the one place the backend is
/// constructed, rather than threaded through the launch plan: a workload must
/// not be able to name its own runtime files.
fn krun_config() -> KrunWorkerConfig {
    let path = |var: &str, default: &str| -> PathBuf {
        std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(default))
    };
    KrunWorkerConfig {
        worker: path("CLOISTER_KRUN_WORKER", "/usr/local/libexec/leyline-krun-worker"),
        cas_root: path("CLOISTER_CAS_ROOT", "/var/lib/cloister/cas"),
        ephemeral_root: path("CLOISTER_EPHEMERAL_ROOT", "/var/lib/cloister/run"),
        libkrun: path("CLOISTER_LIBKRUN", "/usr/local/lib/libkrun.dylib"),
        runtime_files: Vec::new(),
        devices: Vec::new(),
        ready_timeout: Duration::from_secs(30),
        // Off, and not reachable from a launch plan. LLO's own comment is the
        // reason and it is cloister's too: a workload must not widen its own
        // boundary. Turning this on is an operator decision about a deployment,
        // which is why it is not an env var here either — flip it deliberately.
        tsi_hijack_inet: false,
    }
}

fn backend() -> LeylineExecutionBackend<KrunWorkerBackend> {
    LeylineExecutionBackend::new(Arc::new(KrunWorkerBackend::new(krun_config())))
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        bail!(
            "usage: cloister-host-runtime <validate|run|doctor> [plan.json]"
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
            let path = args
                .next()
                .context("usage: cloister-host-runtime run <plan.json>")?;
            if args.next().is_some() {
                bail!("run accepts exactly one plan path");
            }
            let plan = read_plan(Path::new(&path))?;

            HostRuntime::new(None, Some(Arc::new(backend())))
                .launch(&plan)
                .context("launch refused")
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
                    "microvm": {"available": backend().available()},
                }))?
            );
            Ok(())
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
        _ => bail!("unknown command {command:?}; expected validate, run, or doctor"),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cloister-host-runtime: {error:#}");
        std::process::exit(1);
    }
}
