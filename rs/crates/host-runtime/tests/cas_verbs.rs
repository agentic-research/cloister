#![cfg(feature = "llo-execution")]
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CAS-volume and registry verbs (cloister-727354, #290 review), tested
// where no hdiutil is needed: an EMPTY state dir is "nothing provisioned", and
// every check here must refuse or report without creating anything. The
// "attached root differs from CLOISTER_CAS_ROOT" refusal needs a real
// attached volume, so it is covered by the live check, not here.

use std::process::Command;

use cloister_host_runtime::execution::registry_failure_message;
use leyline_runtime::artifacts::oci::OciImportError;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_cloister-host-runtime"))
}

fn entries(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn cas_attach_on_an_unprovisioned_state_dir_reports_none_and_creates_nothing() {
    let state = tempfile::tempdir().unwrap();
    let out = bin()
        .args(["cas-attach", "--state-dir", state.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(reply, serde_json::json!({ "provisioned": false }));
    assert!(
        entries(state.path()).is_empty(),
        "attach never creates a volume"
    );
}

#[test]
fn a_run_or_import_with_no_provisioned_volume_is_refused_by_name_before_anything_else() {
    let state = tempfile::tempdir().unwrap();
    let cas = tempfile::tempdir().unwrap();
    let out = bin()
        .args([
            "import-oci",
            "--from-registry",
            "example.invalid/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .env("CLOISTER_CAS_STATE_DIR", state.path())
        .env("CLOISTER_CAS_ROOT", cas.path())
        .output()
        .unwrap();
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("no CAS volume is provisioned under")
            && stderr.contains("cloister runtime install"),
        "{stderr}"
    );
    assert!(entries(state.path()).is_empty());
    assert!(entries(cas.path()).is_empty(), "nothing was pulled");
}

#[test]
fn import_oci_takes_exactly_one_source() {
    for args in [
        vec!["import-oci"],
        vec![
            "import-oci",
            "--layout",
            "/l",
            "--image",
            "sha256:x",
            "--from-registry",
            "a@sha256:x",
        ],
        vec!["import-oci", "--layout", "/l"],
        vec![
            "import-oci",
            "--from-registry",
            "a@sha256:x",
            "--image",
            "sha256:x",
        ],
    ] {
        let out = bin().args(&args).output().unwrap();
        assert!(!out.status.success(), "{args:?} must be refused");
        assert!(
            String::from_utf8_lossy(&out.stderr)
                .contains("usage: cloister-host-runtime import-oci"),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn only_an_authentication_refusal_gets_the_public_images_hint() {
    // LLO's own texts (runtime artifacts/registry.rs at the pinned rev).
    let refused = OciImportError::Registry(
        "GET https://registry-1.docker.io/v2/o/p/manifests/sha256:…: HTTP 401: the registry refused an anonymous pull (credentials are not supported)".into(),
    );
    assert!(registry_failure_message(&refused).contains("only public images can be pulled"));
    let forbidden =
        OciImportError::Registry("GET https://ghcr.io/v2/o/p/blobs/sha256:…: HTTP 403".into());
    assert!(registry_failure_message(&forbidden).contains("only public images can be pulled"));
    for other in [
        OciImportError::Registry("GET https://ghcr.io/v2/o/p/manifests/sha256:…: HTTP 404".into()),
        OciImportError::Registry("GET https://ghcr.io/…: connection refused".into()),
        OciImportError::TooManyRedirects { limit: 5 },
    ] {
        let message = registry_failure_message(&other);
        assert_eq!(message, other.to_string(), "passed through unchanged");
    }
}
