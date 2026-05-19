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
// ── cloister-8d933d sub-piece #2: CLI-presence section ──────────────────
//
// Operators wiring `op://` or `apple-password://` schemes pin absolute
// paths to the `op` / `security` binaries via LEYLINE_SIGN_OP_BIN and
// LEYLINE_SIGN_SECURITY_BIN. When those bindings are missing or the
// pinned path doesn't exist, the scheme silently 404s — operators
// historically discovered this by trial-and-error. /healthz now exposes
// the two presence flags in dev-mode (Disabled) so an operator can curl
// the helper and see "oh, op is pinned but security isn't" without
// needing to trigger a real signing call.
//
// Same strip-under-Required posture as `platform`: presence flags leak
// platform information indirectly (security_cli_present=true ≈ macOS),
// so they're omitted under production auth posture. Operators on
// production deploys already have access to the pinned bindings; the
// /healthz field is for cold-start debugging, not steady-state.
//
// ── cloister-8d933d sub-piece #1: `?deep=1` synthetic probe ─────────────
//
// Today /healthz reports ok=true if the Worker boots, regardless of
// whether the keystore is actually wired correctly. That's the silence
// Gap 4 from the 2026-05-13 adversarial cycle — liveness coupled to
// readiness gives k8s/launchd probes a false-positive on a poisoned or
// misconfigured keystore.
//
// `?deep=1` triggers a synthetic probe through the keystore using the
// URL pinned by `LEYLINE_SIGN_HEALTHZ_PROBE_URL`. The handler routes
// through the same resolve_bytes path /resolve uses (with its
// singleflight + TTL cache), so the probe doesn't amplify load and
// inherits all the resolve-path mitigations. Three outcomes:
//
//   - URL unset:     deep_probe.status = "unconfigured", ok = true
//                    (operator chose not to wire deep mode; not a failure)
//   - URL resolves:  deep_probe.status = "ok",          ok = true
//   - URL fails:     deep_probe.status = "error",       ok = false
//                    deep_probe.error  = HelperError::log_label() (coarse,
//                    no URL leakage)
//
// Per ADR-0019 normative req. 11 the error label is the same coarse
// `&'static str` /resolve returns, so the deep-probe surface inherits
// the same "log labels never include secrets" invariant. The probe URL
// itself is NEVER included in the response or logged.
//
// 2026-05-13 cycle row 17.11. Per cloister-8d933d.

use std::time::Instant;

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use crate::host::auth::AuthConfig;
use crate::host::keystore::{SUPPORTED_SCHEMES, cli_pinned_present, resolve_bytes};
use crate::host::server::AppState;
use crate::host::sign::SUPPORTED_ALGS;

/// Env var naming the URL the `?deep=1` probe resolves through. When
/// unset (or empty), `?deep=1` returns `status: "unconfigured"`. Per
/// cloister-8d933d sub-piece #1.
const PROBE_URL_ENV: &str = "LEYLINE_SIGN_HEALTHZ_PROBE_URL";

#[derive(Deserialize, Default)]
pub struct HealthzQuery {
    /// `?deep=1` flips deep-probe mode on. Any other value (or absent)
    /// keeps the shallow shape — same as pre-sub-piece-#1 behavior.
    /// `u8` chosen over `bool` because URL query parsers vary on how
    /// they handle `?deep` (no value); `?deep=1` is the unambiguous
    /// shape.
    pub deep: Option<u8>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct DeepProbeReport {
    /// `"ok"` | `"unconfigured"` | `"error"`. Stable strings — operator
    /// probe scripts can match on these.
    pub status: &'static str,
    /// Coarse failure label (`HelperError::log_label()`) when status
    /// is `"error"`. Never includes the probe URL or any secret-shaped
    /// detail per ADR-0019 normative req. 11.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    /// Present ONLY when AuthConfig::Disabled (dev-shape). In production
    /// (AuthConfig::Required) this field is omitted from the serialized
    /// response so an unauthenticated probe cannot learn OS family.
    /// Per cloister-8d933d / threat-model §17.11.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<&'static str>,
    /// `true` if LEYLINE_SIGN_OP_BIN is set, absolute, and points at an
    /// extant file (i.e. `op://` schemes would actually invoke).
    /// Present ONLY in dev-mode (AuthConfig::Disabled). Stripped under
    /// production auth posture — see module header.
    /// Per cloister-8d933d sub-piece #2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op_cli_present: Option<bool>,
    /// `true` if LEYLINE_SIGN_SECURITY_BIN is set, absolute, and points
    /// at an extant file (i.e. `apple-password://` schemes would
    /// actually invoke). Present ONLY in dev-mode (AuthConfig::Disabled).
    /// Stripped under production auth posture — see module header.
    /// Per cloister-8d933d sub-piece #2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security_cli_present: Option<bool>,
    pub supported_schemes: Vec<&'static str>,
    pub supported_algs: Vec<&'static str>,
    pub uptime_s: u64,
    pub build_sha: &'static str,
    /// Set when `?deep=1` is passed. Omitted otherwise to keep the
    /// shallow shape byte-identical to pre-sub-piece-#1 callers.
    /// Per cloister-8d933d sub-piece #1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep_probe: Option<DeepProbeReport>,
}

/// `build_sha` source — set at compile time via env var
/// `LEYLINE_SIGN_BUILD_SHA`. Falls back to "unknown" so unit tests don't
/// need the build script.
pub const BUILD_SHA: &str = match option_env!("LEYLINE_SIGN_BUILD_SHA") {
    Some(s) => s,
    None => "unknown",
};

pub async fn healthz(
    State(state): State<AppState>,
    Query(q): Query<HealthzQuery>,
) -> Json<HealthResponse> {
    // Per cloister-8d933d / §17.11: strip identifying fields for
    // production (auth-required) deploys. The dev-mode (auth-disabled)
    // path keeps them for local debugging — operator opted out of auth.
    let (platform, op_cli_present, security_cli_present) = match *state.auth {
        AuthConfig::Disabled => (
            Some(platform_str()),
            Some(cli_pinned_present("LEYLINE_SIGN_OP_BIN")),
            Some(cli_pinned_present("LEYLINE_SIGN_SECURITY_BIN")),
        ),
        AuthConfig::Required(_) => (None, None, None),
    };
    let (ok, deep_probe) = run_deep_probe_if_requested(&q).await;
    Json(HealthResponse {
        ok,
        platform,
        op_cli_present,
        security_cli_present,
        supported_schemes: SUPPORTED_SCHEMES.to_vec(),
        supported_algs: SUPPORTED_ALGS.to_vec(),
        uptime_s: uptime_s(state.started),
        build_sha: BUILD_SHA,
        deep_probe,
    })
}

/// Returns `(ok, deep_probe)` per the sub-piece-#1 contract above.
/// When `?deep=1` isn't set, `(true, None)` — same as the
/// pre-sub-piece-#1 shape.
async fn run_deep_probe_if_requested(q: &HealthzQuery) -> (bool, Option<DeepProbeReport>) {
    if q.deep != Some(1) {
        return (true, None);
    }
    let probe_url = std::env::var(PROBE_URL_ENV).ok().filter(|s| !s.is_empty());
    let Some(url) = probe_url else {
        return (true, Some(DeepProbeReport { status: "unconfigured", error: None }));
    };
    match resolve_bytes(&url).await {
        Ok(_) => (true, Some(DeepProbeReport { status: "ok", error: None })),
        Err(e) => {
            let err_label = e.log_label();
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "healthz_deep_probe",
                outcome = err_label,
            );
            (false, Some(DeepProbeReport { status: "error", error: Some(err_label) }))
        }
    }
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
