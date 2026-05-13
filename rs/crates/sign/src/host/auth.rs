// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Bearer-token auth for the sign-only helper. Threat-model §15.2
// (cloister-7afedc): loopback TCP is not UID-scoped on Linux/macOS;
// any local UID or local CSRF reaches /sign without a check at the
// transport layer. We layer bearer-token auth on top.
//
// Wire shape:
//
//   Authorization: Bearer <token>
//
// `<token>` is a deploy-time secret shared between cloister-router
// (or other authorized caller) and the helper. The helper's config
// maps tokens → caller-names; an authenticated request carries its
// caller-name into the rate limiter (so two distinct callers have
// independent budgets — threat-model §15.3 / cloister-7b5b9d).
//
// Token format: opaque bytes, treated as a string. Operators are
// expected to generate via `head -c32 /dev/urandom | base64`. The
// helper does not impose any format other than non-empty.
//
// Token comparison is **constant-time** (subtle::ConstantTimeEq via
// a manual byte-equality loop here — we don't pull subtle for one
// comparison; the loop body sums XOR results into a single u8 the
// optimizer can't short-circuit).

use std::collections::HashMap;

use axum::http::HeaderMap;

use crate::host::error::HelperError;

/// Auth configuration loaded at startup.
#[derive(Clone, Debug)]
pub enum AuthConfig {
    /// No auth configured — every request resolves to ANONYMOUS_CALLER.
    /// Back-compat mode for existing integration tests. Production
    /// deployments MUST set LEYLINE_SIGN_CALLER_TOKENS.
    Disabled,

    /// Auth required: token → caller_name map. Token bytes are stored
    /// as the lookup; the map is consulted by `authenticate()`.
    Required(HashMap<String, String>),
}

impl AuthConfig {
    /// Parse `LEYLINE_SIGN_CALLER_TOKENS` env-style: `caller1=tok1,caller2=tok2`.
    /// Token can be any non-empty string; caller name follows kebab-case
    /// convention but no enforcement.
    ///
    /// Empty / unset input returns `Disabled` — caller (binary) decides
    /// whether to require auth or warn.
    pub fn parse(input: &str) -> Result<AuthConfig, &'static str> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Ok(AuthConfig::Disabled);
        }
        let mut map = HashMap::new();
        for entry in trimmed.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let (caller, token) = entry
                .split_once('=')
                .ok_or("LEYLINE_SIGN_CALLER_TOKENS: entry missing '=' (want caller=token)")?;
            let caller = caller.trim().to_owned();
            let token = token.trim().to_owned();
            if caller.is_empty() {
                return Err("LEYLINE_SIGN_CALLER_TOKENS: empty caller name");
            }
            if token.is_empty() {
                return Err("LEYLINE_SIGN_CALLER_TOKENS: empty token");
            }
            map.insert(token, caller);
        }
        if map.is_empty() {
            Ok(AuthConfig::Disabled)
        } else {
            Ok(AuthConfig::Required(map))
        }
    }

    /// Construct a Required config explicitly. Test helper.
    pub fn required<I>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (String, String)>,
    {
        AuthConfig::Required(pairs.into_iter().map(|(c, t)| (t, c)).collect())
    }
}

