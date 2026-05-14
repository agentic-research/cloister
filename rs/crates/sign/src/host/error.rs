// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Sign-only helper error taxonomy (ADR-0019 §"Wire protocol" failure
// codes + §"Constant-time error shape").
//
// HelperError → HTTP code mapping is the single source of truth for the
// error wire format. The mapping is deliberately tight — every code that
// goes out the wire is enumerated here, and there is a `to_response_body`
// path that produces byte-identical 404 + 500 bodies (ADR-0019
// §"Constant-time error shape").

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use thiserror::Error;

/// Wire-shape error codes per ADR-0019 §"Wire protocol".
///
/// These string codes are stable — change them and you have a wire-format
/// change that needs an ADR amendment.
pub const CODE_BAD_REQUEST: &str = "bad_request";
pub const CODE_NOT_FOUND: &str = "not_found";
// CODE_KEYSTORE_LOCKED was retired 2026-05-13 — `HelperError::KeystoreLocked`
// removed when all keystore-side failures were collapsed to the §17.10
// constant-time NotFound. The string "keystore_locked" still appears as
// a structured-log outcome label in `host::keystore` (operator-side
// signal, not wire), but no longer maps to a wire-level error code.
pub const CODE_UNSUPPORTED_ALG: &str = "unsupported_alg";
pub const CODE_PAYLOAD_TOO_LARGE: &str = "payload_too_large";
pub const CODE_RATE_LIMITED: &str = "rate_limited";
pub const CODE_TIMEOUT: &str = "timeout";
pub const CODE_INTERNAL: &str = "internal";
pub const CODE_METHOD_NOT_ALLOWED: &str = "method_not_allowed";
pub const CODE_UNAUTHORIZED: &str = "unauthorized";
pub const CODE_FORBIDDEN: &str = "forbidden";
pub const CODE_UNSUPPORTED_MEDIA_TYPE: &str = "unsupported_media_type";

/// Reason string used for the constant-time 404 / 500 collapse. Length must
/// match between the two codes — they MUST be byte-identical bodies. The
/// JSON encoder produces `{"error":"not_found","reason":"keystore entry or internal error"}`
/// (and same with `internal`); the two strings have identical lengths.
///
/// Per ADR-0019 §"Constant-time error shape" + threat-model §9.4.
const CONST_TIME_REASON: &str = "keystore entry or internal error";

