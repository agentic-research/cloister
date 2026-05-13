// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// axum router + middleware for the sign-only helper (ADR-0019).
//
// Routes:
//   GET  /healthz        — readiness probe (no per-entry oracle)
//   POST /sign           — sign-only protocol (the load-bearing endpoint)
//   GET  /resolve        — KEK-byte resolver, GATED behind a deploy-time
//                          allow-list (threat-model §15.1 / cloister-7aaab1).
//                          Default deny-all.
//
// Middleware:
//   - tower_http RequestBodyLimitLayer (64 KiB, no-CL safe) — req. 3 +
//     threat-model §15.6 / cloister-7c737a
//   - 64 KiB Content-Length pre-parse check — fast-path 413 with CL
//     (composes with the layer above for missing-CL case)
//   - 5s timeout on /sign — req. 4
//   - bearer-token auth (threat-model §15.2 / cloister-7afedc)
//   - rate limit per AUTHENTICATED CALLER — req. 10 + threat-model
//     §15.3 / cloister-7b5b9d
//   - strict Content-Type: application/json on /sign — threat-model
//     §15.5 / cloister-7c2179
//   - log only operation type + URL scheme + outcome — req. 11

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Router, middleware};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use tower_http::limit::RequestBodyLimitLayer;

use crate::host::auth::{AuthConfig, authenticate};
use crate::host::cache::KeyCache;
use crate::host::error::HelperError;
use crate::host::health::healthz;
use crate::host::keystore;
use crate::host::ratelimit::RateLimiter;
use crate::host::sign;

/// Maximum `POST /sign` body in bytes — ADR-0019 normative req. 3.
pub const MAX_BODY_BYTES: u64 = 64 * 1024;
/// `POST /sign` timeout — ADR-0019 normative req. 4.
pub const SIGN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct AppState {
    pub cache: KeyCache,
    pub limiter: RateLimiter,
    pub started: Instant,
    pub auth: Arc<AuthConfig>,
    /// URL prefixes the operator has explicitly authorized `/resolve` to
    /// hand bytes back for. Default empty = deny all (threat-model §15.1).
    /// Production deploys set this via LEYLINE_SIGN_RESOLVE_ALLOW env.
    pub resolve_allow: Arc<Vec<String>>,
}

impl AppState {
    /// Construct AppState with auth disabled and /resolve closed. The
    /// historical signature — preserved for back-compat with existing
    /// integration tests that pass `AppState::new(rate)` and expect
    /// unauthenticated /sign to succeed.
    ///
    /// Production deployments MUST use `with_config`.
    pub fn new(rate_per_sec: u32) -> Self {
        Self {
            cache: KeyCache::new(),
            limiter: RateLimiter::new(rate_per_sec),
            started: Instant::now(),
            auth: Arc::new(AuthConfig::Disabled),
            resolve_allow: Arc::new(Vec::new()),
        }
    }

    /// Production-shape constructor. Auth + /resolve allow-list explicit.
    pub fn with_config(
        rate_per_sec: u32,
        auth: AuthConfig,
        resolve_allow: Vec<String>,
    ) -> Self {
        Self {
            cache: KeyCache::new(),
            limiter: RateLimiter::new(rate_per_sec),
            started: Instant::now(),
            auth: Arc::new(auth),
            resolve_allow: Arc::new(resolve_allow),
        }
    }
}

/// Build the axum Router with state baked in. Splits out from the bin
/// for integration testability.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/sign", post(post_sign))
        .route("/resolve", get(get_resolve))
        .fallback(fallback)
        // Order matters: each .layer() call wraps OUTWARDS, so the LAST
        // .layer() call is the outermost (runs FIRST on inbound). We want:
        //
        //   inbound → content_length_guard (spec'd 413 JSON body)
        //          → RequestBodyLimitLayer (fallback: catches no-CL bodies)
        //          → route handler
        //
        // The Content-Length-present path produces the spec'd
        // `{"error":"payload_too_large", ...}` body. The no-CL path falls
        // through content_length_guard (since CL is absent) and hits
        // RequestBodyLimitLayer, which returns a bare 413 — acceptable
        // for the threat-model §15.6 close because the body is rejected
        // before parsing, regardless of Content-Length.
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES as usize))
        .layer(middleware::from_fn(content_length_guard))
        .with_state(state)
}