/// Resolve the caller's identity from request headers. On success returns
/// the caller_name string; on failure returns HelperError (401).
///
/// In Disabled mode, every request resolves to ANONYMOUS_CALLER (back-compat
/// for existing tests).
pub fn authenticate(
    headers: &HeaderMap,
    config: &AuthConfig,
) -> Result<String, HelperError> {
    match config {
        AuthConfig::Disabled => Ok(crate::host::ratelimit::ANONYMOUS_CALLER.to_owned()),
        AuthConfig::Required(tokens) => {
            let raw = headers
                .get(axum::http::header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok())
                .ok_or(HelperError::Unauthorized)?;
            let presented = raw
                .strip_prefix("Bearer ")
                .ok_or(HelperError::Unauthorized)?
                .trim();
            // Constant-time scan: do not short-circuit on first mismatch;
            // every present-token comparison runs to completion. This is
            // not as strong as subtle::ConstantTimeEq but is good enough
            // for the loopback threat model (the attacker would need a
            // sub-millisecond timing measurement across many probes; we
            // limit reachable bandwidth via the rate limiter).
            let presented_bytes = presented.as_bytes();
            let mut found: Option<&String> = None;
            for (configured_token, caller_name) in tokens {
                if ct_eq(presented_bytes, configured_token.as_bytes()) {
                    found = Some(caller_name);
                }
            }
            found.cloned().ok_or(HelperError::Unauthorized)
        }
    }
}

/// Constant-time byte equality. Returns true iff `a` and `b` have the same
/// length AND the same bytes. The xor-OR accumulator doesn't short-circuit
/// even though the length check does — the length leak is acceptable
/// (token lengths are fixed-per-deployment).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn hdr(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn disabled_resolves_anonymous() {
        let r = authenticate(&HeaderMap::new(), &AuthConfig::Disabled).unwrap();
        assert_eq!(r, "anonymous");
    }

    #[test]
    fn required_with_valid_bearer_token_resolves_caller_name() {
        let cfg = AuthConfig::required([("router".into(), "abc123".into())]);
        let r = authenticate(&hdr("Bearer abc123"), &cfg).unwrap();
        assert_eq!(r, "router");
    }

    #[test]
    fn required_without_authorization_header_returns_unauthorized() {
        let cfg = AuthConfig::required([("router".into(), "abc123".into())]);
        let r = authenticate(&HeaderMap::new(), &cfg);
        assert!(matches!(r, Err(HelperError::Unauthorized)));
    }

    #[test]
    fn required_with_wrong_token_returns_unauthorized() {
        let cfg = AuthConfig::required([("router".into(), "abc123".into())]);
        let r = authenticate(&hdr("Bearer wrong-token"), &cfg);
        assert!(matches!(r, Err(HelperError::Unauthorized)));
    }

    #[test]
    fn required_with_missing_bearer_prefix_returns_unauthorized() {
        let cfg = AuthConfig::required([("router".into(), "abc123".into())]);
        let r = authenticate(&hdr("abc123"), &cfg);
        assert!(matches!(r, Err(HelperError::Unauthorized)));
    }

    #[test]
    fn distinct_callers_map_to_distinct_names() {
        let cfg = AuthConfig::required([
            ("router".into(), "tok-a".into()),
            ("notme-bundle".into(), "tok-b".into()),
        ]);
        assert_eq!(authenticate(&hdr("Bearer tok-a"), &cfg).unwrap(), "router");
        assert_eq!(authenticate(&hdr("Bearer tok-b"), &cfg).unwrap(), "notme-bundle");
    }

    #[test]
    fn parse_empty_returns_disabled() {
        assert!(matches!(AuthConfig::parse("").unwrap(), AuthConfig::Disabled));
        assert!(matches!(AuthConfig::parse("   ").unwrap(), AuthConfig::Disabled));
    }

    #[test]
    fn parse_valid_pairs() {
        let cfg = AuthConfig::parse("router=tok-a,notme=tok-b").unwrap();
        match cfg {
            AuthConfig::Required(m) => {
                assert_eq!(m.get("tok-a").map(String::as_str), Some("router"));
                assert_eq!(m.get("tok-b").map(String::as_str), Some("notme"));
            }
            _ => panic!("expected Required"),
        }
    }

    #[test]
    fn parse_rejects_malformed() {
        assert!(AuthConfig::parse("nokey").is_err());
        assert!(AuthConfig::parse("=novalue").is_err());
        assert!(AuthConfig::parse("nokey=").is_err());
    }

    #[test]
    fn ct_eq_correctness() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(ct_eq(b"", b""));
    }
}
