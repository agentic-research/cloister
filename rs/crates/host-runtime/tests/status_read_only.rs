use std::fs;

use cloister_host_runtime::krunvm::{KrunvmBackend, KrunvmSettings, SystemCommandRunner};

fn backend(storage: &std::path::Path) -> KrunvmBackend<SystemCommandRunner> {
    KrunvmBackend::new(
        SystemCommandRunner,
        KrunvmSettings {
            storage_volume: storage.into(),
            reserve_bytes: Some(0),
            ..KrunvmSettings::default()
        },
    )
}

#[test]
fn missing_storage_is_reported_without_creating_any_path() {
    let root = tempfile::tempdir().unwrap();
    let storage = root.path().join("missing/nested/storage");

    let status = serde_json::to_value(backend(&storage).status().unwrap()).unwrap();

    assert_eq!(status["schema"], "cloister/runtime-storage-status/v1");
    assert_eq!(status["provider"], "compatibility");
    assert_eq!(status["maturity"], "experimental");
    assert_eq!(status["backend"], "krunvmCompatibility");
    assert_eq!(status["state"], "notPrepared");
    assert!(status["capacity"].is_null());
    assert_eq!(status["trackedRuns"], 0);
    assert_eq!(status["runningRuns"], 0);
    assert!(!storage.exists(), "status created {}", storage.display());
}

#[test]
fn existing_empty_storage_reports_capacity_without_creating_state() {
    let storage = tempfile::tempdir().unwrap();

    let status = serde_json::to_value(backend(storage.path()).status().unwrap()).unwrap();

    assert_eq!(status["state"], "prepared");
    assert!(status["capacity"].is_object());
    assert_eq!(status["trackedRuns"], 0);
    assert_eq!(status["runningRuns"], 0);
    assert!(!storage.path().join("cloister-runtime.lock").exists());
    assert!(!storage.path().join("cloister-runtime.json").exists());
}

#[test]
fn existing_state_is_observed_without_changing_bytes_or_metadata() {
    let storage = tempfile::tempdir().unwrap();
    let state_path = storage.path().join("cloister-runtime.json");
    let state = serde_json::json!({
        "schema": "cloister/krunvm-state/v1",
        "vms": {
            "finished": {
                "bundle": "mache",
                "restriction": "one",
                "artifact_index_digest": "sha256:index-one",
                "platform_digest": "sha256:platform-one",
                "active": true,
                "running": false,
                "last_used": 1
            },
            "running": {
                "bundle": "llo",
                "restriction": "two",
                "artifact_index_digest": "sha256:index-two",
                "platform_digest": "sha256:platform-two",
                "active": true,
                "running": true,
                "last_used": 2
            }
        }
    });
    fs::write(&state_path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
    let before_bytes = fs::read(&state_path).unwrap();
    let before_metadata = fs::metadata(&state_path).unwrap();

    let status = serde_json::to_value(backend(storage.path()).status().unwrap()).unwrap();

    let after_metadata = fs::metadata(&state_path).unwrap();
    assert_eq!(status["state"], "prepared");
    assert_eq!(status["trackedRuns"], 2);
    assert_eq!(status["runningRuns"], 1);
    assert_eq!(fs::read(&state_path).unwrap(), before_bytes);
    assert_eq!(after_metadata.len(), before_metadata.len());
    assert_eq!(
        after_metadata.modified().unwrap(),
        before_metadata.modified().unwrap()
    );
    assert!(!storage.path().join("cloister-runtime.lock").exists());
}