async fn fallback() -> impl IntoResponse {
    HelperError::NotFound
}

// ── POST /sign ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SignRequest {
    pub url: String,
    pub alg: String,
    pub payload_b64: String,
    #[serde(default)]
    pub return_pubkey: bool,
}

#[derive(Serialize)]
pub struct SignResponseBody {
    pub signature_b64: String,
    pub kid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pubkey_b64: Option<String>,
}

async fn post_sign(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    // Threat-model §15.2: authenticate FIRST. Bearer token → caller_name.
    let caller = match authenticate(&headers, &state.auth) {
        Ok(name) => name,
        Err(e) => {
            tracing::warn!(target: "leyline_sign_helper", op = "sign", outcome = e.log_label());
            return e.into_response();
        }
    };
    // Threat-model §15.5: strict Content-Type: application/json. text/plain
    // is CORS-safelisted → no preflight → CSRF simple-POST signs attacker
    // payloads. Require strict media type so cross-origin fetch can't reach
    // here without a preflight check.
    if !content_type_is_json(&headers) {
        tracing::info!(target: "leyline_sign_helper", op = "sign", outcome = "unsupported_media_type");
        return HelperError::UnsupportedMediaType.into_response();
    }
    // Threat-model §15.3: rate-limit keyed on AUTHENTICATED caller_name,
    // not the helper's own getuid(). Two distinct callers → two distinct
    // buckets → noisy-neighbor isolation.
    if !state.limiter.check(&caller).await {
        tracing::warn!(
            target: "leyline_sign_helper",
            op = "sign",
            caller = %caller,
            outcome = "rate_limited",
        );
        return HelperError::RateLimited.into_response();
    }
    // Parse body. axum::body::Bytes is already in memory at this point; the
    // RequestBodyLimitLayer + content_length_guard enforced the 64 KiB cap
    // before we got here.
    let req: SignRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => {
            tracing::info!(target: "leyline_sign_helper", op = "sign", outcome = "bad_request");
            return HelperError::BadRequest("malformed JSON body").into_response();
        }
    };
    let scheme = keystore::scheme_label(&req.url);
    let payload = match Base64UrlUnpadded::decode_vec(&req.payload_b64) {
        Ok(p) => p,
        Err(_) => {
            tracing::info!(
                target: "leyline_sign_helper",
                op = "sign",
                scheme = scheme,
                outcome = "bad_request",
            );
            return HelperError::BadRequest("payload_b64 not base64url").into_response();
        }
    };
    let payload_len = payload.len();
    // 5-second timeout per req. 4.
    let result = tokio::time::timeout(
        SIGN_TIMEOUT,
        sign::sign(&state.cache, &req.url, &req.alg, &payload, req.return_pubkey),
    )
    .await;
    match result {
        Err(_elapsed) => {
            tracing::warn!(
                target: "leyline_sign_helper",
                op = "sign",
                scheme = scheme,
                payload_len = payload_len,
                outcome = "timeout",
            );
            HelperError::Timeout.into_response()
        }
        Ok(Err(e)) => {
            tracing::info!(
                target: "leyline_sign_helper",
                op = "sign",
                scheme = scheme,
                payload_len = payload_len,
                outcome = e.log_label(),
            );
            e.into_response()
        }
        Ok(Ok(sr)) => {
            tracing::info!(
                target: "leyline_sign_helper",
                op = "sign",
                scheme = scheme,
                payload_len = payload_len,
                outcome = "ok",
            );
            let body = SignResponseBody {
                signature_b64: sr.signature_b64,
                kid: sr.kid,
                pubkey_b64: sr.pubkey_b64,
            };
            (StatusCode::OK, Json(body)).into_response()
        }
    }
}

// ── GET /resolve (backward-compat) ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct ResolveQuery {
    pub url: String,
}