// Clone derived so the resolve-time singleflight in `host::keystore` can
// fan out one keystore call's result to N concurrent callers. All
// variants carry either no data or `&'static str` — Clone is trivial.
#[derive(Debug, Error, Clone)]
pub enum HelperError {
    #[error("bad_request: {0}")]
    BadRequest(&'static str),

    #[error("not_found")]
    NotFound,

    // `KeystoreLocked` variant retired 2026-05-13 (skeptic-friend
    // d95f0d/da4a07): all keystore-side failures collapse to NotFound
    // for the §17.10 constant-time wire shape. A future developer
    // adding a new keystore backend MUST NOT re-introduce a distinct
    // 503 variant for "credential exists but unreachable" — that
    // re-opens the §17.10 enumeration oracle. Use NotFound + a
    // structured tracing log to signal the locked-state to operators.

    #[error("unsupported_alg: {0}")]
    UnsupportedAlg(&'static str),

    #[error("payload_too_large")]
    PayloadTooLarge,

    #[error("rate_limited")]
    RateLimited,

    #[error("timeout")]
    Timeout,

    #[error("internal")]
    Internal,

    #[error("method_not_allowed")]
    MethodNotAllowed,

    /// 401 — request lacked a valid Authorization: Bearer token. Threat-model
    /// §15.2 (cloister-7afedc): auth is required when LEYLINE_SIGN_CALLER_TOKENS
    /// is set; the helper rejects every request that doesn't authenticate.
    #[error("unauthorized")]
    Unauthorized,

    /// 403 — request was authenticated but the requested URL is not on
    /// /resolve's allow-list. Threat-model §15.1 (cloister-7aaab1): /resolve
    /// must not address signing-key URLs.
    #[error("forbidden")]
    Forbidden,

    /// 415 — Content-Type was not application/json. Threat-model §15.5
    /// (cloister-7c2179): forces CORS preflight on cross-origin fetch and
    /// blocks the text/plain CSRF simple-POST shape.
    #[error("unsupported_media_type")]
    UnsupportedMediaType,
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub error: &'static str,
    pub reason: &'static str,
}

impl HelperError {
    /// The (status, JSON body) tuple for the wire. NotFound + Internal
    /// share their JSON body byte-for-byte to satisfy the constant-time
    /// 404/500 shape (ADR-0019 §"Constant-time error shape").
    pub fn into_response_parts(self) -> (StatusCode, ErrorBody) {
        match self {
            HelperError::BadRequest(reason) => (
                StatusCode::BAD_REQUEST,
                ErrorBody { error: CODE_BAD_REQUEST, reason },
            ),
            HelperError::NotFound => (
                StatusCode::NOT_FOUND,
                ErrorBody { error: CODE_NOT_FOUND, reason: CONST_TIME_REASON },
            ),
            HelperError::UnsupportedAlg(reason) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                ErrorBody { error: CODE_UNSUPPORTED_ALG, reason },
            ),
            HelperError::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                ErrorBody { error: CODE_PAYLOAD_TOO_LARGE, reason: "exceeds 64 KiB" },
            ),
            HelperError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                ErrorBody { error: CODE_RATE_LIMITED, reason: "1000 sigs/sec/uid" },
            ),
            HelperError::Timeout => (
                StatusCode::GATEWAY_TIMEOUT,
                ErrorBody { error: CODE_TIMEOUT, reason: "exceeded 5s" },
            ),
            // For Internal, we deliberately mirror NotFound's body — same
            // `error` field would distinguish them, but the constant-time
            // requirement is for byte-identical length+content. Map both
            // to a shared label.
            HelperError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ErrorBody { error: CODE_NOT_FOUND, reason: CONST_TIME_REASON },
            ),
            HelperError::MethodNotAllowed => (
                StatusCode::METHOD_NOT_ALLOWED,
                ErrorBody { error: CODE_METHOD_NOT_ALLOWED, reason: "use POST /sign or GET" },
            ),
            HelperError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                ErrorBody { error: CODE_UNAUTHORIZED, reason: "Authorization: Bearer required" },
            ),
            HelperError::Forbidden => (
                StatusCode::FORBIDDEN,
                // Neutral reason — same string for /resolve and /sign
                // gates so the wire doesn't distinguish which gate fired
                // (oracle-friend discipline). Distinct outcome labels in
                // tracing carry the operator-side signal.
                ErrorBody { error: CODE_FORBIDDEN, reason: "URL not on allow-list" },
            ),
            HelperError::UnsupportedMediaType => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                ErrorBody { error: CODE_UNSUPPORTED_MEDIA_TYPE, reason: "Content-Type must be application/json" },
            ),
        }
    }

    /// Stable log label — never includes URL paths, payload bytes, etc.
    /// Per ADR-0019 normative req. 11.
    pub fn log_label(&self) -> &'static str {
        match self {
            HelperError::BadRequest(_) => "bad_request",
            HelperError::NotFound => "not_found",
            HelperError::UnsupportedAlg(_) => "unsupported_alg",
            HelperError::PayloadTooLarge => "payload_too_large",
            HelperError::RateLimited => "rate_limited",
            HelperError::Timeout => "timeout",
            HelperError::Internal => "internal",
            HelperError::MethodNotAllowed => "method_not_allowed",
            HelperError::Unauthorized => "unauthorized",
            HelperError::Forbidden => "forbidden",
            HelperError::UnsupportedMediaType => "unsupported_media_type",
        }
    }
}

impl IntoResponse for HelperError {
    fn into_response(self) -> Response {
        let (status, body) = self.into_response_parts();
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0019 §"Constant-time error shape": 404 and 500 bodies MUST be
    /// byte-identical.
    #[test]
    fn const_time_404_and_500_byte_identical() {
        let (_s_a, body_a) = HelperError::NotFound.into_response_parts();
        let (_s_b, body_b) = HelperError::Internal.into_response_parts();
        let a = serde_json::to_string(&body_a).unwrap();
        let b = serde_json::to_string(&body_b).unwrap();
        assert_eq!(a, b, "404 and 500 bodies must be byte-identical");
        assert_eq!(a.len(), b.len());
    }

    #[test]
    fn log_label_never_includes_secrets() {
        // log_label() returns &'static str — by construction it cannot
        // include any caller-provided URL or payload bytes. This test
        // exists for the discoverability of the invariant.
        for err in [
            HelperError::BadRequest("malformed"),
            HelperError::NotFound,
            HelperError::UnsupportedAlg("wrong length"),
            HelperError::PayloadTooLarge,
            HelperError::RateLimited,
            HelperError::Timeout,
            HelperError::Internal,
            HelperError::MethodNotAllowed,
        ] {
            let label = err.log_label();
            // No path separator, no scheme separator, no base64 chars.
            assert!(!label.contains("/"));
            assert!(!label.contains("://"));
            assert!(!label.contains("="));
        }
    }
}
