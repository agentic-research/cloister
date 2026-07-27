// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use cloister_host_runtime::krunvm::{KrunvmBackend, KrunvmSettings, SystemCommandRunner};
use cloister_host_runtime::{HostRuntime, LaunchPlan};

fn read_plan(path: &Path) -> Result<LaunchPlan> {
    let bytes =
        std::fs::read(path).with_context(|| format!("reading launch plan {}", path.display()))?;
    let plan: LaunchPlan = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing launch plan {}", path.display()))?;
    plan.validate().context("validating launch plan")?;
    Ok(plan)
}

fn krunvm_settings() -> KrunvmSettings {
    let mut settings = KrunvmSettings::default();
    if let Some(volume) = std::env::var_os("CLOISTER_KRUNVM_VOLUME") {
        settings.storage_volume = volume.into();
    }
    settings
}

fn backend() -> KrunvmBackend<SystemCommandRunner> {
    KrunvmBackend::new(SystemCommandRunner, krunvm_settings())
}

fn executable_available(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .any(|candidate| candidate.is_file())
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        bail!(
            "usage: cloister-host-runtime <validate|run|doctor|status|gc> \
             [plan.json|--print|--yes]"
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
            let status = backend().status().context("checking krunvm storage")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "schema": "cloister/host-runtime/doctor/v1",
                    "process": {"available": false},
                    "microvm": {
                        "available": executable_available("krunvm")
                            && executable_available("buildah"),
                        "krunvm": executable_available("krunvm"),
                        "buildah": executable_available("buildah"),
                    },
                    "storage": status,
                }))?
            );
            Ok(())
        }
        "status" => {
            if args.next().is_some() {
                bail!("status accepts no arguments");
            }
            println!("{}", serde_json::to_string_pretty(&backend().status()?)?);
            Ok(())
        }
        "gc" => {
            let execute = match args.next().as_deref() {
                None | Some("--print") => false,
                Some("--yes") => true,
                Some(other) => bail!("unknown gc option {other:?}; expected --print or --yes"),
            };
            if args.next().is_some() {
                bail!("gc accepts at most one of --print or --yes");
            }
            let report = backend().gc(&BTreeSet::new(), &BTreeSet::new(), execute)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        _ => bail!("unknown command {command:?}; expected validate, run, doctor, status, or gc"),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cloister-host-runtime: {error:#}");
        std::process::exit(1);
    }
}