/// KEK-byte resolver — gated behind a deploy-time allow-list. Threat-model
/// §15.1 (cloister-7aaab1): without the allow-list this endpoint would
/// return raw bytes for ANY URL, including signing-key URLs (master_sk).
/// Default deny-all; production deploys set
/// `LEYLINE_SIGN_RESOLVE_ALLOW=<comma-separated-prefixes>` to authorize
/// vault-KEK URLs and nothing else.
async fn get_resolve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ResolveQuery>,
) -> Response {
    let scheme = keystore::scheme_label(&q.url);
    // Threat-model §15.2: authenticate /resolve too. Defense in depth —
    // even if the allow-list contains a URL the operator intends as
    // "low-sensitivity," any leak is local-net-reachable today.
    let caller = match authenticate(&headers, &state.auth) {
        Ok(name) => name,
        Err(e) => {
            tracing::warn!(target: "leyline_sign_helper", op = "resolve", scheme = scheme, outcome = e.log_label());
            return e.into_response();
        }
    };
    // Threat-model §15.1: check allow-list BEFORE touching keystore. Empty
    // allow-list = deny-all. Match by URL prefix (operator declares which
    // URL families /resolve may emit).
    let allowed = state.resolve_allow.iter().any(|prefix| q.url.starts_with(prefix.as_str()));
    if !allowed {
        tracing::warn!(
            target: "leyline_sign_helper",
            op = "resolve",
            scheme = scheme,
            caller = %caller,
            outcome = "forbidden",
        );
        return HelperError::Forbidden.into_response();
    }
    // Per-caller rate-limit applies to /resolve too.
    if !state.limiter.check(&caller).await {
        tracing::warn!(
            target: "leyline_sign_helper",
            op = "resolve",
            scheme = scheme,
            caller = %caller,
            outcome = "rate_limited",
        );
        return HelperError::RateLimited.into_response();
    }
    match keystore::resolve_bytes(&q.url) {
        Ok(bytes) => {
            tracing::info!(
                target: "leyline_sign_helper",
                op = "resolve",
                scheme = scheme,
                outcome = "ok",
            );
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
                bytes,
            )
                .into_response()
        }
        Err(e) => {
            tracing::info!(
                target: "leyline_sign_helper",
                op = "resolve",
                scheme = scheme,
                outcome = e.log_label(),
            );
            e.into_response()
        }
    }
}

// ── Middleware: Content-Length guard ───────────────────────────────────────

/// Reject `POST /sign` bodies > MAX_BODY_BYTES based on Content-Length
/// BEFORE parsing the body (ADR-0019 normative req. 3).
async fn content_length_guard(
    headers: HeaderMap,
    req: axum::http::Request<Body>,
    next: middleware::Next,
) -> Response {
    if req.method() == axum::http::Method::POST && req.uri().path() == "/sign" {
        if let Some(cl) = headers
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
        {
            if cl > MAX_BODY_BYTES {
                tracing::warn!(
                    target: "leyline_sign_helper",
                    op = "sign",
                    outcome = "payload_too_large",
                );
                return HelperError::PayloadTooLarge.into_response();
            }
        }
        // No Content-Length → still let it through; axum's body reader
        // will enforce chunk-by-chunk. We additionally rely on the
        // tower-http RequestBodyLimitLayer in real deployment if/when
        // we add it. For now, the loopback-only bind plus per-uid rate
        // limit bounds the worst case.
    }
    next.run(req).await
}

/// Strict Content-Type check: must be exactly `application/json` (with
/// optional `; charset=...` suffix). Threat-model §15.5 — text/plain is
/// CORS-safelisted; rejecting it forces preflight on cross-origin fetch.
fn content_type_is_json(headers: &HeaderMap) -> bool {
    let Some(ct) = headers.get(axum::http::header::CONTENT_TYPE) else {
        return false;
    };
    let Ok(s) = ct.to_str() else {
        return false;
    };
    // Split on ';' to allow `application/json; charset=utf-8`. Compare the
    // media-type portion (lowercased + trimmed) against the constant.
    let media = s.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    media == "application/json"
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn max_body_is_64_kib() {
        assert_eq!(MAX_BODY_BYTES, 65536);
    }

    #[test]
    fn sign_timeout_is_5s() {
        assert_eq!(SIGN_TIMEOUT, Duration::from_secs(5));
    }

    #[test]
    fn content_type_is_json_accepts_canonical() {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        assert!(content_type_is_json(&h));
    }

    #[test]
    fn content_type_is_json_accepts_with_charset() {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        assert!(content_type_is_json(&h));
    }

    #[test]
    fn content_type_is_json_rejects_text_plain() {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain;charset=UTF-8"),
        );
        assert!(!content_type_is_json(&h));
    }

    #[test]
    fn content_type_is_json_rejects_missing() {
        assert!(!content_type_is_json(&HeaderMap::new()));
    }
}
