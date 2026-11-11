#![cfg(feature = "llo-execution")]
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `guest-platform` (cloister-1c4ef5) prints the platform `import-oci` asks
// LLO to select, which is what the CLI picks the lock's rootfs row by.

use std::process::Command;

use leyline_runtime::artifacts::oci::Platform;

#[test]
fn guest_platform_is_the_platform_import_oci_selects() {
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .arg("guest-platform")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        reply,
        serde_json::json!({ "platform": Platform::host().unwrap().to_string() })
    );
}

#[test]
fn guest_platform_takes_no_arguments() {
    let out = Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
        .args(["guest-platform", "extra"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("accepts no arguments"));
}
