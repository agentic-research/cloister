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
pub const CODE_KEYSTORE_LOCKED: &str = "keystore_locked";
pub const CODE_UNSUPPORTED_ALG: &str = "unsupported_alg";
pub const CODE_PAYLOAD_TOO_LARGE: &str = "payload_too_large";
pub const CODE_RATE_LIMITED: &str = "rate_limited";
pub const CODE_TIMEOUT: &str = "timeout";
pub const CODE_INTERNAL: &str = "internal";
pub const CODE_METHOD_NOT_ALLOWED: &str = "method_not_allowed";

/// Reason string used for the constant-time 404 / 500 collapse. Length must
/// match between the two codes — they MUST be byte-identical bodies. The
/// JSON encoder produces `{"error":"not_found","reason":"keystore entry or internal error"}`
/// (and same with `internal`); the two strings have identical lengths.
///
/// Per ADR-0019 §"Constant-time error shape" + threat-model §9.4.
const CONST_TIME_REASON: &str = "keystore entry or internal error";

#[derive(Debug, Error)]
pub enum HelperError {
    #[error("bad_request: {0}")]
    BadRequest(&'static str),

    #[error("not_found")]
    NotFound,

    #[error("keystore_locked")]
    KeystoreLocked,

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
            HelperError::KeystoreLocked => (
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorBody { error: CODE_KEYSTORE_LOCKED, reason: "unlock keystore" },
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
        }
    }

    /// Stable log label — never includes URL paths, payload bytes, etc.
    /// Per ADR-0019 normative req. 11.
    pub fn log_label(&self) -> &'static str {
        match self {
            HelperError::BadRequest(_) => "bad_request",
            HelperError::NotFound => "not_found",
            HelperError::KeystoreLocked => "keystore_locked",
            HelperError::UnsupportedAlg(_) => "unsupported_alg",
            HelperError::PayloadTooLarge => "payload_too_large",
            HelperError::RateLimited => "rate_limited",
            HelperError::Timeout => "timeout",
            HelperError::Internal => "internal",
            HelperError::MethodNotAllowed => "method_not_allowed",
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
            HelperError::KeystoreLocked,
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
