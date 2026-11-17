#![cfg(feature = "llo-execution")]
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `platform-admits` (cloister-b94b14) answers OCI platform admission with
// LLO's `Platform::admits`, so the CLI states no copy of the rule.

use std::process::{Command, Output};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .arg("platform-admits")
        .args(args)
        .output()
        .unwrap()
}

fn reply(args: &[&str]) -> serde_json::Value {
    let out = run(args);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn a_host_without_variant_admits_every_variant() {
    let r = reply(&[
        "--platform",
        "linux/arm64",
        "linux/arm64",
        "linux/arm64/v8",
        "linux/amd64",
    ]);
    assert_eq!(
        r["admitted"],
        serde_json::json!(["linux/arm64", "linux/arm64/v8"])
    );
}

#[test]
fn a_variant_host_admits_the_unvarianted_row_and_overlaps_it() {
    let r = reply(&[
        "--platform",
        "linux/arm64/v8",
        "linux/arm64",
        "linux/arm64/v9",
    ]);
    assert_eq!(r["admitted"], serde_json::json!(["linux/arm64"]));
    assert_eq!(r["overlapping"], serde_json::json!(["linux/arm64"]));
}

#[test]
fn different_variants_neither_admit_nor_overlap() {
    let r = reply(&["--platform", "linux/arm64/v8", "linux/arm64/v9"]);
    assert_eq!(r["admitted"], serde_json::json!([]));
    assert_eq!(r["overlapping"], serde_json::json!([]));
}

#[test]
fn a_malformed_platform_names_the_argument() {
    let out = run(&["--platform", "nonsense", "linux/arm64"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("nonsense"));
}

#[test]
fn no_arguments_is_refused() {
    let out = run(&[]);
    assert!(!out.status.success());
}
