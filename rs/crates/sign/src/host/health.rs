// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// `GET /healthz` handler (ADR-0019 normative req. 12).
//
// MUST emit: ok, platform, supported_schemes, supported_algs, uptime_s,
//            build_sha.
// MUST NOT emit: per-entry presence, request counters, last-error detail.

use std::time::Instant;

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::host::keystore::SUPPORTED_SCHEMES;
use crate::host::server::AppState;
use crate::host::sign::SUPPORTED_ALGS;

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub platform: &'static str,
    pub supported_schemes: Vec<&'static str>,
    pub supported_algs: Vec<&'static str>,
    pub uptime_s: u64,
    pub build_sha: &'static str,
}

/// `build_sha` source — set at compile time via env var
/// `LEYLINE_SIGN_BUILD_SHA`. Falls back to "unknown" so unit tests don't
/// need the build script.
pub const BUILD_SHA: &str = match option_env!("LEYLINE_SIGN_BUILD_SHA") {
    Some(s) => s,
    None => "unknown",
};

pub async fn healthz(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        platform: platform_str(),
        supported_schemes: SUPPORTED_SCHEMES.to_vec(),
        supported_algs: SUPPORTED_ALGS.to_vec(),
        uptime_s: uptime_s(state.started),
        build_sha: BUILD_SHA,
    })
}

fn platform_str() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
}

fn uptime_s(started: Instant) -> u64 {
    Instant::now().saturating_duration_since(started).as_secs()
}
