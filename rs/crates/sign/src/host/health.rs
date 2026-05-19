// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// `GET /healthz` handler (ADR-0019 normative req. 12).
//
// MUST emit: ok, supported_schemes, supported_algs, uptime_s, build_sha.
// MUST emit `platform` ONLY when AuthConfig::Disabled (dev shape).
// MUST NOT emit: per-entry presence, request counters, last-error detail.
//
// ── cloister-8d933d sub-piece #3: strip `platform` when auth required ───
//
// Pre-fix /healthz unconditionally emitted `platform = "darwin"|"linux"|...`.
// In production deploys (AuthConfig::Required) this is a free oracle for
// an unauthenticated probe — an attacker chooses targeted scheme probes
// (skip `apple-password://` on Linux, skip `secret-tool://` on macOS)
// based on the platform string. /healthz is loopback-only in k8s/launchd
// probes but a CF Tunnel mistake or a misconfigured ingress would expose it.
//
// Closing playbook step #3 from the bead: "auth-gate /healthz OR strip the
// `platform` field". This commit takes the STRIP path — simpler than
// requiring k8s/launchd probes to carry bearers. The strip is conditional
// on AuthConfig::Required, so dev-mode (no auth) still shows platform for
// local debugging.
//
// 2026-05-13 cycle row 17.11. Per cloister-8d933d.

use std::time::Instant;

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::host::auth::AuthConfig;
use crate::host::keystore::SUPPORTED_SCHEMES;
use crate::host::server::AppState;
use crate::host::sign::SUPPORTED_ALGS;

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    /// Present ONLY when AuthConfig::Disabled (dev-shape). In production
    /// (AuthConfig::Required) this field is omitted from the serialized
    /// response so an unauthenticated probe cannot learn OS family.
    /// Per cloister-8d933d / threat-model §17.11.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<&'static str>,
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
    // Per cloister-8d933d / §17.11: strip the `platform` field for
    // production (auth-required) deploys. The dev-mode (auth-disabled)
    // path keeps it for local debugging — operator opted out of auth.
    let platform = match *state.auth {
        AuthConfig::Disabled    => Some(platform_str()),
        AuthConfig::Required(_) => None,
    };
    Json(HealthResponse {
        ok: true,
        platform,
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
