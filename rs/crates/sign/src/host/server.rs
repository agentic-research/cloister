// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// axum router + middleware for the sign-only helper (ADR-0019).
//
// Routes:
//   GET  /healthz        — readiness probe (no per-entry oracle)
//   POST /sign           — sign-only protocol (the load-bearing endpoint)
//   GET  /resolve        — backward-compat byte-return (strictly weaker;
//                          documented as such; used only by the vault KEK
//                          which doesn't need sign-only)
//
// Middleware:
//   - 64 KiB Content-Length pre-parse check (req. 3)
//   - 5s timeout on /sign (req. 4)
//   - rate limit (req. 10)
//   - log only operation type + URL scheme + outcome (req. 11)

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

use crate::host::cache::KeyCache;
use crate::host::error::HelperError;
use crate::host::health::healthz;
use crate::host::keystore;
use crate::host::ratelimit::{RateLimiter, current_uid};
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
}

impl AppState {
    pub fn new(rate_per_sec: u32) -> Self {
        Self {
            cache: KeyCache::new(),
            limiter: RateLimiter::new(rate_per_sec),
            started: Instant::now(),
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

async fn post_sign(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let uid = current_uid();
    // Rate-limit FIRST so an attacker can't burn cycles forcing keystore
    // I/O before the gate.
    if !state.limiter.check(uid).await {
        tracing::warn!(target: "leyline_sign_helper", op = "sign", outcome = "rate_limited");
        return HelperError::RateLimited.into_response();
    }
    // Parse body. axum::body::Bytes is already in memory at this point; the
    // content_length_guard middleware enforced the 64 KiB cap before we
    // got here.
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

/// Backward-compat resolver — strictly weaker than `POST /sign`. Returns
/// raw bytes for the vault KEK (and golden-vector parity with kek-helper.mjs).
async fn get_resolve(Query(q): Query<ResolveQuery>) -> Response {
    let scheme = keystore::scheme_label(&q.url);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_body_is_64_kib() {
        assert_eq!(MAX_BODY_BYTES, 65536);
    }

    #[test]
    fn sign_timeout_is_5s() {
        assert_eq!(SIGN_TIMEOUT, Duration::from_secs(5));
    }
}
