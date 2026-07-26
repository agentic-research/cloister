// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::Path;

use anyhow::{bail, Context, Result};
use cloister_host_runtime::{HostRuntime, LaunchPlan};

fn read_plan(path: &Path) -> Result<LaunchPlan> {
    let bytes =
        std::fs::read(path).with_context(|| format!("reading launch plan {}", path.display()))?;
    let plan: LaunchPlan = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing launch plan {}", path.display()))?;
    plan.validate().context("validating launch plan")?;
    Ok(plan)
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        bail!("usage: cloister-host-runtime <validate|run|doctor> [plan.json]");
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

            // Backends are added explicitly as their enforcement implementations
            // land. None means unavailable, and HostRuntime refuses to substitute
            // a plain subprocess for a requested microVM.
            HostRuntime::new(None, None)
                .launch(&plan)
                .context("launch refused")
        }
        "doctor" => {
            if args.next().is_some() {
                bail!("doctor accepts no arguments");
            }
            println!(
                "{{\"schema\":\"cloister/host-runtime/doctor/v1\",\
                 \"process\":{{\"available\":false}},\
                 \"microvm\":{{\"available\":false}}}}"
            );
            Ok(())
        }
        _ => bail!("unknown command {command:?}; expected validate, run, or doctor"),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cloister-host-runtime: {error:#}");
        std::process::exit(1);
    }
}
